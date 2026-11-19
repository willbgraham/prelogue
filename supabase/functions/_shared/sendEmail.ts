// One door for every email the product sends from an edge function.
//
// Every sender used to call one provider's API directly, each holding its own
// copy of the key and From address. When that provider suspended the account,
// six functions went dark together and switching meant editing all of them.
// The provider is now configuration, written by ops/set-email-provider.sh:
//
//   EMAIL_PROVIDER          postmark | resend. Optional — without it, the
//                           first provider below that has a token wins.
//   POSTMARK_SERVER_TOKEN / RESEND_API_KEY
//   EMAIL_DOMAIN            the domain our From addresses live on
//   EMAIL_SINK              an address that accepts mail and delivers nowhere,
//                           for the canary's real sign-in-code test
//
// Adding a provider is one entry in PROVIDERS; no caller changes.
//
// sendEmail() never throws and never retries. Callers get { sent: true } or
// { sent: false, reason } and decide what an unsent email means for them.

export type OutgoingEmail = {
  to: string;
  subject: string;
  html: string;
  /** Where a human reply lands. Defaults to the Prelogue inbox. */
  replyTo?: string;
  /** Local part of the From address. */
  from?: "notifications" | "invites";
  /** Label for finding this kind of email in the provider's dashboard. */
  tag?: string;
  /**
   * "broadcast" for anything the recipient didn't directly trigger (nudges,
   * announcements). Providers that separate the two streams police the
   * difference: marketing on the transactional stream gets accounts suspended.
   */
  stream?: "transactional" | "broadcast";
};

export type SendResult =
  | { sent: true; provider: string; id: string | null }
  | { sent: false; provider: string | null; reason: string; status?: number };

export type EmailHealth = {
  ok: boolean;
  provider: string | null;
  reason?: string;
  status?: number;
  sink: string | null;
};

type Prepared = {
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  html: string;
  text: string;
  tag?: string;
  stream: "transactional" | "broadcast";
};

type ProviderSend = { ok: true; id: string | null } | { ok: false; status: number; reason: string };
type ProviderHealth = { ok: boolean; status?: number; reason?: string };

type Provider = {
  tokenEnv: string;
  sink: string;
  send(token: string, m: Prepared): Promise<ProviderSend>;
  /** Is the credential alive? Must not send anything. */
  health(token: string): Promise<ProviderHealth>;
};

const TIMEOUT_MS = 15_000;
const DEFAULT_DOMAIN = "send.prelogue.studio";
const DEFAULT_REPLY_TO = "hello@prelogue.studio";

const postmark: Provider = {
  tokenEnv: "POSTMARK_SERVER_TOKEN",
  sink: "test@blackhole.postmarkapp.com",

  async send(token, m) {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": token,
      },
      body: JSON.stringify({
        From: m.from,
        To: m.to,
        ReplyTo: m.replyTo,
        Subject: m.subject,
        HtmlBody: m.html,
        TextBody: m.text,
        Tag: m.tag,
        // Every Postmark server is created with these two stream ids.
        MessageStream: m.stream === "broadcast" ? "broadcast" : "outbound",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body?.ErrorCode === 0) return { ok: true, id: body.MessageID ?? null };
    return { ok: false, status: res.status, reason: postmarkReason(body, res.status) };
  },

  async health(token) {
    const res = await fetch("https://api.postmarkapp.com/server", {
      headers: { Accept: "application/json", "X-Postmark-Server-Token": token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, status: res.status, reason: postmarkReason(body, res.status) };
  },
};

function postmarkReason(body: { ErrorCode?: number; Message?: string }, status: number): string {
  // 412 is not a fault in the request: a new Postmark account sits in a review
  // queue and may only email its own domain until a human approves it.
  if (body?.ErrorCode === 412) {
    return "postmark account is pending approval — it can only email our own domain until Postmark approves it";
  }
  if (body?.ErrorCode === 406) {
    return "recipient is suppressed at postmark (an earlier bounce or spam complaint)";
  }
  return body?.Message
    ? `postmark ${body.ErrorCode ?? status}: ${String(body.Message).slice(0, 240)}`
    : `postmark HTTP ${status}`;
}

const resend: Provider = {
  tokenEnv: "RESEND_API_KEY",
  sink: "delivered@resend.dev",

  async send(token, m) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      // Resend derives the plain-text part from the HTML itself.
      body: JSON.stringify({
        from: m.from,
        to: m.to,
        reply_to: m.replyTo,
        subject: m.subject,
        html: m.html,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, id: body?.id ?? null };
    return { ok: false, status: res.status, reason: resendReason(body, res.status) };
  },

  async health(token) {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      const ours = (body?.data ?? []).find((d: { name?: string }) => d.name === emailDomain());
      if (ours && ours.status !== "verified") {
        return { ok: false, reason: `sending domain ${ours.name} is ${ours.status}` };
      }
      return { ok: true };
    }
    // A send-only key can't list domains but is perfectly healthy for our use.
    if (body?.name === "restricted_api_key") return { ok: true };
    return { ok: false, status: res.status, reason: resendReason(body, res.status) };
  },
};

function resendReason(body: { name?: string; message?: string }, status: number): string {
  const detail = body?.name || body?.message;
  return detail ? `resend ${String(detail).slice(0, 240)}` : `resend HTTP ${status}`;
}

// Order matters only when EMAIL_PROVIDER is unset: first one with a token wins.
const PROVIDERS: Record<string, Provider> = { postmark, resend };

type Resolved =
  | { name: string; provider: Provider; token: string }
  | { name: string | null; provider?: undefined; problem: string };

function resolve(): Resolved {
  const wanted = (Deno.env.get("EMAIL_PROVIDER") ?? "").trim().toLowerCase();
  if (wanted) {
    const provider = PROVIDERS[wanted];
    if (!provider) return { name: null, problem: `unknown EMAIL_PROVIDER "${wanted}"` };
    const token = Deno.env.get(provider.tokenEnv);
    if (!token) return { name: wanted, problem: `${provider.tokenEnv} is not set` };
    return { name: wanted, provider, token };
  }
  for (const [name, provider] of Object.entries(PROVIDERS)) {
    const token = Deno.env.get(provider.tokenEnv);
    if (token) return { name, provider, token };
  }
  return { name: null, problem: "email provider not configured" };
}

function emailDomain(): string {
  return (Deno.env.get("EMAIL_DOMAIN") ?? "").trim() || DEFAULT_DOMAIN;
}

/** A readable plain-text part: HTML-only mail scores worse with spam filters. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
      const text = String(label).replace(/<[^>]+>/g, "").trim();
      return text && text !== href ? `${text}: ${href}` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|tr|blockquote|li)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&ldquo;|&rdquo;|&quot;/g, '"')
    .replace(/&lsquo;|&rsquo;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function sendEmail(msg: OutgoingEmail): Promise<SendResult> {
  const r = resolve();
  if (!r.provider) return { sent: false, provider: r.name, reason: r.problem };

  const to = (msg.to ?? "").trim();
  if (!to) return { sent: false, provider: r.name, reason: "no recipient" };

  const prepared: Prepared = {
    from: `Prelogue <${msg.from ?? "notifications"}@${emailDomain()}>`,
    to,
    replyTo: msg.replyTo?.trim() || DEFAULT_REPLY_TO,
    // User-supplied names end up in subjects; a line break there is a header.
    subject: msg.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 250),
    html: msg.html,
    text: htmlToText(msg.html),
    tag: msg.tag,
    stream: msg.stream ?? "transactional",
  };

  try {
    const out = await r.provider.send(r.token, prepared);
    if (out.ok) return { sent: true, provider: r.name, id: out.id };
    console.error(`[email] ${msg.tag ?? "untagged"} not sent: ${out.reason} (HTTP ${out.status})`);
    return { sent: false, provider: r.name, status: out.status, reason: out.reason };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "TimeoutError"
        ? `no response from ${r.name} in ${TIMEOUT_MS / 1000}s`
        : `could not reach ${r.name}: ${String(err).slice(0, 200)}`;
    console.error(`[email] ${msg.tag ?? "untagged"} not sent: ${reason}`);
    return { sent: false, provider: r.name, reason };
  }
}

/** Is the configured provider's credential alive? Sends nothing. */
export async function emailHealth(): Promise<EmailHealth> {
  const r = resolve();
  const sink = (Deno.env.get("EMAIL_SINK") ?? "").trim() || r.provider?.sink || null;
  if (!r.provider) return { ok: false, provider: r.name, reason: r.problem, sink };
  try {
    return { ...(await r.provider.health(r.token)), provider: r.name, sink };
  } catch (err) {
    return { ok: false, provider: r.name, reason: `could not reach ${r.name}: ${String(err).slice(0, 200)}`, sink };
  }
}
