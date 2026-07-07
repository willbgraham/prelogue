import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// SightEngine credentials — set as Supabase function secrets:
//   SIGHTENGINE_API_USER, SIGHTENGINE_API_SECRET   (https://sightengine.com)
const SE_USER = Deno.env.get("SIGHTENGINE_API_USER");
const SE_SECRET = Deno.env.get("SIGHTENGINE_API_SECRET");

// Models we screen for. Tuned for a *performance* app: we reject the things
// that are never "acting" (explicit sexual content, real gore, hate/offensive
// symbols, self-harm). Weapons / staged violence are intentionally NOT auto-
// rejected here to avoid false positives on dramatic scenes.
const MODELS = "nudity-2.1,gore-2.0,offensive-2.0,self-harm";
const THRESHOLDS = { nudity: 0.5, gore: 0.6, offensive: 0.5, selfharm: 0.5 };

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function maxNum(obj: unknown): number {
  if (!obj || typeof obj !== "object") return 0;
  let m = 0;
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (typeof v === "number" && v > m) m = v;
  }
  return m;
}

type Scores = { nudity: number; gore: number; offensive: number; selfharm: number };

// Worst score per category across every sampled frame of one clip.
function scoreFrames(frames: Record<string, any>[]): Scores {
  const out: Scores = { nudity: 0, gore: 0, offensive: 0, selfharm: 0 };
  for (const f of frames) {
    const n = f.nudity || {};
    // Explicit only — never "suggestive"/"none" (those run high on safe frames).
    const nud = Math.max(n.sexual_activity || 0, n.sexual_display || 0, n.erotica || 0);
    const gore = f.gore?.prob ?? maxNum(f.gore);
    const offensive = f.offensive?.prob ?? maxNum(f.offensive);
    const shObj = f["self-harm"] ?? f.self_harm ?? {};
    const selfharm = shObj.prob ?? maxNum(shObj);
    out.nudity = Math.max(out.nudity, nud);
    out.gore = Math.max(out.gore, gore);
    out.offensive = Math.max(out.offensive, offensive);
    out.selfharm = Math.max(out.selfharm, selfharm);
  }
  return out;
}

// Screens one clip. Returns { scores } when SightEngine verified it, or { error }
// with the reason it couldn't — so the caller can fail OPEN and record why.
type ClipResult = { scores?: Scores; error?: string };
async function checkClip(url: string): Promise<ClipResult> {
  const params = new URLSearchParams({
    stream_url: url,
    models: MODELS,
    api_user: SE_USER!,
    api_secret: SE_SECRET!,
  });
  try {
    const r = await fetch(`https://api.sightengine.com/1.0/video/check-sync.json?${params}`);
    const j = await r.json();
    if (j.status !== "success" || !Array.isArray(j.data?.frames)) {
      const detail = (j?.error && (j.error.message || j.error.type)) || j?.status || `http_${r.status}`;
      return { error: String(detail).slice(0, 200) };
    }
    return { scores: scoreFrames(j.data.frames) };
  } catch (e) {
    return { error: "fetch_failed: " + (e instanceof Error ? e.message : String(e)).slice(0, 140) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!SE_USER || !SE_SECRET) return json({ error: "Moderation not configured" }, 500);
    const { submission_id } = await req.json();
    if (!submission_id) return json({ error: "submission_id required" }, 400);

    // The caller must own the submission (prevents quota abuse).
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

    const { data: sub } = await admin
      .from("submissions")
      .select("id, actor_id, clips, moderation_status")
      .eq("id", submission_id)
      .single();
    if (!sub) return json({ error: "Submission not found" }, 404);
    if (sub.actor_id !== user.id) return json({ error: "Not authorized" }, 403);
    // Idempotent: only screen pending rows.
    if (sub.moderation_status !== "pending") return json({ status: sub.moderation_status });

    const clips = Array.isArray(sub.clips)
      ? (sub.clips as { clip_url: string }[]).filter((c) => c?.clip_url)
      : [];

    // Nothing to screen → approve.
    if (!clips.length) {
      await admin.from("submissions").update({ moderation_status: "approved" }).eq("id", sub.id);
      return json({ status: "approved" });
    }

    // Sign every clip, then screen them all in parallel.
    const { data: signed } = await admin.storage
      .from("submissions")
      .createSignedUrls(clips.map((c) => c.clip_url), 600);
    const urls = (signed ?? []).map((s) => s?.signedUrl).filter(Boolean) as string[];

    const results = await Promise.all(urls.map((u) => checkClip(u)));
    const errors = results.filter((r) => r.error).map((r) => r.error!);
    const scored = results.filter((r) => r.scores).map((r) => r.scores!);
    if (errors.length) console.log("moderate-submission verify errors:", JSON.stringify(errors.slice(0, 6)));

    // Worst score per category across the clips SightEngine could actually read.
    const worst: Scores = { nudity: 0, gore: 0, offensive: 0, selfharm: 0 };
    for (const r of scored) {
      worst.nudity = Math.max(worst.nudity, r.nudity);
      worst.gore = Math.max(worst.gore, r.gore);
      worst.offensive = Math.max(worst.offensive, r.offensive);
      worst.selfharm = Math.max(worst.selfharm, r.selfharm);
    }

    const reasons: string[] = [];
    if (worst.nudity >= THRESHOLDS.nudity) reasons.push("nudity");
    if (worst.gore >= THRESHOLDS.gore) reasons.push("gore");
    if (worst.offensive >= THRESHOLDS.offensive) reasons.push("offensive");
    if (worst.selfharm >= THRESHOLDS.selfharm) reasons.push("self-harm");

    const at = new Date().toISOString();
    let status: string;
    let meta: Record<string, unknown>;
    if (reasons.length) {
      // A positive detection stands, even if other clips couldn't be verified.
      status = "rejected";
      meta = { scores: worst, reasons, clips: clips.length, verified: scored.length, at };
    } else if (errors.length) {
      // Couldn't fully verify + nothing flagged → FAIL OPEN (stay visible) but record
      // the flag + SightEngine's error so the real video-check cause can be fixed.
      status = "approved";
      meta = { verification: "failed_open", errors: errors.slice(0, 6), verified: scored.length, clips: clips.length, at };
    } else {
      status = "approved";
      meta = { scores: worst, reasons: [], clips: clips.length, at };
    }

    await admin.from("submissions").update({ moderation_status: status, moderation_meta: meta }).eq("id", sub.id);
    return json({ status, reasons, verify_errors: errors.length });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "error" }, 500);
  }
});
