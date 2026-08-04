// Emails a contact-form submission to the Prelogue inbox so nobody has to
// remember to check /admin/messages.
//
// Body: { id } — the contact_messages row id, nothing else. The content is read
// from the DB with the service role rather than taken from the caller, so this
// endpoint can't be used to inject arbitrary text, and the recipient is fixed
// (never caller-supplied) so it can't be used as an open relay. Idempotent:
// once a row is marked notified_at it won't send again.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Reuses the same Resend setup as send-invite. CONTACT_TO / CONTACT_FROM can
// override the defaults as function secrets.
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const CONTACT_TO = Deno.env.get("CONTACT_TO") ?? "hello@prelogue.studio";
const CONTACT_FROM =
  Deno.env.get("CONTACT_FROM") ?? "Prelogue <notifications@send.prelogue.studio>";

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

/** Escape user-supplied text before it goes into the HTML body. */
const esc = (s: string) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { id } = await req.json().catch(() => ({}));
    if (!id || typeof id !== "string") return json({ error: "id required" }, 400);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: msg } = await admin
      .from("contact_messages")
      .select("id, name, email, topic, message, created_at, notified_at")
      .eq("id", id)
      .single();
    if (!msg) return json({ error: "not found" }, 404);
    if (msg.notified_at) return json({ sent: false, reason: "already notified" });

    // No provider configured → succeed quietly; the message is stored either way
    // and still shows up in /admin/messages.
    if (!RESEND_API_KEY) return json({ sent: false, reason: "email provider not configured" });

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: CONTACT_FROM,
        to: CONTACT_TO,
        // Hitting Reply in the inbox replies straight to the sender.
        reply_to: msg.email,
        subject: `Prelogue ${msg.topic}: ${msg.name}`,
        html: `<p><b>${esc(msg.name)}</b> &lt;${esc(msg.email)}&gt; sent a message (${esc(msg.topic)}):</p>
<blockquote style="margin:0;padding:12px 16px;border-left:3px solid #BC4026;background:#F4EEDF;white-space:pre-wrap;">${esc(
          msg.message
        )}</blockquote>
<p style="color:#7a7166;font-size:13px;">Reply to this email to answer them directly, or open
<a href="https://prelogue.studio/admin/messages">the admin inbox</a>.</p>`,
      }),
    });
    if (!res.ok) return json({ sent: false, error: (await res.text()).slice(0, 300) });

    await admin
      .from("contact_messages")
      .update({ notified_at: new Date().toISOString() })
      .eq("id", id);

    return json({ sent: true });
  } catch (e) {
    console.error("send-contact error:", e);
    return json({ error: String(e) }, 500);
  }
});
