const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { bundle } = require("@remotion/bundler");
const { selectComposition, renderMedia } = require("@remotion/renderer");
const { fetchScript, ensureVoiceCues, fetchManifest, signPaths, fetchClips } = require("./supabaseData");
const { probeAll } = require("./probe");
const { buildRows, buildTimeline } = require("./timeline");

const ENTRY = path.join(__dirname, "..", "remotion", "src", "index.ts");

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
  return { script, props: { fps, variant, script: { id: script.id, title: script.title }, segments } };
}

// Render a script → MP4 → private daily-renders bucket → daily_renders row.
async function renderScene({ supabase, supabaseUrl, serviceKey, scriptId, variant = "ai", submissionIds }) {
  const renderId = crypto.randomUUID();
  await supabase.from("daily_renders").insert({ id: renderId, script_id: scriptId, variant, status: "processing" });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "render-"));
  try {
    const { script, props } = await buildProps({ supabase, supabaseUrl, serviceKey, scriptId, variant, submissionIds });
    const serveUrl = await getBundle();
    const composition = await selectComposition({ serveUrl, id: "DailyScene", inputProps: props });
    const outPath = path.join(tmp, "out.mp4");
    await renderMedia({
      serveUrl,
      composition,
      codec: "h264",
      outputLocation: outPath,
      inputProps: props,
      concurrency: Math.min(os.cpus().length, 4),
      chromiumOptions: { gl: "swiftshader", headless: true },
    });

    const storagePath = `${scriptId}/${variant}/${renderId}.mp4`;
    const { error: upErr } = await supabase.storage
      .from("daily-renders")
      .upload(storagePath, fs.readFileSync(outPath), { contentType: "video/mp4", upsert: true });
    if (upErr) throw upErr;

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
    try {
      const { data: stale } = await supabase
        .from("daily_renders")
        .select("id, video_path")
        .eq("script_id", scriptId)
        .eq("variant", variant)
        .neq("id", renderId);
      const paths = (stale || []).map((s) => s.video_path).filter(Boolean);
      if (paths.length) await supabase.storage.from("daily-renders").remove(paths);
      const ids = (stale || []).map((s) => s.id);
      if (ids.length) {
        await supabase.from("daily_renders").delete().in("id", ids);
        console.log(`  cleaned up ${ids.length} superseded render(s)`);
      }
    } catch (e) {
      console.warn("cleanup of old renders failed (non-fatal):", (e && e.message) || e);
    }

    console.log(`✓ render ${renderId} ready: ${storagePath} (${composition.durationInFrames} frames)`);
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

module.exports = { renderScene, buildProps, getBundle };
