#!/bin/bash
# Rotate the Resend API key everywhere it lives — in one step, verified.
#
# The key is used in THREE places, and missing any one leaves something dead:
#   1. Supabase Auth SMTP password  → sign-in codes (signup + login)
#   2. RESEND_API_KEY function secret → export emails, nudges, notifications,
#      contact form, canary alerts
#   3. .env.supabase.local           → local ops scripts
#
# Run from anywhere:   bash ops/rotate-resend-key.sh
# The key is read with hidden input and never echoed or written to history.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env.supabase.local; set +a

printf "Paste the NEW Resend API key (input hidden): "
read -rs NEWKEY; echo
case "$NEWKEY" in re_*) ;; *) echo "That doesn't look like a Resend key (they start with re_). Nothing changed."; exit 1;; esac

# 0. Prove the key is alive BEFORE touching anything. A send-only key can't
#    list domains (restricted_api_key) but is fine for us.
probe=$(curl -s -w "\n%{http_code}" https://api.resend.com/domains -H "Authorization: Bearer $NEWKEY")
code=$(echo "$probe" | tail -1); body=$(echo "$probe" | sed '$d')
if [ "$code" != "200" ] && ! echo "$body" | grep -q "restricted_api_key"; then
  echo "Resend rejected this key (HTTP $code): $(echo "$body" | head -c 160)"
  echo "Nothing changed."; exit 1
fi
echo "✓ key accepted by Resend"

# 1. Auth SMTP password. Also lift the Auth email rate limit from 2/hour —
#    at 2/hour, a third person asking for a code in the same hour is refused.
curl -s -o /dev/null -w "✓ Supabase Auth SMTP updated (HTTP %{http_code})\n" -X PATCH \
  "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d "$(jq -n --arg k "$NEWKEY" '{smtp_pass: $k, rate_limit_email_sent: 100}')"

# 2. Edge-function secret.
supabase secrets set RESEND_API_KEY="$NEWKEY" --project-ref "$SUPABASE_PROJECT_REF" >/dev/null
echo "✓ function secret RESEND_API_KEY updated"

# 3. Local env file (keys are [A-Za-z0-9_], safe for sed).
if grep -q '^RESEND_API_KEY=' .env.supabase.local; then
  sed -i '' "s|^RESEND_API_KEY=.*|RESEND_API_KEY=$NEWKEY|" .env.supabase.local
else
  echo "RESEND_API_KEY=$NEWKEY" >> .env.supabase.local
fi
echo "✓ .env.supabase.local updated"
unset NEWKEY

# 4. End-to-end proof: ask Auth to send a real sign-in code to Resend's sink.
URL=$(grep -m1 NEXT_PUBLIC_SUPABASE_URL apps/web/.env.local | cut -d= -f2- | tr -d '\042\047')
AK=$(grep -m1 NEXT_PUBLIC_SUPABASE_ANON_KEY apps/web/.env.local | cut -d= -f2- | tr -d '\042\047')
sleep 5
out=$(curl -s -w "\n%{http_code}" -X POST "$URL/auth/v1/otp" -H "apikey: $AK" \
  -H "Content-Type: application/json" -d '{"email":"delivered@resend.dev","create_user":true}')
if [ "$(echo "$out" | tail -1)" = "200" ]; then
  echo "✓ SIGN-IN CODES ARE SENDING AGAIN"
else
  echo "✗ sign-in email still failing: $(echo "$out" | sed '$d' | head -c 200)"
  echo "  (Auth can take a minute to pick up new SMTP settings — re-run: node ops/canary.js)"
  exit 1
fi
