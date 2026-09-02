// Email the writer when their export finishes — the piece that makes long
// renders acceptable. A feature-length MP4 takes hours; nobody should have to
// keep a tab open (a customer once clicked a failing export seven times and
// left). The render worker invokes this after the file is uploaded.
//
//   { render_id } — caller must be service role (the worker). Recipient and
//   all content are derived from the database; the download link is a 30-day
//   signed URL.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { brandEmail } from "../_shared/brandEmail.ts";
import { isServiceRole } from "../_shared/serviceRole.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM = Deno.env.get("NOTIFY_FROM") ?? "Prelogue <notifications@send.prelogue.studio>";
const REPLY_TO = "hello@prelogue.studio";
const SITE = "https://prelogue.studio";
// House account: its scripts are ops content (daily scenes); no emails.
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

    const { render_id } = await req.json();
    if (!render_id) return json({ error: "render_id required" }, 400);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: render } = await admin
      .from("daily_renders")
      .select("id, script_id, variant, status, video_path")
      .eq("id", render_id)
      .maybeSingle();
    if (!render) return json({ error: "render not found" }, 404);
    if (render.status !== "ready" || !render.video_path) {
      return json({ error: "render not ready" }, 409);
    }

    const { data: script } = await admin
      .from("scripts")
      .select("title, slug, writer_id")
      .eq("id", render.script_id)
      .single();
    if (!script) return json({ error: "script not found" }, 404);
    if (script.writer_id.startsWith(HOUSE_WRITER)) {
      return json({ sent: false, reason: "house script" });
    }

    const { data: writerAuth } = await admin.auth.admin.getUserById(script.writer_id);
    const to = writerAuth?.user?.email;
    if (!to) return json({ sent: false, reason: "writer has no email" });
    if (!RESEND_API_KEY) return json({ sent: false, reason: "email provider not configured" });

    // Durable link: resolves to a fresh signed URL at click time and follows
    // supersedes, so the email keeps working after re-exports and never
    // expires. (A raw 30-day signed URL died within minutes for a real
    // customer when their re-export's cleanup deleted the first file.)
    const link = `${Deno.env.get("SUPABASE_URL")}/functions/v1/download-export?render=${render.id}`;

    const isAudio = render.variant === "audio";
    const kindLabel = isAudio ? "MP3" : "video";
    const pageLink = `${SITE}/script/${script.slug ?? render.script_id}`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to,
        reply_to: REPLY_TO,
        subject: `Your ${kindLabel} of "${script.title}" is ready`,
        html: brandEmail({
          heading: `Your ${kindLabel} of “${script.title}” is ready`,
          bodyHtml: `<p style="margin:0 0 14px;">The export finished and your file is ready to download. It's also on your script page under the player.</p>`,
          cta: { label: isAudio ? "Download the MP3" : "Download the video", url: link },
          footnote: "You're receiving this because you exported a table read on prelogue.studio. This link keeps working — it always serves your newest export.",
        }),
      }),
    });
    if (!res.ok) return json({ sent: false, error: (await res.text()).slice(0, 300) });
    return json({ sent: true });
  } catch (err) {
    console.error("notify-export-ready error:", err);
    return json({ error: "Internal error" }, 500);
  }
});
