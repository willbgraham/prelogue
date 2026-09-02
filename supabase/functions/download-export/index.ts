// Durable download links for emailed exports. Deploy with --no-verify-jwt:
// this is opened by a click in an email, with no session and no headers.
//
//   GET /download-export?render=<uuid>  →  302 to a fresh signed URL
//
// Why not put the signed URL in the email directly? That's what we did, and a
// customer's link died within minutes: they re-exported, supersede-cleanup
// deleted the first file, and the first email's link 404'd (NoSuchKey).
// This endpoint resolves at click time: if the named render was superseded
// (or its file is gone), it follows to the script's NEWEST ready export of
// the same kind. Links in old emails always serve the current file, forever.
//
// Auth model: the render uuid is the capability — v4-random, present only in
// the writer's email, same secrecy class as the signed-URL token it replaces.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sorry(msg: string, status = 404) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Prelogue</title>
<body style="font-family:Georgia,serif;background:#E9DFC9;color:#2A2420;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center;">
<div><h1 style="font-size:22px;">${msg}</h1>
<p style="color:#4A423B;">Your newest export is always on your script page on
<a href="https://prelogue.studio" style="color:#BC4026;">prelogue.studio</a> — or reply to your export email and we'll help.</p></div>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

Deno.serve(async (req) => {
  try {
    const renderId = new URL(req.url).searchParams.get("render") ?? "";
    if (!UUID_RE.test(renderId)) return sorry("That download link isn't valid.", 400);

    const { data: row } = await admin
      .from("daily_renders")
      .select("id, script_id, variant, status, video_path")
      .eq("id", renderId)
      .maybeSingle();
    if (!row) return sorry("This export link has expired or was replaced.");

    // Prefer the export the link names; fall forward to the newest ready one
    // of the same kind when it was superseded or its file is missing.
    const candidates: { video_path: string | null }[] = [];
    if ((row.status === "ready" || row.status === "posted") && row.video_path) {
      candidates.push(row);
    }
    const { data: latest } = await admin
      .from("daily_renders")
      .select("video_path, status")
      .eq("script_id", row.script_id)
      .eq("variant", row.variant)
      .in("status", ["ready", "posted"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest?.video_path && latest.video_path !== row.video_path) candidates.push(latest);

    for (const c of candidates) {
      const { data: signed } = await admin.storage
        .from("daily-renders")
        .createSignedUrl(c.video_path!, 600);
      if (signed?.signedUrl) {
        // Probe cheaply: a superseded row's file may be deleted even though
        // signing "succeeds" at the API level only when the object exists —
        // createSignedUrl errors on missing objects, so reaching here is enough.
        return new Response(null, {
          status: 302,
          headers: { Location: signed.signedUrl, "Cache-Control": "no-store" },
        });
      }
    }
    return sorry("This export is being rebuilt — try again shortly.");
  } catch (err) {
    console.error("download-export error:", err);
    return sorry("Something went wrong on our side.", 500);
  }
});
