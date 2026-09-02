const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { bundle } = require("@remotion/bundler");
const { selectComposition, renderMedia } = require("@remotion/renderer");
const {
  fetchScript,
  ensureVoiceCues,
  priceVoiceCues,
  fetchManifest,
  signPaths,
  fetchClips,
} = require("./supabaseData");
const { probeAll } = require("./probe");
const { buildRows, buildTimeline } = require("./timeline");

const ENTRY = path.join(__dirname, "..", "remotion", "src", "index.ts");

// Retire older exports of the same kind: delete their FILES (a 942MB MP4 per
// re-render would pile up) but keep the ROWS as 'superseded' breadcrumbs —
// emailed download-export links resolve through them to the newest file. A
// customer's emailed link once died minutes after sending because cleanup
// deleted the row and file it pointed at. Falls back to hard delete until the
// 'superseded' status migration is applied (breadcrumbs just don't survive).
async function retireOldExports(supabase, { scriptId, variant, renderId, newerThanOnly }) {
  let q = supabase
    .from("daily_renders")
    .select("id, video_path, created_at")
    .eq("script_id", scriptId)
    .eq("variant", variant)
    .neq("id", renderId)
    .in("status", ["ready", "posted", "failed", "processing"]);
  if (newerThanOnly) q = q.lt("created_at", newerThanOnly);
  const { data: stale } = await q;
  if (!stale || !stale.length) return;
  const files = stale
    .map((s) => s.video_path)
    .filter(Boolean)
    .flatMap((p) => (p.endsWith(".mp4") ? [p, p.replace(/\.mp4$/, ".mp3")] : [p]));
  if (files.length) await supabase.storage.from("daily-renders").remove(files);
  const ids = stale.map((s) => s.id);
  const { error } = await supabase
    .from("daily_renders")
    .update({ status: "superseded" })
    .in("id", ids);
  if (error) {
    // Pre-migration constraint rejects 'superseded' — old behavior instead.
    await supabase.from("daily_renders").delete().in("id", ids);
  }
  console.log(`  retired ${ids.length} superseded export(s)`);
}

// Long renders finish while nobody's watching — a feature MP4 takes hours.
// Tell the writer by email (server-side fn signs a 30-day link). Fire-and-
// forget: a notification failure must never fail a finished render.
async function notifyExportReady(supabaseUrl, serviceKey, renderId) {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/notify-export-ready`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ render_id: renderId }),
    });
    const out = await res.json().catch(() => ({}));
    console.log(`export-ready email: ${JSON.stringify(out).slice(0, 120)}`);
  } catch (e) {
    console.warn("export-ready email failed (non-fatal):", (e && e.message) || e);
  }
}

// Bundle the Remotion project once and reuse across renders.
let bundlePromise = null;
function getBundle() {
  if (!bundlePromise) bundlePromise = bundle({ entryPoint: ENTRY });
  return bundlePromise;
}

// Resolve a script into fully-signed, frame-accurate DailySceneProps.
async function buildProps({ supabase, supabaseUrl, serviceKey, scriptId, variant, submissionIds }) {
  const script = await fetchScript(supabase, scriptId);
  const rows = buildRows(script.parsed_json);
  if (!rows.length) throw new Error("script has no parsed rows");

  const cues = await ensureVoiceCues(supabaseUrl, serviceKey, scriptId);
  if (!cues || !cues.manifest_path) throw new Error("voice manifest not available");
  const manifest = await fetchManifest(supabase, cues.manifest_path);
  const manifestByIdx = new Map(manifest.map((m) => [m.element_index, m]));

  const signedByKey = await signPaths(supabase, "scripts", manifest.map((m) => m.audio_path));

  let clipsByIdx = new Map();
  if (variant === "composite") {
    clipsByIdx = await fetchClips(supabase, scriptId, submissionIds);
    const clipSigned = await signPaths(supabase, "submissions", [...clipsByIdx.values()].map((c) => c.clip_url));
    for (const [k, v] of clipSigned) signedByKey.set(k, v);
  }

  const durationByKey = await probeAll([
    ...manifest.map((m) => ({ key: m.audio_path, url: signedByKey.get(m.audio_path) })),
    ...[...clipsByIdx.values()].map((c) => ({ key: c.clip_url, url: signedByKey.get(c.clip_url) })),
  ]);

  const { fps, segments } = buildTimeline(rows, { manifestByIdx, clipsByIdx, durationByKey, signedByKey });

  // Scene background beds (scripts.ambience_config) — the same beds the web
  // player loops. NOT passed to Remotion (its 4.0.485 asset mixer mangles
  // their levels); the worker post-mixes them with ffmpeg after the render.
  const ambience = [];
  const amb = script.ambience_config;
  if (amb && amb.enabled !== false && amb.scenes && typeof amb.scenes === "object") {
    const bedPaths = Object.values(amb.scenes)
      .map((s) => s && s.path)
      .filter(Boolean);
    if (bedPaths.length) {
      const bedSigned = await signPaths(supabase, "scripts", bedPaths);
      const ranges = new Map(); // sceneIndex → { start, end } in frames
      for (const s of segments) {
        const r = ranges.get(s.sceneIndex) || { start: s.startFrame, end: s.startFrame + s.durationFrames };
        r.start = Math.min(r.start, s.startFrame);
        r.end = Math.max(r.end, s.startFrame + s.durationFrames);
        ranges.set(s.sceneIndex, r);
      }
      const vol = Math.min(0.4, Math.max(0, amb.volume != null ? amb.volume : 0.15));
      for (const [key, sc] of Object.entries(amb.scenes)) {
        const r = ranges.get(Number(key));
        const url = sc && sc.path ? bedSigned.get(sc.path) : null;
        if (r && url) {
          ambience.push({
            sceneIndex: Number(key),
            src: url,
            volume: vol,
            startFrame: r.start,
            durationFrames: r.end - r.start,
          });
        }
      }
    }
  }

  return {
    script,
    ambience,
    props: { fps, variant, script: { id: script.id, title: script.title }, segments },
  };
}

// Mix the scene beds under the rendered video's audio with ffmpeg: each bed
// loops for its scene's duration, delayed to the scene's start, at the
// writer's volume. Video stream is copied untouched. Returns the mixed path.
function postMixAmbience(inPath, outPath, ambience, fps) {
  const { execFileSync } = require("child_process");
  const args = ["-y", "-i", inPath];
  const filters = [];
  const mixIns = ["[0:a]"];
  ambience.forEach((a, i) => {
    args.push("-i", a.src);
    const delayMs = Math.round((a.startFrame / fps) * 1000);
    const durSec = (a.durationFrames / fps).toFixed(3);
    filters.push(
      `[${i + 1}:a]aloop=loop=-1:size=2147483647,atrim=0:${durSec},` +
        `adelay=${delayMs}|${delayMs},volume=${a.volume}[bed${i}]`
    );
    mixIns.push(`[bed${i}]`);
  });
  filters.push(
    `${mixIns.join("")}amix=inputs=${mixIns.length}:duration=first:dropout_transition=0:normalize=0[aout]`
  );
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    outPath
  );
  execFileSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  return outPath;
}

/**
 * Audio-only export: concatenate the read's already-generated clips into one
 * MP3. No Remotion, no video — which is why this has NO page limit. MP4 export
 * is capped because rendering a feature-length video is genuinely heavy; audio
 * is just ffmpeg stitching files that already exist, so a 101-page feature
 * takes about as long as a 5-page scene.
 */
async function exportAudio({ supabase, supabaseUrl, serviceKey, scriptId }) {
  const renderId = crypto.randomUUID();
  await supabase
    .from("daily_renders")
    .insert({ id: renderId, script_id: scriptId, variant: "audio", status: "processing" });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audio-"));
  try {
    const script = await fetchScript(supabase, scriptId);

    // Price the read WITHOUT generating. The worker authenticates as service
    // role, which is exempt from credit metering — so calling the generator
    // here would hand out free regeneration after any voice swap. Export only
    // ever stitches audio the writer has already paid to generate.
    const priced = await priceVoiceCues(supabaseUrl, serviceKey, scriptId);
    if (!priced || !priced.manifest_path) throw new Error("voice manifest not available");
    if ((priced.new_lines ?? 0) > 0) {
      throw new Error(
        `${priced.new_lines} line(s) haven't been generated yet — play the read to finish generating, then export`
      );
    }
    // Everything is cached, so this writes the manifest (if a voice swap moved
    // it to a new key) and generates nothing.
    const cues = await ensureVoiceCues(supabaseUrl, serviceKey, scriptId);
    const manifest = await fetchManifest(supabase, cues?.manifest_path || priced.manifest_path);
    if (!manifest.length) throw new Error("no generated audio for this script yet");

    // Manifest order IS playback order; sort defensively.
    const ordered = [...manifest].sort((a, b) => a.element_index - b.element_index);
    const signed = await signPaths(supabase, "scripts", ordered.map((m) => m.audio_path));

    const { execFileSync } = require("child_process");

    // Download concurrently — a feature is well over a thousand clips, and one
    // at a time made the job eight minutes of pure waiting. Filenames carry the
    // playback index so order survives out-of-order completion.
    const targets = ordered
      .map((m, idx) => ({ idx, url: signed.get(m.audio_path) }))
      .filter((t) => t.url);
    const got = new Array(targets.length).fill(null);
    const DL_CONCURRENCY = 12;
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(DL_CONCURRENCY, targets.length) }, async () => {
        for (;;) {
          const n = cursor++;
          if (n >= targets.length) return;
          const t = targets[n];
          const clip = path.join(tmp, `${String(t.idx).padStart(6, "0")}.mp3`);
          try {
            const res = await fetch(t.url);
            if (!res.ok) continue;
            const buf = Buffer.from(await res.arrayBuffer());
            if (!buf.length) continue;
            fs.writeFileSync(clip, buf);
            got[n] = clip;
          } catch (_) {
            /* a dropped clip shouldn't sink the whole export */
          }
        }
      })
    );

    const listPath = path.join(tmp, "list.txt");
    // ffmpeg concat needs single quotes escaped in paths
    const lines = got.filter(Boolean).map((c) => `file '${c.replace(/'/g, "'\\''")}'`);
    if (!lines.length) throw new Error("no clips could be fetched");
    const missing = targets.length - lines.length;
    if (missing) console.warn(`${missing} clip(s) couldn't be fetched — exporting without them`);
    fs.writeFileSync(listPath, lines.join("\n"));

    const outPath = path.join(tmp, "out.mp3");
    // -c copy: every clip is the same codec/bitrate, so this is a fast stream
    // copy rather than a re-encode.
    execFileSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    const storagePath = `${scriptId}/audio/${renderId}.mp3`;
    const { error: upErr } = await supabase.storage
      .from("daily-renders")
      .upload(storagePath, fs.readFileSync(outPath), { contentType: "audio/mpeg", upsert: true });
    if (upErr) throw upErr;

    await supabase
      .from("daily_renders")
      .update({
        status: "ready",
        video_path: storagePath,
        title: script.title,
        rendered_at: new Date().toISOString(),
      })
      .eq("id", renderId);

    // Retire older audio exports for this script (files gone, rows kept).
    try {
      await retireOldExports(supabase, { scriptId, variant: "audio", renderId });
    } catch (e) {
      console.warn("audio cleanup failed (non-fatal):", (e && e.message) || e);
    }

    console.log(`✓ audio ${renderId} ready: ${storagePath} (${lines.length} clips)`);
    await notifyExportReady(supabaseUrl, serviceKey, renderId);
    return { renderId, video_path: storagePath, clips: lines.length };
  } catch (e) {
    await supabase
      .from("daily_renders")
      .update({ status: "failed", error: String((e && e.message) || e) })
      .eq("id", renderId);
    throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Render a script → MP4 → private daily-renders bucket → daily_renders row.
async function renderScene({ supabase, supabaseUrl, serviceKey, scriptId, variant = "ai", submissionIds }) {
  const renderId = crypto.randomUUID();
  await supabase.from("daily_renders").insert({ id: renderId, script_id: scriptId, variant, status: "processing" });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "render-"));
  try {
    const { script, ambience, props } = await buildProps({ supabase, supabaseUrl, serviceKey, scriptId, variant, submissionIds });
    const serveUrl = await getBundle();
    const composition = await selectComposition({ serveUrl, id: "DailyScene", inputProps: props });
    let outPath = path.join(tmp, "out.mp4");
    await renderMedia({
      serveUrl,
      composition,
      codec: "h264",
      outputLocation: outPath,
      inputProps: props,
      concurrency: Math.min(os.cpus().length, 4),
      chromiumOptions: { gl: "swiftshader", headless: true },
    });

    // Scene beds (music/ambience) mix in AFTER the render — a plain ffmpeg
    // pass we fully control. A bed failure shouldn't kill the render.
    if (ambience.length) {
      try {
        outPath = postMixAmbience(outPath, path.join(tmp, "out-mixed.mp4"), ambience, props.fps);
        console.log(`ambience mixed: ${ambience.length} bed(s)`);
      } catch (e) {
        console.error("ambience post-mix failed (rendering without beds):", e.message);
      }
    }

    const storagePath = `${scriptId}/${variant}/${renderId}.mp4`;
    const { error: upErr } = await supabase.storage
      .from("daily-renders")
      .upload(storagePath, fs.readFileSync(outPath), { contentType: "video/mp4", upsert: true });
    if (upErr) throw upErr;

    // Audio-only sibling (same path, .mp3) so the writer export offers an MP3
    // download alongside the MP4. Best-effort — an extract failure never kills
    // the render (the MP4 already uploaded; export-read hides a missing MP3).
    try {
      const { execFileSync } = require("child_process");
      const mp3Path = path.join(tmp, "out.mp3");
      execFileSync(
        "ffmpeg",
        ["-y", "-i", outPath, "-vn", "-c:a", "libmp3lame", "-q:a", "4", mp3Path],
        { stdio: ["ignore", "ignore", "pipe"] }
      );
      const { error: mp3Err } = await supabase.storage
        .from("daily-renders")
        .upload(storagePath.replace(/\.mp4$/, ".mp3"), fs.readFileSync(mp3Path), {
          contentType: "audio/mpeg",
          upsert: true,
        });
      if (mp3Err) throw mp3Err;
      console.log("  mp3 sibling uploaded");
    } catch (e) {
      console.warn("mp3 extract/upload failed (non-fatal):", (e && e.message) || e);
    }

    await supabase
      .from("daily_renders")
      .update({
        status: "ready",
        video_path: storagePath,
        title: script.title,
        duration_frames: composition.durationInFrames,
        fps: props.fps,
        rendered_at: new Date().toISOString(),
      })
      .eq("id", renderId);

    // Keep only this render for the scene+variant — delete superseded ones and
    // their videos so re-renders replace instead of piling up in the admin panel.
    // ONLY rows created before this one count as superseded: two concurrent
    // re-renders (e.g. a double-clicked button) otherwise each delete the
    // other's row — both vanish and the admin card disappears entirely.
    try {
      const { data: mine } = await supabase
        .from("daily_renders")
        .select("created_at")
        .eq("id", renderId)
        .single();
      await retireOldExports(supabase, {
        scriptId,
        variant,
        renderId,
        newerThanOnly: mine?.created_at ?? new Date(0).toISOString(),
      });
    } catch (e) {
      console.warn("cleanup of old renders failed (non-fatal):", (e && e.message) || e);
    }

    console.log(`✓ render ${renderId} ready: ${storagePath} (${composition.durationInFrames} frames)`);
    await notifyExportReady(supabaseUrl, serviceKey, renderId);
    return { renderId, video_path: storagePath, duration_frames: composition.durationInFrames };
  } catch (e) {
    await supabase
      .from("daily_renders")
      .update({ status: "failed", error: String((e && e.message) || e) })
      .eq("id", renderId);
    throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { renderScene, exportAudio, buildProps, getBundle, postMixAmbience };
