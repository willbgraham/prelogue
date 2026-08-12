// Email the writer when an INVITED actor submits their read, and flip the
// role invite to 'recorded' so the studio chips reflect reality.
//
//   { submission_id } — caller must be the submission's actor.
//
// Scope note: the in-app "New Audition" notification already exists — it's a
// DB trigger on submissions (dashboard-created; not in the migrations), so
// this function deliberately does NOT insert a notifications row. Its job is
// the two things the trigger can't do: the email, and the invite status flip.
// Emails only fire for invited roles — demo-script takes would otherwise email
// the writer on every ad-click try-out. Idempotency rides on the flip: once
// the invite is 'recorded', repeat calls (and later takes) don't re-email.
//
// Same server-side pattern as notify-listen-request: the caller passes only an
// id; every piece of content and the recipient are derived from the database.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { brandEmail, esc } from "../_shared/brandEmail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM = Deno.env.get("NOTIFY_FROM") ?? "Prelogue <notifications@send.prelogue.studio>";
const REPLY_TO = "hello@prelogue.studio";
const SITE = "https://prelogue.studio";

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { submission_id } = await req.json();
    if (!submission_id) return json({ error: "submission_id required" }, 400);

    const authHeader = req.headers.get("Authorization") ?? "";
    const {
      data: { user },
    } = await createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    }).auth.getUser();
    if (!user) return json({ error: "Not authorized" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: sub } = await admin
      .from("submissions")
      .select("id, actor_id, script_id, character_id, take_number")
      .eq("id", submission_id)
      .maybeSingle();
    if (!sub) return json({ error: "submission not found" }, 404);
    if (sub.actor_id !== user.id) return json({ error: "Not authorized" }, 403);

    const [{ data: script }, { data: character }, { data: actor }] = await Promise.all([
      admin.from("scripts").select("title, slug, writer_id").eq("id", sub.script_id).single(),
      admin.from("characters").select("name").eq("id", sub.character_id).single(),
      admin.from("users").select("display_name").eq("id", user.id).single(),
    ]);
    if (!script) return json({ error: "script not found" }, 404);
    const charName = character?.name ?? "a role";
    const actorName = actor?.display_name || "An actor";

    // Match the invite on the actor's auth email. Only a still-'invited' row
    // triggers the email — the flip doubles as the send-once guard.
    const actorEmail = user.email ?? "";
    let invited = false;
    if (actorEmail) {
      const { data: inv } = await admin
        .from("role_invites")
        .select("id, status")
        .eq("script_id", sub.script_id)
        .eq("character_id", sub.character_id)
        .ilike("email", actorEmail)
        .maybeSingle();
      if (inv) {
        if (inv.status === "recorded") return json({ ok: true, deduped: true });
        invited = true;
        await admin.from("role_invites").update({ status: "recorded" }).eq("id", inv.id);
      }
    }

    // Email only for invited roles — the writer asked for this specific person.
    let emailResult: unknown = { sent: false, reason: invited ? "no writer email" : "not an invited role" };
    if (invited) {
      const { data: writerAuth } = await admin.auth.admin.getUserById(script.writer_id);
      const writerEmail = writerAuth?.user?.email;
      if (writerEmail) {
        emailResult = await (async () => {
          if (!RESEND_API_KEY) return { sent: false, reason: "email provider not configured" };
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: FROM,
              to: writerEmail,
              reply_to: REPLY_TO,
              subject: `${actorName} recorded ${charName} in "${script.title}"`,
              html: brandEmail({
                heading: `${actorName} answered your invite`,
                bodyHtml: `<p style="margin:0 0 14px;"><strong style="color:#2A2420;">${esc(actorName)}</strong> just submitted a read for <strong style="color:#2A2420;">${esc(charName)}</strong> in <strong style="color:#2A2420;">&ldquo;${esc(script.title)}&rdquo;</strong>${sub.take_number > 1 ? ` (take ${sub.take_number})` : ""}.</p><p style="margin:0 0 14px;">Watch it in your casting studio — you can cast them in the role from there, and their take will play inside the table read.</p>`,
                cta: { label: "Watch their take", url: `${SITE}/studio/${sub.script_id}` },
                footnote: "You're receiving this because an actor you invited recorded on prelogue.studio.",
              }),
            }),
          });
          if (!res.ok) return { sent: false, error: (await res.text()).slice(0, 300) };
          return { sent: true };
        })();
      }
    }
    return json({ ok: true, invited, email: emailResult });
  } catch (err) {
    console.error("notify-role-submission error:", err);
    return json({ error: "Internal error" }, 500);
  }
});
