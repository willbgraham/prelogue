const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { bundle } = require("@remotion/bundler");
const { selectComposition, renderMedia, combineChunks } = require("@remotion/renderer");
const {
  fetchScript,
  ensureVoiceCues,
  priceVoiceCues,
  fetchManifest,
  signPaths,
  fetchClips,
} = require("./supabaseData");
const { probeAll } = require("./probe");
const { buildRows, buildTimeline, fpsFor, encodingFor, planParts, FPS, SINGLE_JOB_MAX_SECONDS } = require("./timeline");
const { createReporter, renderFraction, partsJobSeconds } = require("./progress");
const { renderInParts, removeDir, dirFor, PartsUnavailable } = require("./parts");
const { noteRenderId } = require("./supervise");
const ff = require("./ff");

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

  // Measure the read, then lay it out at the frame rate that lets the whole
  // video render inside one job (30 a second, fewer for a very long read).
  const timing = { manifestByIdx, clipsByIdx, durationByKey, signedByKey };
  const measured = buildTimeline(rows, timing);
  const chosenFps = fpsFor(measured.seconds);
  if (!chosenFps) {
    const hours = (measured.seconds / 3600).toFixed(1);
    throw new Error(
      `this read runs about ${hours} hours, longer than we can render as one video — the MP3 is the complete read, and we can render the video for you on request (hello@prelogue.studio)`
    );
  }
  const { fps, segments } =
    chosenFps === measured.fps ? measured : buildTimeline(rows, { ...timing, fps: chosenFps });
  if (fps !== measured.fps) {
    console.log(`long read (${Math.round(measured.seconds / 60)} min): rendering at ${fps} frames a second`);
  }

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
      const ranges = new Map(); // sceneIndex → { start, end } in frames of the MEASURED timeline
      for (const s of measured.segments) {
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

  const propsAt = (rate) => ({
    fps: rate,
    variant,
    script: { id: script.id, title: script.title },
    segments: rate === fps ? segments : buildTimeline(rows, { ...timing, fps: rate }).segments,
  });
  return {
    script,
    ambience,
    // The beds' start and length are in frames of the measured timeline, so
    // they land in the same place whatever frame rate the video is rendered at.
    ambienceFps: measured.fps,
    seconds: measured.seconds,
    props: propsAt(fps), // laid out for one job (see fpsFor)
    propsAt, // …or at any other frame rate, without measuring again
  };
}

/**
 * One bed, fetched and decoded once to uncompressed audio so it can be repeated
 * exactly. Returns the file and how long it runs, or null if the bed can't be
 * read.
 */
async function decodeBed(src, wavPath) {
  try {
    const { file } = await ff.localCopy(src, path.dirname(wavPath));
    ff.execFileSync("ffmpeg", ["-y", "-i", file, "-vn", "-c:a", "pcm_s24le", wavPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const out = ff.execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", wavPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const seconds = parseFloat(String(out).trim());
    return Number.isFinite(seconds) && seconds > 0.05 ? { wav: wavPath, seconds } : null;
  } catch (e) {
    console.warn("a scene bed could not be read (left out of the mix):", String((e && e.message) || e).slice(0, 200));
    return null;
  }
}

// Mix the scene beds under the rendered video's audio with ffmpeg: each bed
// loops for its scene's duration, delayed to the scene's start, at the
// writer's volume. Video stream is copied untouched. Returns the mixed path.
//
// A bed is looped by decoding it once and listing that file as many times as
// the scene needs. It used to be looped with ffmpeg's `aloop` filter, which
// the renderer's ffmpeg (see ff.js) does not have; nor does `-stream_loop -1`
// loop in it, and looping the MP3 itself leaves a gap at every seam. Measured
// against the `aloop` mix made by a full ffmpeg: the same audio, to within one
// step of the 16-bit scale.
async function postMixAmbience(inPath, outPath, ambience, fps, audioKbps = 192) {
  const dir = path.dirname(outPath);
  const decoded = new Map(); // a bed's address → { wav, seconds }, or null if unreadable
  const args = ["-y", "-i", inPath];
  const filters = [];
  const mixIns = ["[0:a]"];
  let n = 0;
  for (const a of ambience) {
    if (!decoded.has(a.src)) decoded.set(a.src, await decodeBed(a.src, path.join(dir, `bed-${decoded.size}.wav`)));
    const bed = decoded.get(a.src);
    if (!bed) continue; // the other beds still play
    const delayMs = Math.round((a.startFrame / fps) * 1000);
    const durSec = a.durationFrames / fps;
    // Enough passes to cover the scene, and one to spare; trimmed exactly below.
    const passes = Math.min(100000, Math.ceil(durSec / bed.seconds) + 1);
    const listPath = path.join(dir, `bed-list-${n}.txt`);
    const line = `file '${bed.wav.replace(/'/g, "'\\''")}'`;
    fs.writeFileSync(listPath, `${Array(passes).fill(line).join("\n")}\n`);
    args.push("-f", "concat", "-safe", "0", "-i", listPath);
    n++;
    filters.push(
      `[${n}:a]atrim=0:${durSec.toFixed(3)},adelay=${delayMs}|${delayMs},volume=${a.volume}[bed${n}]`
    );
    mixIns.push(`[bed${n}]`);
  }
  if (n === 0) throw new Error("none of the scene beds could be read");
  filters.push(
    `${mixIns.join("")}amix=inputs=${mixIns.length}:duration=first:dropout_transition=0:normalize=0[aout]`
  );
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", `${audioKbps}k`,
    "-movflags", "+faststart",
    outPath
  );
  ff.execFileSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
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
  noteRenderId(renderId);
  // The export card's percentage and time left (see progress.js).
  const reporter = createReporter({ supabase, scriptId, renderId, kind: "audio" });
  reporter.stage("preparing");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audio-"));
  try {
    const script = await fetchScript(supabase, scriptId);

    // Price the read WITHOUT generating. The worker authenticates as service
    // role, which is exempt from credit metering — so calling the generator
    // here would hand out free regeneration after any voice swap. Export only
    // ever stitches audio the writer has already paid to generate.
    const priced = await priceVoiceCues(supabaseUrl, serviceKey, scriptId);
    if (!priced || !priced.manifest_path) throw new Error("voice manifest not available");
    // `new_lines` is only the next run's share (at most 80); `missing_lines`
    // is every line the read lacks. An older server sends only the former.
    const unvoiced = priced.missing_lines ?? (priced.new_lines ?? 0) + (priced.remaining_after_run ?? 0);
    if (unvoiced > 0) {
      // The export card voices a read before it starts this job, so this is a
      // page loaded before it learned to, or voices changed in the last minute.
      throw new Error(
        `${unvoiced} ${unvoiced === 1 ? "line of this read isn't" : "lines of this read aren't"} voiced yet. Reload this page, then press Prepare MP3: it voices them first`
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

    // Download concurrently — a feature is well over a thousand clips, and one
    // at a time made the job eight minutes of pure waiting. Filenames carry the
    // playback index so order survives out-of-order completion.
    const targets = ordered
      .map((m, idx) => ({ idx, url: signed.get(m.audio_path) }))
      .filter((t) => t.url);
    const got = new Array(targets.length).fill(null);
    const DL_CONCURRENCY = 12;
    let cursor = 0;
    let fetched = 0;
    reporter.setLines(targets.length);
    reporter.stage("collecting", 0);
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
          } finally {
            reporter.progress(++fetched / targets.length);
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
    reporter.stage("stitching");
    // -c copy: every clip is the same codec/bitrate, so this is a fast stream
    // copy rather than a re-encode.
    ff.execFileSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    reporter.stage("uploading");
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
    await reporter.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Render a script → MP4 → private daily-renders bucket → daily_renders row.
// forceParts / startParts / partOptions exist for tests (split a short video;
// start the part jobs some other way; shorter waits).
async function renderScene({
  supabase,
  supabaseUrl,
  serviceKey,
  scriptId,
  variant = "ai",
  submissionIds,
  forceParts,
  startParts,
  partOptions,
  singleJobMaxSeconds = SINGLE_JOB_MAX_SECONDS,
}) {
  const renderId = crypto.randomUUID();
  await supabase.from("daily_renders").insert({ id: renderId, script_id: scriptId, variant, status: "processing" });
  noteRenderId(renderId); // so a job that is killed outright can still be recorded as failed (supervise.js)
  // The export card's percentage and time left (see progress.js).
  const reporter = createReporter({ supabase, scriptId, renderId, kind: "video" });
  reporter.stage("preparing");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "render-"));
  try {
    const built = await buildProps({ supabase, supabaseUrl, serviceKey, scriptId, variant, submissionIds });
    const { script, ambience, ambienceFps } = built;
    const serveUrl = await getBundle();
    let props = built.props;
    let composition = null;
    let held = {};
    let outPath = null;

    // Long enough to be worth several jobs at once? Then it is laid out at the
    // full 30 frames a second (no one job comes near its limit) and rendered in
    // parts. If the other jobs can't be started, it falls through to one job.
    if (planParts(Math.ceil(built.seconds * FPS), forceParts).parts > 1) {
      const partProps = built.propsAt(FPS);
      const partComposition = await selectComposition({ serveUrl, id: "DailyScene", inputProps: partProps });
      const plan = planParts(partComposition.durationInFrames, forceParts);
      if (plan.parts > 1) {
        const seconds = partComposition.durationInFrames / FPS;
        const partHeld = encodingFor(seconds);
        reporter.setVideoSeconds(seconds, FPS);
        reporter.setExpectedSeconds(partsJobSeconds(seconds, plan.parts));
        reporter.stage("rendering", 0);
        try {
          outPath = await renderInParts({
            supabase,
            supabaseUrl,
            serviceKey,
            scriptId,
            renderId,
            variant,
            props: partProps,
            composition: partComposition,
            held: partHeld,
            plan,
            serveUrl,
            tmp,
            reporter,
            renderer: { renderMedia, selectComposition, combineChunks },
            startParts,
            options: partOptions,
          });
          props = partProps;
          composition = partComposition;
          held = partHeld;
        } catch (e) {
          if (!(e instanceof PartsUnavailable)) throw e;
          // One process cannot hold a video this long (SINGLE_JOB_MAX_SECONDS in timeline.js):
          // say so now, rather than start a render that dies hours in.
          if (seconds > singleJobMaxSeconds) {
            console.error(`not rendering on one job (${Math.round(seconds / 60)} min of video): ${e.message}`);
            throw new Error("the render jobs could not be started just now");
          }
          console.warn(`rendering on one job instead: ${e.message}`);
        }
      }
    }

    if (!outPath) {
    composition = await selectComposition({ serveUrl, id: "DailyScene", inputProps: props });
    outPath = path.join(tmp, "out.mp4");
    const videoSeconds = composition.durationInFrames / props.fps;
    // Held to a rate that keeps a long video's file within one upload; {} for
    // anything of ordinary length, which encodes exactly as before.
    held = encodingFor(videoSeconds);
    if (held.videoKbps) {
      console.log(`long video: encoder held to ${held.videoKbps}k video, ${held.audioKbps}k audio`);
    }
    reporter.setVideoSeconds(videoSeconds, props.fps);
    reporter.setExpectedSeconds(0);
    reporter.stage("rendering", 0);
    await renderMedia({
      serveUrl,
      composition,
      codec: "h264",
      outputLocation: outPath,
      inputProps: props,
      concurrency: Math.min(os.cpus().length, 4),
      chromiumOptions: { gl: "swiftshader", headless: true },
      ...(held.videoKbps
        ? {
            audioBitrate: `${held.audioKbps}k`,
            encodingMaxRate: `${held.videoKbps}k`,
            encodingBufferSize: `${held.videoKbps * 2}k`,
          }
        : {}),
      onProgress: (frames) =>
        reporter.progress(renderFraction(frames, composition.durationInFrames)),
    });
    }

    reporter.stage("finishing");
    // Scene beds (music/ambience) mix in AFTER the render — a plain ffmpeg
    // pass we fully control. A bed failure shouldn't kill the render.
    if (ambience.length) {
      try {
        outPath = await postMixAmbience(outPath, path.join(tmp, "out-mixed.mp4"), ambience, ambienceFps, held.audioKbps);
        console.log(`ambience mixed: ${ambience.length} bed(s)`);
      } catch (e) {
        console.error("ambience post-mix failed (rendering without beds):", e.message);
      }
    }

    reporter.stage("uploading");
    const storagePath = `${scriptId}/${variant}/${renderId}.mp4`;
    const { error: upErr } = await supabase.storage
      .from("daily-renders")
      .upload(storagePath, fs.readFileSync(outPath), { contentType: "video/mp4", upsert: true });
    if (upErr) throw upErr;
    reporter.stage("uploading", 0.6);

    // Audio-only sibling (same path, .mp3) so the writer export offers an MP3
    // download alongside the MP4. Best-effort — an extract failure never kills
    // the render (the MP4 already uploaded; export-read hides a missing MP3).
    try {
      const mp3Path = path.join(tmp, "out.mp3");
      ff.execFileSync(
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
    await removeDir(supabase, dirFor(scriptId, renderId)); // the parts, if it was rendered in parts
    await reporter.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { renderScene, exportAudio, buildProps, getBundle, postMixAmbience };
