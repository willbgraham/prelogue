#!/bin/bash
# Point Prelogue's email at a provider — one command, proven before and after.
#
# Email leaves the product through TWO doors, and a provider change has to move
# both or something stays dark:
#   1. Supabase Auth SMTP    → sign-in codes (signup + login)
#   2. Edge-function secrets → export emails, notifications, invites, nudges,
#                              the contact form, canary alerts
#
#   bash ops/set-email-provider.sh            where both doors point right now
#   bash ops/set-email-provider.sh gmail      door 1 through Google Workspace:
#                                             the bridge while a provider is
#                                             still reviewing the account, and
#                                             the fallback if one suspends it
#   bash ops/set-email-provider.sh postmark   both doors through Postmark
#   bash ops/set-email-provider.sh resend     both doors through Resend
#
# Secrets are typed at a hidden prompt — never echoed, never in shell history —
# and each is proven against its provider before anything is changed. Door 1
# only moves to a provider once that provider has delivered to an address
# outside our own domain: a new account can pass every other check while
# refusing all real recipients.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env.supabase.local}"
WEB_ENV="${WEB_ENV:-apps/web/.env.local}"
MGMT_API="${MGMT_API:-https://api.supabase.com}"
POSTMARK_API="${POSTMARK_API:-https://api.postmarkapp.com}"
RESEND_API="${RESEND_API:-https://api.resend.com}"
GMAIL_SMTP="${GMAIL_SMTP:-smtps://smtp.gmail.com:465}"
SUPABASE_BIN="${SUPABASE_BIN:-supabase}"
# Auth restarts to pick up new SMTP settings; a code requested sooner than this
# can still go out through the previous server.
SETTLE_SECONDS="${SETTLE_SECONDS:-15}"
RETRY_SECONDS="${RETRY_SECONDS:-10}"
POLL_SECONDS="${POLL_SECONDS:-5}"

SITE_DOMAIN="prelogue.studio"
SENDER_NAME="Prelogue"
PM_SINK="test@blackhole.postmarkapp.com"
RESEND_SINK="delivered@resend.dev"
# Supabase's default allowance for custom SMTP is far below a normal day: at
# the 2/hour this project sat on, the third visitor in an hour was refused.
EMAILS_PER_HOUR=100

[ -f "$ENV_FILE" ] || { echo "✗ $ENV_FILE not found — run this from the repo on the machine that holds the ops secrets." >&2; exit 1; }
set -a; source "$ENV_FILE"; set +a
SUPABASE_URL=$(grep -m1 '^NEXT_PUBLIC_SUPABASE_URL=' "$WEB_ENV" | cut -d= -f2- | tr -d '\042\047')
ANON_KEY=$(grep -m1 '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' "$WEB_ENV" | cut -d= -f2- | tr -d '\042\047')
AUTH_CONFIG_URL="$MGMT_API/v1/projects/$SUPABASE_PROJECT_REF/config/auth"

SECRET=""; ANSWER=""; TEST_TO=""; LAST_ERROR=""; PM_TOKEN=""; PM_CODE=""; PM_MESSAGE=""

good() { printf '✓ %s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

trim()  { printf '%s' "$1" | tr -d '[:space:]'; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
valid_email() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; }
urlencode()   { printf '%s' "$1" | jq -sRr @uri; }
body_of() { printf '%s' "$1" | sed '$d'; }
code_of() { printf '%s' "$1" | tail -1; }

ask() { # PROMPT → $ANSWER
  printf '%s' "$1"
  IFS= read -r ANSWER || true
  ANSWER=$(trim "$ANSWER")
}

ask_secret() { # PROMPT → $SECRET. Whitespace is stripped: Google displays app passwords in spaced groups.
  printf '%s' "$1"
  IFS= read -rs SECRET || true
  echo
  SECRET=$(trim "$SECRET")
}

ask_test_address() { # → $TEST_TO, an inbox outside our own domain
  echo
  echo "To prove this end to end, one test goes to a real inbox."
  ask "An address you can check right now, not @$SITE_DOMAIN (your personal email is fine): "
  TEST_TO=$(lower "$ANSWER")
  valid_email "$TEST_TO" || die "That doesn't look like an email address. Nothing was changed."
  case "$TEST_TO" in
    *@"$SITE_DOMAIN") die "It has to be outside @$SITE_DOMAIN — reaching an outside inbox is the thing being proven. Nothing was changed." ;;
  esac
}

# ── local secrets file and edge-function secrets ──

save_local() { # KEY VALUE — upsert into the gitignored env file
  local tmp
  tmp=$(mktemp "$ENV_FILE.XXXXXX")
  grep -v "^$1=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

set_secrets() { # KEY=VALUE … — through a file, so values stay off the command line. On failure: $LAST_ERROR
  local tmp failed=0
  tmp=$(mktemp)
  printf '%s\n' "$@" > "$tmp"
  "$SUPABASE_BIN" secrets set --env-file "$tmp" --project-ref "$SUPABASE_PROJECT_REF" >/dev/null 2>"$tmp.err" || failed=1
  LAST_ERROR=$(head -c 300 "$tmp.err" 2>/dev/null || true)
  rm -f "$tmp" "$tmp.err"
  return "$failed"
}

# Tell the canary where a real sign-in code can safely go. Runs right after
# sign-in has moved, so a failure here must not read as "sign-in is broken".
set_sink() { # ADDRESS
  set_secrets "EMAIL_SINK=$1" && return 0
  note "! Could not record the monitoring test address ($LAST_ERROR)."
  note "  Sign-in is unaffected. Tell Claude, so the canary doesn't false-alarm."
}

# ── door 1: Supabase Auth ──

auth_config() {
  curl -sS -m 30 "$AUTH_CONFIG_URL" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"
}

auth_patch() { # JSON on stdin → "BODY\nHTTP_CODE"
  curl -sS -m 30 -w '\n%{http_code}' -X PATCH "$AUTH_CONFIG_URL" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" --data-binary @-
}

auth_smtp() { # HOST PORT USER PASS FROM_ADDRESS — move door 1 and confirm it took
  local port out
  # The API reports the port as a string but its own guide sends a number;
  # offer it both ways rather than depend on which one it validates today.
  for port in '(env.P)' '(env.P | tonumber)'; do
    out=$(H="$1" P="$2" U="$3" W="$4" F="$5" N="$SENDER_NAME" R="$EMAILS_PER_HOUR" jq -n "{
        smtp_host: env.H, smtp_port: $port, smtp_user: env.U, smtp_pass: env.W,
        smtp_admin_email: env.F, smtp_sender_name: env.N,
        rate_limit_email_sent: (env.R | tonumber)
      }" | auth_patch) || die "Could not reach Supabase to update the sign-in email settings."
    [ "$(code_of "$out")" = "400" ] || break
  done
  [ "$(code_of "$out")" = "200" ] ||
    die "Supabase refused the sign-in email settings (HTTP $(code_of "$out")): $(body_of "$out" | head -c 240)"
  [ "$(auth_config | jq -r '.smtp_host')" = "$1" ] ||
    die "Supabase accepted the settings but still reports a different mail server."
}

request_code() { # EMAIL → "BODY\nHTTP_CODE" for a real sign-in code request
  curl -sS -m 30 -w '\n%{http_code}' -X POST "$SUPABASE_URL/auth/v1/otp" \
    -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
    --data-binary "$(E="$1" jq -n '{email: env.E, create_user: true}')"
}

prove_sign_in() { # EMAIL — exactly what the sign-in page does; retried while Auth restarts
  local out="" i
  sleep "$SETTLE_SECONDS"
  for i in 1 2 3 4 5 6; do
    out=$(request_code "$1" || true)
    [ "$(code_of "$out")" = "200" ] && return 0
    sleep "$RETRY_SECONDS"
  done
  LAST_ERROR=$(body_of "$out" | jq -r '.msg // .message // .error_code // .' 2>/dev/null | head -c 240)
  return 1
}

# ── door 2: what the deployed functions report ──

functions_health() { # → email-health's JSON, or {} when it can't be reached
  local key
  key=$(curl -sS -m 30 "$MGMT_API/v1/projects/$SUPABASE_PROJECT_REF/api-keys?reveal=true" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" 2>/dev/null |
    jq -r '[.[] | select(.name == "service_role")][0].api_key // empty' 2>/dev/null || true)
  [ -n "$key" ] || { echo '{}'; return; }
  curl -sS -m 30 -X POST "$SUPABASE_URL/functions/v1/email-health" -H "apikey: $key" \
    -H "Authorization: Bearer $key" -H "Content-Type: application/json" -d '{}' 2>/dev/null || echo '{}'
}

report_functions() { # EXPECTED_PROVIDER — say what the live functions actually use
  local health provider
  health=$(functions_health)
  provider=$(printf '%s' "$health" | jq -r '.provider // empty' 2>/dev/null || true)
  if [ "$provider" = "$1" ] && [ "$(printf '%s' "$health" | jq -r '.ok')" = "true" ]; then
    good "The live site functions confirm: sending through $1"
  elif [ -z "$provider" ]; then
    note "! The site's email functions haven't been redeployed with provider support yet,"
    note "  so site emails keep using the old provider until they are. Ask Claude to deploy them."
  else
    note "! The site functions report: $(printf '%s' "$health" | jq -c '{provider, ok, reason}' 2>/dev/null)"
    note "  Secrets can take a minute to reach running functions — re-run with no arguments to re-check."
  fi
}

show_status() {
  local cfg health
  cfg=$(auth_config) || die "Could not reach Supabase."
  echo "Sign-in codes (Supabase Auth)"
  note "server: $(printf '%s' "$cfg" | jq -r '"\(.smtp_host // "Supabase built-in mailer"):\(.smtp_port // "-")"')"
  note "from:   $(printf '%s' "$cfg" | jq -r '"\(.smtp_sender_name // "") <\(.smtp_admin_email // "")>"')"
  note "limit:  $(printf '%s' "$cfg" | jq -r '.rate_limit_email_sent') emails/hour"
  echo "Site emails (exports, notifications, invites, contact form, alerts)"
  health=$(functions_health)
  if [ "$(printf '%s' "$health" | jq -r 'has("ok")' 2>/dev/null || echo false)" = "true" ]; then
    note "provider: $(printf '%s' "$health" | jq -r '.provider // "(functions predate provider support)"')"
    note "healthy:  $(printf '%s' "$health" | jq -r 'if .ok then "yes" else "NO — \(.reason // "unknown")" end')"
  else
    note "could not ask the email-health function"
  fi
  echo
  echo "To change it: bash ops/set-email-provider.sh gmail | postmark | resend"
}

# ── Google Workspace: sign-in codes only ──

canary_address() { printf '%s+canary@%s' "${1%@*}" "${1#*@}"; }

gmail_login() { # USER APP_PASSWORD — a real SMTP login against Google; sends nothing
  local out
  if out=$(printf 'user = "%s:%s"\n' "$1" "$2" | curl -sS -m 25 -K - --url "$GMAIL_SMTP" --request NOOP 2>&1); then
    return 0
  fi
  LAST_ERROR=$(printf '%s' "$out" | tail -1 | head -c 200)
  return 1
}

apply_gmail() { # USER APP_PASSWORD
  auth_smtp smtp.gmail.com 465 "$1" "$2" "$1"
  # No provider sink exists on this path, so the canary's sign-in test goes to
  # a plus-address of the same mailbox.
  set_sink "$(canary_address "$1")"
}

use_gmail() {
  local user pass
  echo "Sign-in codes through Google Workspace."
  echo "You need an app password for the mailbox: https://myaccount.google.com/apppasswords"
  echo "(2-Step Verification has to be on. It is NOT your normal Google password.)"
  echo
  ask "Google Workspace address to send from (e.g. hello@$SITE_DOMAIN): "
  user=$(lower "$ANSWER")
  valid_email "$user" || die "That doesn't look like an email address. Nothing was changed."
  ask_secret "App password for $user (input hidden): "
  pass="$SECRET"
  printf '%s' "$pass" | grep -Eq '^[A-Za-z]{16}$' ||
    die "An app password is exactly 16 letters. Nothing was changed."
  gmail_login "$user" "$pass" || die "Google refused that login ($LAST_ERROR). Nothing was changed."
  good "Google accepted the app password"
  ask_test_address

  apply_gmail "$user" "$pass"
  save_local GMAIL_SMTP_USER "$user"
  save_local GMAIL_SMTP_PASS "$pass"
  good "Supabase Auth now sends sign-in codes through Google as $user"

  echo "Requesting a real sign-in code for $TEST_TO (up to a minute)…"
  prove_sign_in "$TEST_TO" || die "Sign-in email is still failing: $LAST_ERROR"
  good "SIGN-IN CODES ARE SENDING AGAIN — check $TEST_TO for a code from $SENDER_NAME <$user>"
  echo
  note "While sign-in runs on Google: every code also shows in that mailbox's Sent folder,"
  note "and the monitoring test code lands in its inbox every 6 hours (to $(canary_address "$user"))."
  note "Both stop once you move to a dedicated provider: bash ops/set-email-provider.sh postmark"
}

# ── Postmark: both doors ──

pm() { # METHOD PATH [JSON] → "BODY\nHTTP_CODE"
  if [ $# -ge 3 ]; then
    curl -sS -m 30 -w '\n%{http_code}' -X "$1" "$POSTMARK_API$2" -H "Accept: application/json" \
      -H "Content-Type: application/json" -H "X-Postmark-Server-Token: $PM_TOKEN" --data-binary "$3"
  else
    curl -sS -m 30 -w '\n%{http_code}' -X "$1" "$POSTMARK_API$2" -H "Accept: application/json" \
      -H "X-Postmark-Server-Token: $PM_TOKEN"
  fi
}

pm_send() { # FROM TO SUBJECT TEXT → $PM_CODE (Postmark's ErrorCode; 0 = accepted), $PM_MESSAGE
  local out
  out=$(pm POST /email "$(F="$1" T="$2" S="$3" B="$4" jq -n \
    '{From: env.F, To: env.T, Subject: env.S, TextBody: env.B, MessageStream: "outbound", Tag: "setup-check"}')") ||
    die "Could not reach Postmark."
  PM_CODE=$(body_of "$out" | jq -r '.ErrorCode // "?"' 2>/dev/null || echo "?")
  PM_MESSAGE=$(body_of "$out" | jq -r '.Message // empty' 2>/dev/null | head -c 240)
}

pm_count() { # TO FROM → how many messages Postmark has logged from FROM to TO; empty if it can't say
  local out
  out=$(pm GET "/messages/outbound?count=1&offset=0&recipient=$(urlencode "$1")&fromemail=$(urlencode "$2")") || return 0
  [ "$(code_of "$out")" = "200" ] || return 0
  body_of "$out" | jq -r '.TotalCount // empty' 2>/dev/null || true
}

use_postmark() {
  local from="notifications@$SITE_DOMAIN" auth_from="hello@$SITE_DOMAIN" out before after i seen=""
  echo "Sign-in codes and site emails through Postmark."
  echo "You need the SERVER API token: Postmark → Servers → your server → API Tokens."
  echo
  ask_secret "Postmark Server API token (input hidden): "
  PM_TOKEN="$SECRET"
  printf '%s' "$PM_TOKEN" | grep -Eq '^[A-Za-z0-9-]{20,}$' ||
    die "That doesn't look like a Postmark token. Nothing was changed."

  out=$(pm GET /server) || die "Could not reach Postmark. Nothing was changed."
  [ "$(code_of "$out")" = "200" ] ||
    die "Postmark rejected the token ($(body_of "$out" | jq -r '.Message // "no reason given"' 2>/dev/null)). It must be the Server token, not the Account token. Nothing was changed."
  good "Postmark accepted the token (server: $(body_of "$out" | jq -r '.Name // "?"'))"

  # Postmark's sink is exempt from the pending-approval limit, so this isolates
  # one question: is our domain a verified sender?
  pm_send "$from" "$PM_SINK" "Prelogue setup check" "Checking that $SITE_DOMAIN is a verified sender."
  if [ "$PM_CODE" != "0" ]; then
    printf '✗ Postmark will not send as %s yet: %s\n' "$from" "$PM_MESSAGE" >&2
    note "In Postmark: Sender Signatures → Add Domain → $SITE_DOMAIN, add its two DNS records"
    note "at GoDaddy, click Verify on each, then run this again. Nothing was changed."
    exit 1
  fi
  good "Postmark will send as @$SITE_DOMAIN"
  ask_test_address

  set_secrets "POSTMARK_SERVER_TOKEN=$PM_TOKEN" "EMAIL_PROVIDER=postmark" "EMAIL_DOMAIN=$SITE_DOMAIN" ||
    die "Could not set the function secrets: $LAST_ERROR. Nothing was changed."
  save_local POSTMARK_SERVER_TOKEN "$PM_TOKEN"
  good "Site emails are set to go through Postmark"
  sleep "$POLL_SECONDS"
  report_functions postmark

  pm_send "$from" "$TEST_TO" "Prelogue email is connected" \
    "This is a test from Prelogue's email setup. If you're reading it, Postmark can deliver to inboxes outside $SITE_DOMAIN. Nothing for you to do."
  if [ "$PM_CODE" = "412" ]; then
    echo
    echo "Postmark has NOT approved the account yet — it will only deliver to @$SITE_DOMAIN."
    note "Working now:  contact-form messages and alerts reaching hello@$SITE_DOMAIN."
    note "Not yet:      emails to customers, and sign-in codes (left exactly as they were)."
    note "Run this again when Postmark's approval email arrives."
    exit 0
  fi
  [ "$PM_CODE" = "0" ] ||
    die "Postmark refused a test to $TEST_TO: $PM_MESSAGE. Sign-in was left exactly as it was."
  good "Postmark delivered a test to $TEST_TO — the account is approved"

  before=$(pm_count "$TEST_TO" "$auth_from")
  auth_smtp smtp.postmarkapp.com 587 "$PM_TOKEN" "$PM_TOKEN" "$auth_from"
  set_sink "$PM_SINK"
  good "Supabase Auth now sends sign-in codes through Postmark as $auth_from"

  echo "Requesting a real sign-in code for $TEST_TO (up to a minute)…"
  if ! prove_sign_in "$TEST_TO"; then
    printf '✗ Sign-in email is failing through Postmark: %s\n' "$LAST_ERROR" >&2
    if [ -n "${GMAIL_SMTP_USER:-}" ] && [ -n "${GMAIL_SMTP_PASS:-}" ]; then
      apply_gmail "$GMAIL_SMTP_USER" "$GMAIL_SMTP_PASS"
      note "Sign-in was put back on Google ($GMAIL_SMTP_USER) so nobody is locked out."
    fi
    exit 1
  fi

  # A 200 from Auth isn't proof on its own: while Auth restarts, a code can
  # still leave through the previous server. Postmark's own log settles it.
  for i in 1 2 3 4 5 6; do
    after=$(pm_count "$TEST_TO" "$auth_from")
    if [ -n "$after" ] && [ "$after" -gt "${before:-0}" ] 2>/dev/null; then seen=1; break; fi
    sleep "$POLL_SECONDS"
  done
  if [ -n "$seen" ]; then
    good "SIGN-IN CODES ARE SENDING AGAIN — Postmark logged the code it sent to $TEST_TO"
  else
    good "Auth accepted the sign-in code request for $TEST_TO"
    note "! Postmark's log doesn't show that code yet. Check that it arrives From $auth_from, and"
    note "  that Postmark → Activity lists it. If it doesn't, fall back: bash ops/set-email-provider.sh gmail"
  fi
  echo
  note "Everything now runs on Postmark. Tell Claude so the 14 held contact messages get re-sent."
}

# ── Resend: both doors (its accounts have no pending state, so its sink proves sign-in) ──

use_resend() {
  local key out
  ask_secret "Resend API key (input hidden): "
  key="$SECRET"
  case "$key" in re_*) ;; *) die "Resend keys start with re_. Nothing was changed." ;; esac

  out=$(curl -sS -m 30 -w '\n%{http_code}' "$RESEND_API/domains" -H "Authorization: Bearer $key") ||
    die "Could not reach Resend. Nothing was changed."
  # A send-only key can't list domains (restricted_api_key) but is fine for us.
  if [ "$(code_of "$out")" != "200" ] && ! body_of "$out" | grep -q "restricted_api_key"; then
    die "Resend rejected this key (HTTP $(code_of "$out")): $(body_of "$out" | head -c 160). Nothing was changed."
  fi
  good "Resend accepted the key"

  set_secrets "RESEND_API_KEY=$key" "EMAIL_PROVIDER=resend" "EMAIL_DOMAIN=send.$SITE_DOMAIN" "EMAIL_SINK=$RESEND_SINK" ||
    die "Could not set the function secrets: $LAST_ERROR. Nothing was changed."
  save_local RESEND_API_KEY "$key"
  good "Site emails are set to go through Resend"
  auth_smtp smtp.resend.com 465 resend "$key" "auth@send.$SITE_DOMAIN"
  good "Supabase Auth now sends sign-in codes through Resend"

  prove_sign_in "$RESEND_SINK" || die "Sign-in email is still failing: $LAST_ERROR"
  good "SIGN-IN CODES ARE SENDING AGAIN"
  report_functions resend
}

case "${1:-status}" in
  status)   show_status ;;
  gmail)    use_gmail ;;
  postmark) use_postmark ;;
  resend)   use_resend ;;
  *) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
