// Writer export: render the script's table read as a downloadable video or a
// single MP3, reusing the daily-render pipeline (render-one.yml →
// video-worker → the daily-renders bucket + daily_renders table).
//
//   action "dispatch" → trigger a GitHub Actions render (kind video|audio)
//   action "status"   → latest render rows + signed download URLs when ready
//
// Gates: caller must be the script's writer, and the script must have the full
// read unlocked (the export IS the full read — same $19 gate as generation).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Video only. Remotion renders at roughly 1:1 with the video's runtime, so the
// ceiling is the Actions job timeout (330 min in render-one.yml). At ~0.87 min
// of read per page, 250 pages is ~218 min of video — inside the job even at a
// pessimistic 1.5x realtime on a slow runner.
// Audio has no cap: it's an ffmpeg concat of clips that already exist.
const MAX_VIDEO_PAGES = 250;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { script_id, action, kind: rawKind } = await req.json();
    if (!script_id || (action !== "dispatch" && action !== "status")) {
      return json({ error: "script_id and action (dispatch|status) required" }, 400);
    }
    const kind: "video" | "audio" = rawKind === "audio" ? "audio" : "video";

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Writer gate.
    const authHeader = req.headers.get("Authorization");
    let callerId: string | null = null;
    if (authHeader) {
      const {
        data: { user },
      } = await createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } }
      ).auth.getUser();
      callerId = user?.id ?? null;
    }
    const { data: script, error: scriptErr } = await admin
      .from("scripts")
      .select("writer_id, full_read_unlocked, page_count, title")
      .eq("id", script_id)
      .single();
    if (scriptErr || !script) return json({ error: "Script not found" }, 404);
    if (!callerId || callerId !== script.writer_id) {
      return json({ error: "Only the writer can export this read" }, 403);
    }

    if (action === "status") {
      // Video and audio exports are independent — each has its own latest row,
      // so rendering one never blanks the other's download button.
      const latest = async (variants: string[]) => {
        const { data } = await admin
          .from("daily_renders")
          .select("id, status, video_path, error, created_at, rendered_at")
          .eq("script_id", script_id)
          .in("variant", variants)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        return data;
      };
      const sign = async (p: string) =>
        (await admin.storage.from("daily-renders").createSignedUrl(p, 3600)).data?.signedUrl ??
        null;

      const video = await latest(["ai", "composite"]);
      const audio = await latest(["audio"]);

      let url: string | null = null;
      let siblingMp3: string | null = null;
      if (video?.video_path && (video.status === "ready" || video.status === "posted")) {
        url = await sign(video.video_path);
        // MP3 sibling of the video render (renders after 2026-08-04 carry one).
        // Kept as a fallback so short scripts that already rendered an MP4 have
        // an MP3 without waiting on a second job.
        siblingMp3 = await sign(video.video_path.replace(/\.mp4$/, ".mp3"));
      }
      let audioUrl: string | null = null;
      if (audio?.video_path && (audio.status === "ready" || audio.status === "posted")) {
        audioUrl = await sign(audio.video_path);
      }

      const shape = (r: typeof video, u: string | null) =>
        r
          ? {
              id: r.id,
              status: r.status,
              error: r.error,
              created_at: r.created_at,
              rendered_at: r.rendered_at,
              url: u,
            }
          : null;

      return json({
        render: video ? { ...shape(video, url)!, audio_url: siblingMp3 } : null,
        audio: shape(audio, audioUrl),
      });
    }

    // action === "dispatch"
    if (!script.full_read_unlocked) {
      return json({ error: "Unlock the full read to export it" }, 402);
    }
    if (kind === "video" && (script.page_count ?? 0) > MAX_VIDEO_PAGES) {
      return json(
        {
          error: `MP4 export supports scripts up to ${MAX_VIDEO_PAGES} pages — download the MP3 instead, which has no length limit`,
        },
        400
      );
    }

    const ghPat = Deno.env.get("GH_PAT");
    if (!ghPat) return json({ error: "Export isn't configured (no GH_PAT)" }, 500);
    const repo = Deno.env.get("GH_REPO") || "willbgraham/prelogue";
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/render-one.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ghPat}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "prelogue-export",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: { script_id: String(script_id), variant: kind === "audio" ? "audio" : "ai" },
        }),
      }
    );
    if (res.status !== 204) {
      const detail = await res.text().catch(() => "");
      console.error(`export dispatch failed ${res.status}: ${detail.slice(0, 200)}`);
      return json({ error: `Couldn't start the render (${res.status})` }, 502);
    }
    return json({ dispatched: true });
  } catch (err) {
    console.error("export-read error:", err);
    return json({ error: "Internal error", details: String(err) }, 500);
  }
});
