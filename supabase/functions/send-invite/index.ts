import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Set these as Supabase function secrets to enable real invite emails:
//   RESEND_API_KEY  — from https://resend.com (verify the prelogue.studio domain)
//   INVITE_FROM     — e.g. "Prelogue <invites@prelogue.studio>"
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const INVITE_FROM = Deno.env.get("INVITE_FROM") ?? "Prelogue <invites@prelogue.studio>";
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
    const { script_id, email } = await req.json();
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

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: INVITE_FROM,
        to: email,
        subject: `${writerName} invited you to read "${script.title}" on Prelogue`,
        html: `<p>${writerName} invited you to a private screenplay table read on Prelogue.</p>
<p><a href="${link}">Open “${script.title}”</a></p>
<p>Create an account with <b>${email}</b> (this exact address) to view it.</p>`,
      }),
    });
    if (!res.ok) return json({ sent: false, error: await res.text() });
    return json({ sent: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
