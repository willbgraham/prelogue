// One-time nudge to a writer who uploaded but never paid: their script's
// first 10 lines are now free to voice (owner preview), and this email tells
// them. Invoked by ops/nudge.js on a schedule; service-role only.
//
//   { script_id } → email the writer, once per script, with guards:
//     - script still locked, writer still has zero payments
//     - writer isn't the house/ops account
//     - never sent before (dedup marker: a notifications row for the admin)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { brandEmail, esc } from "../_shared/brandEmail.ts";
import { isServiceRole } from "../_shared/serviceRole.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM = Deno.env.get("NOTIFY_FROM") ?? "Prelogue <notifications@send.prelogue.studio>";
const REPLY_TO = "hello@prelogue.studio";
const SITE = "https://prelogue.studio";
const HOUSE_WRITER = "e13e3e11";

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!isServiceRole(auth.replace(/^Bearer\s+/i, ""))) {
      return json({ error: "Not authorized" }, 403);
    }
    const { script_id } = await req.json();
    if (!script_id) return json({ error: "script_id required" }, 400);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: script } = await admin
      .from("scripts")
      .select("id, title, slug, writer_id, full_read_unlocked")
      .eq("id", script_id)
      .maybeSingle();
    if (!script) return json({ sent: false, reason: "script gone" });
    if (script.full_read_unlocked) return json({ sent: false, reason: "already unlocked" });
    if (script.writer_id.startsWith(HOUSE_WRITER)) return json({ sent: false, reason: "house" });

    // Payers never get nudged — even for a different, still-locked script.
    const { data: paid } = await admin
      .from("credit_ledger")
      .select("id")
      .eq("user_id", script.writer_id)
      .in("reason", ["unlock_grant", "topup", "plan_grant"])
      .limit(1);
    if (paid?.length) return json({ sent: false, reason: "writer has paid before" });

    // Dedup: one nudge per script, ever. Marker doubles as the admin's log.
    const { data: adminUser } = await admin
      .from("users")
      .select("id")
      .eq("is_admin", true)
      .limit(1)
      .maybeSingle();
    if (!adminUser) return json({ sent: false, reason: "no admin user" });
    const { data: dupe } = await admin
      .from("notifications")
      .select("id")
      .eq("user_id", adminUser.id)
      .eq("type", "nudge_email")
      .eq("payload->>script_id", script.id)
      .maybeSingle();
    if (dupe) return json({ sent: false, reason: "already nudged" });

    const { data: writerAuth } = await admin.auth.admin.getUserById(script.writer_id);
    const to = writerAuth?.user?.email;
    if (!to) return json({ sent: false, reason: "no email" });
    if (!RESEND_API_KEY) return json({ sent: false, reason: "email provider not configured" });

    const link = `${SITE}/script/${script.slug ?? script.id}`;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to,
        reply_to: REPLY_TO,
        subject: `Hear the first lines of "${script.title}" — free`,
        html: brandEmail({
          heading: `“${script.title}” is parsed and ready to speak`,
          bodyHtml: [
            `<p style="margin:0 0 14px;">Your script is uploaded and parsed — and the <strong style="color:#2A2420;">first ten lines are now free to hear</strong>, with the full cast of voices to choose from.</p>`,
            `<p style="margin:0 0 14px;">Open it, pick a voice for each character (there are about a thousand), and press play. No charge, no card — it's your own opening, performed.</p>`,
            `<p style="margin:0 0 14px;">If it makes you want the rest: one $19 unlock covers the entire script, MP3 and video downloads included.</p>`,
          ].join(""),
          cta: { label: "Hear your opening — free", url: link },
          footnote:
            "You're receiving this once because you uploaded a script on prelogue.studio. Reply if you'd rather not hear from us.",
        }),
      }),
    });
    if (!res.ok) return json({ sent: false, error: (await res.text()).slice(0, 300) });

    await admin.from("notifications").insert({
      user_id: adminUser.id,
      type: "nudge_email",
      payload: {
        script_id: script.id,
        script_title: script.title,
        email: to,
        message: `Nudged ${to} about "${script.title}"`,
      },
    });
    return json({ sent: true, to });
  } catch (err) {
    console.error("send-nudge error:", err);
    return json({ error: "Internal error" }, 500);
  }
});
