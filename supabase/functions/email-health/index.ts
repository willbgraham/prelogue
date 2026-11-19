// Is our email provider key alive? Service-role only; sends nothing.
//
// Exists because of a nine-week outage: the Resend API key was suspended, so
// every sign-in code, export email, nudge, and contact-form notification
// failed — and the canary's own alert emails rode the same dead key, so
// nobody was told. This asks Resend a harmless read question with the exact
// key the other functions use, so the canary can fail loudly (via GitHub's
// own notification, which doesn't depend on Resend) the day the key dies.
import { isServiceRole } from "../_shared/serviceRole.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const auth = req.headers.get("Authorization") ?? "";
  if (!isServiceRole(auth.replace(/^Bearer\s+/i, ""))) return json({ error: "Not authorized" }, 403);

  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return json({ ok: false, reason: "RESEND_API_KEY is not set" });
  try {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      const domain = (body?.data ?? []).find((d: { name?: string }) =>
        (d.name ?? "").includes("prelogue")
      );
      if (domain && domain.status !== "verified") {
        return json({ ok: false, reason: `sending domain ${domain.name} is ${domain.status}` });
      }
      return json({ ok: true });
    }
    const body = await res.json().catch(() => ({}));
    // A send-only key can't list domains but is perfectly healthy for our use.
    if (body?.name === "restricted_api_key") return json({ ok: true, scope: "send-only" });
    return json({
      ok: false,
      status: res.status,
      reason: body?.name || body?.message || `HTTP ${res.status}`,
    });
  } catch (err) {
    return json({ ok: false, reason: String(err) });
  }
});
