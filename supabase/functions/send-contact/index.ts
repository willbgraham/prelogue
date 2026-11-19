// Emails a contact-form submission to the Prelogue inbox so nobody has to
// remember to check /admin/messages.
//
// Body: { id } — the contact_messages row id, nothing else. The content is read
// from the DB with the service role rather than taken from the caller, so this
// endpoint can't be used to inject arbitrary text, and the recipient is fixed
// (never caller-supplied) so it can't be used as an open relay. Idempotent:
// once a row is marked notified_at it won't send again.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendEmail } from "../_shared/sendEmail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// CONTACT_TO can override the inbox as a function secret.
const CONTACT_TO = Deno.env.get("CONTACT_TO") ?? "hello@prelogue.studio";

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

    // Hitting Reply in the inbox replies straight to the sender — unless what
    // they typed isn't an address. A provider rejects the whole email over a
    // malformed Reply-To, and the address is in the body either way.
    const replyTo = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(msg.email ?? "") ? msg.email : undefined;

    // An unsent notification isn't an error for the caller: the message is
    // stored regardless and still shows up in /admin/messages.
    const result = await sendEmail({
      to: CONTACT_TO,
      replyTo,
      subject: `Prelogue ${msg.topic}: ${msg.name}`,
      html: `<p><b>${esc(msg.name)}</b> &lt;${esc(msg.email)}&gt; sent a message (${esc(msg.topic)}):</p>
<blockquote style="margin:0;padding:12px 16px;border-left:3px solid #BC4026;background:#F4EEDF;white-space:pre-wrap;">${esc(
        msg.message
      )}</blockquote>
<p style="color:#7a7166;font-size:13px;">Reply to this email to answer them directly, or open
<a href="https://prelogue.studio/admin/messages">the admin inbox</a>.</p>`,
      tag: "contact-form",
    });
    if (!result.sent) return json(result);

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
