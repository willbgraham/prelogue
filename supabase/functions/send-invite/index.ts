// Invite emails, writer-gated. Two kinds:
//   { script_id, email }                → private-script invite (original)
//   { script_id, email, kind: "role" }  → invite to READ A ROLE — the character
//     name and the writer's note are loaded from the role_invites row the
//     client just inserted, so email content is server-derived. The recipient
//     address is inherently writer-chosen (that's what an invite is).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { brandEmail, esc } from "../_shared/brandEmail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const INVITE_FROM = Deno.env.get("INVITE_FROM") ?? "Prelogue <invites@send.prelogue.studio>";
const REPLY_TO = "hello@prelogue.studio";
const SITE = "https://prelogue.studio";

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { script_id, email, kind } = await req.json();
    if (!script_id || !email) return json({ error: "script_id and email required" }, 400);

    // The caller must be the script's writer.
    const authHeader = req.headers.get("Authorization") ?? "";
    const {
      data: { user },
    } = await createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    ).auth.getUser();
    if (!user) return json({ error: "Not authorized" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: script } = await admin
      .from("scripts")
      .select("title, slug, writer_id")
      .eq("id", script_id)
      .single();
    if (!script || script.writer_id !== user.id) return json({ error: "Not authorized" }, 403);

    // No provider configured yet → succeed quietly (the invite is already stored,
    // so the person gets access on sign-in; this just skips the email).
    if (!RESEND_API_KEY) return json({ sent: false, reason: "email provider not configured" });

    const { data: writer } = await admin
      .from("users")
      .select("display_name")
      .eq("id", user.id)
      .single();
    const writerName = writer?.display_name || "A writer";
    const link = `${SITE}/script/${script.slug ?? script_id}`;

    let subject: string;
    let html: string;

    if (kind === "role") {
      // Load the just-created invite for the role name + the writer's note.
      const { data: invite } = await admin
        .from("role_invites")
        .select("note, character_id, characters(name)")
        .eq("script_id", script_id)
        .ilike("email", email)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const charName =
        (invite?.characters as { name?: string } | null)?.name ?? "a role";

      subject = `${writerName} invited you to read ${charName} in "${script.title}"`;
      html = brandEmail({
        heading: `${writerName} wants you to read ${charName}`,
        bodyHtml: [
          `<p style="margin:0 0 14px;">You've been invited to record the role of <strong style="color:#2A2420;">${esc(charName)}</strong> in <strong style="color:#2A2420;">&ldquo;${esc(script.title)}&rdquo;</strong> on Prelogue — a teleprompter feeds you every line, and AI voices read the rest of the cast opposite you.</p>`,
          invite?.note
            ? `<p style="margin:0 0 14px;padding:12px 16px;background:#EDE4CE;border-radius:8px;font-style:italic;">&ldquo;${esc(invite.note)}&rdquo;<br><span style="font-style:normal;font-size:13px;color:#8A7F73;">— ${esc(writerName)}</span></p>`
            : "",
          `<p style="margin:0 0 14px;">Sign up (or in) with <strong style="color:#2A2420;">${esc(email)}</strong> — this exact address — and the script will be waiting for you.</p>`,
        ].join(""),
        cta: { label: "Read the script & record", url: link },
        footnote: `${writerName} invited this address via prelogue.studio. If this isn't for you, just ignore it.`,
      });
    } else {
      subject = `${writerName} invited you to read "${script.title}" on Prelogue`;
      html = brandEmail({
        heading: `${writerName} shared a private script with you`,
        bodyHtml: [
          `<p style="margin:0 0 14px;">You've been invited to a private screenplay table read of <strong style="color:#2A2420;">&ldquo;${esc(script.title)}&rdquo;</strong> on Prelogue.</p>`,
          `<p style="margin:0 0 14px;">Create an account with <strong style="color:#2A2420;">${esc(email)}</strong> — this exact address — to view it.</p>`,
        ].join(""),
        cta: { label: `Open “${script.title}”`, url: link },
        footnote: `${writerName} invited this address via prelogue.studio. If this isn't for you, just ignore it.`,
      });
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: INVITE_FROM, to: email, reply_to: REPLY_TO, subject, html }),
    });
    if (!res.ok) return json({ sent: false, error: await res.text() });
    return json({ sent: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
