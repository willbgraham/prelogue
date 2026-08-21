// Meta Conversions API — server-side conversion events.
//
// Why this exists: the browser pixel's Purchase only fired if the buyer landed
// back on the script page with ?unlocked=1 and nothing blocked the pixel. In
// practice Meta saw zero Purchase events over a week that included a real sale
// — so ad delivery optimized on clicks, blind to revenue. Sending from the
// Stripe webhook records every sale at the moment payment is confirmed.
//
// No-op (with a log) until META_CAPI_TOKEN is set as a function secret:
//   Events Manager → your Prelogue dataset → Settings → Conversions API
//   → Generate access token, then `supabase secrets set META_CAPI_TOKEN=…`
//
// event_id: pass something stable per real-world conversion (the Stripe
// checkout-session or subscription id). Stripe retries webhooks; Meta dedups
// on (event_name, event_id), so retries can't double-count.

const PIXEL_ID = Deno.env.get("META_PIXEL_ID") ?? "1739384400586585";
const CAPI_TOKEN = Deno.env.get("META_CAPI_TOKEN");
const SITE = "https://prelogue.studio";

async function sha256(s: string): Promise<string> {
  const data = new TextEncoder().encode(s.trim().toLowerCase());
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sendCapiEvent(opts: {
  eventName: "Purchase" | "Subscribe";
  eventId: string;
  email?: string | null;
  userId?: string | null;
  value?: number;
  currency?: string;
  contentName?: string;
  testEventCode?: string;
}): Promise<{ sent: boolean; reason?: string }> {
  if (!CAPI_TOKEN) {
    console.log(`capi: skipped ${opts.eventName} (META_CAPI_TOKEN not set)`);
    return { sent: false, reason: "no token" };
  }
  try {
    const user_data: Record<string, string[]> = {};
    if (opts.email) user_data.em = [await sha256(opts.email)];
    if (opts.userId) user_data.external_id = [await sha256(opts.userId)];
    if (!user_data.em && !user_data.external_id) {
      return { sent: false, reason: "no user identifiers" };
    }

    const body: Record<string, unknown> = {
      data: [
        {
          event_name: opts.eventName,
          event_time: Math.floor(Date.now() / 1000),
          event_id: opts.eventId,
          action_source: "website",
          event_source_url: SITE,
          user_data,
          custom_data: {
            currency: (opts.currency ?? "USD").toUpperCase(),
            value: opts.value ?? 0,
            ...(opts.contentName ? { content_name: opts.contentName } : {}),
          },
        },
      ],
    };
    if (opts.testEventCode) body.test_event_code = opts.testEventCode;

    const res = await fetch(
      `https://graph.facebook.com/v21.0/${PIXEL_ID}/events?access_token=${CAPI_TOKEN}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`capi: ${opts.eventName} failed ${res.status}: ${detail.slice(0, 300)}`);
      return { sent: false, reason: `http ${res.status}` };
    }
    console.log(`capi: ${opts.eventName} sent (event_id ${opts.eventId})`);
    return { sent: true };
  } catch (err) {
    // Never let ad measurement break payment processing.
    console.error("capi: error", err);
    return { sent: false, reason: String(err) };
  }
}
