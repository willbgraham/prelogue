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
import { countElements } from "../_shared/screenplay.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Video only. Feature renders run ~3x realtime under memory pressure (a real
// 94pp render took 4h38m), and GitHub kills any job at 6 hours — so ~110
// pages is the physical wall, which covers nearly every real feature script.
// The UX cost of hours-long renders is handled by notify-export-ready: the
// writer gets an email with the download link when it lands, no open tab
// required. Audio has no cap at all (ffmpeg concat, minutes).
const MAX_VIDEO_PAGES = 110;

// Pages are a poor measure of how long a video is: a 107-page script that was
// nearly all description ran 3 h 35 min. The worker now renders long reads at a
// lower frame rate so they finish inside one job, up to about 400 minutes of
// video; past that there is no point starting. Estimated here from what is read
// aloud (reads run about 840 characters a minute); the worker measures exactly.
// KEEP IN SYNC with video-worker/src/timeline.js and apps/web/lib/exportEstimate.ts.
const CHARS_PER_MINUTE = 840;
const MAX_VIDEO_MINUTES = 400;

/** Minutes a read of these scenes runs, from its spoken characters. */
// deno-lint-ignore no-explicit-any
function readMinutes(scenes: any): number {
  let chars = 0;
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    for (const el of scene?.elements ?? []) {
      if (el?.type === "dialogue" || el?.type === "action") {
        chars += String(el.text ?? "").replace(/\s+/g, " ").trim().length;
      }
    }
  }
  return chars / CHARS_PER_MINUTE;
}

// The override exists for the test rig, which stands in for GitHub (as in parse-script).
const GH_API = Deno.env.get("GH_API_BASE") ?? "https://api.github.com";

/** A job's place on the export card's bar. */
type Progress = { pct: number; stage: string; eta_seconds: number | null; age_seconds: number };
type RenderRow = {
  id: string;
  status: string;
  video_path: string | null;
  error: string | null;
  created_at: string;
  rendered_at: string | null;
  progress?: Progress | null;
};

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
      // How far along a job is, from the note its worker keeps beside the
      // export's files (video-worker/src/progress.js). The time left is brought
      // up to date for the note's age, so the card needs no clock of its own.
      // Missing or unreadable → null, and the card shows its estimate alone.
      const progressOf = async (renderId: string): Promise<Progress | null> => {
        try {
          const { data: note, error } = await admin.storage
            .from("daily-renders")
            .download(`${script_id}/progress/${renderId}.json`);
          if (error || !note) return null;
          const n = JSON.parse(await note.text());
          const written = new Date(n?.updated_at).getTime();
          if (typeof n?.pct !== "number" || !isFinite(n.pct) || !isFinite(written)) return null;
          const age = Math.max(0, Math.round((Date.now() - written) / 1000));
          const eta =
            typeof n.eta_seconds === "number" && isFinite(n.eta_seconds)
              ? Math.max(0, Math.round(n.eta_seconds - age))
              : null;
          return {
            pct: Math.min(99, Math.max(0, Math.floor(n.pct))),
            stage: typeof n.stage === "string" ? n.stage.slice(0, 20) : "",
            eta_seconds: eta,
            age_seconds: age,
          };
        } catch {
          return null;
        }
      };

      // Video and audio exports are independent — each has its own latest row,
      // so rendering one never blanks the other's download button.
      const latest = async (variants: string[]): Promise<RenderRow | null> => {
        const { data } = await admin
          .from("daily_renders")
          .select("id, status, video_path, error, created_at, rendered_at")
          .eq("script_id", script_id)
          .in("variant", variants)
          .neq("status", "superseded") // breadcrumb rows for emailed links
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        // Zombie watchdog: a hard-killed render (OOM, runner death) never runs
        // its failure handler, leaving the row "processing" forever and the
        // card saying "Rendering…" for days. Nothing legitimate runs past the
        // 6h GitHub job ceiling, so past that the row is dead — say so.
        if (
          data &&
          data.status === "processing" &&
          Date.now() - new Date(data.created_at).getTime() > 6.5 * 3600_000
        ) {
          await admin
            .from("daily_renders")
            .update({ status: "failed", error: "The render died without reporting back — try again" })
            .eq("id", data.id)
            .eq("status", "processing");
          return { ...data, status: "failed", error: "The render died without reporting back — try again" };
        }
        if (data && data.status === "processing") {
          return { ...data, progress: await progressOf(data.id) };
        }
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
              // While it runs: where it is on the bar (null until the worker
              // first reports), and how long it has been going — which is what
              // the card falls back on for a job that never reports at all.
              progress: r.status === "processing" ? r.progress ?? null : null,
              elapsed_seconds:
                r.status === "processing"
                  ? Math.max(0, Math.round((Date.now() - new Date(r.created_at).getTime()) / 1000))
                  : null,
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
    // A render of a script with no lines fails minutes later with an error
    // only we can read. Say so now. Looked up here, on dispatch only: the
    // status poll runs every 20 seconds and must not haul the parse around.
    // (HTTP 200 so the card can show the reason.)
    const { data: body } = await admin
      .from("scripts")
      .select("scenes:parsed_json->scenes")
      .eq("id", script_id)
      .single();
    if (countElements(body?.scenes) === 0) {
      return json({
        error:
          "We couldn't read any lines from this PDF yet, so there is nothing to export. Upload a PDF exported from your writing app first.",
      });
    }
    if (kind === "video" && (script.page_count ?? 0) > MAX_VIDEO_PAGES) {
      return json(
        {
          error: `Video export supports scripts up to ${MAX_VIDEO_PAGES} pages — the MP3 has no limit, and we can render longer videos on request (hello@prelogue.studio)`,
        },
        400
      );
    }
    const minutes = readMinutes(body?.scenes);
    if (kind === "video" && minutes > MAX_VIDEO_MINUTES) {
      return json(
        {
          error: `This read runs about ${Math.round(minutes / 60)} hours — longer than we can render as one video. The MP3 has no limit, and we can render longer videos on request (hello@prelogue.studio)`,
        },
        400
      );
    }

    const ghPat = Deno.env.get("GH_PAT");
    if (!ghPat) return json({ error: "Export isn't configured (no GH_PAT)" }, 500);
    const repo = Deno.env.get("GH_REPO") || "willbgraham/prelogue";
    const res = await fetch(
      `${GH_API}/repos/${repo}/actions/workflows/render-one.yml/dispatches`,
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
