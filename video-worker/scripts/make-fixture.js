// Build a Remotion props fixture for a script (default: Booth Nine) so we can
// render + eyeball the composition locally before wiring the service. Mirrors
// what renderScene.js will do server-side. Env: SUPABASE_URL, SR (service role).
const fs = require("fs");
const path = require("path");
const { makeClient, fetchScript, ensureVoiceCues, fetchManifest, signPaths, fetchClips } = require("../src/supabaseData");
const { probeAll } = require("../src/probe");
const { buildRows, buildTimeline } = require("../src/timeline");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SR = process.env.SR;
const SCRIPT_ID = process.env.SCRIPT_ID || "b0078900-0000-4000-8000-000000000009";
const VARIANT = process.env.VARIANT || "ai";
const OUT = process.env.OUT || path.join(__dirname, "..", "remotion", "props.booth9.json");

async function main() {
  if (!SUPABASE_URL || !SR) throw new Error("SUPABASE_URL and SR env vars are required");
  const supabase = makeClient(SUPABASE_URL, SR);

  const script = await fetchScript(supabase, SCRIPT_ID);
  console.log(`script: "${script.title}"  full_read_unlocked=${script.full_read_unlocked}`);
  const rows = buildRows(script.parsed_json);
  console.log(`rows: ${rows.length}`);

  const cues = await ensureVoiceCues(SUPABASE_URL, SR, SCRIPT_ID);
  console.log(`voice cues: ${cues.done ? "done" : "PARTIAL"}  total_lines=${cues.total_lines}  manifest=${cues.manifest_path}`);
  if (cues.total_lines != null && cues.total_lines < rows.length) {
    console.warn(`⚠ manifest covers ${cues.total_lines} lines but there are ${rows.length} rows — check full_read_unlocked`);
  }

  const manifest = await fetchManifest(supabase, cues.manifest_path);
  const manifestByIdx = new Map(manifest.map((m) => [m.element_index, m]));

  const signedByKey = await signPaths(supabase, "scripts", manifest.map((m) => m.audio_path));

  let clipsByIdx = new Map();
  if (VARIANT === "composite") {
    clipsByIdx = await fetchClips(supabase, SCRIPT_ID);
    const clipPaths = [...clipsByIdx.values()].map((c) => c.clip_url);
    const clipSigned = await signPaths(supabase, "submissions", clipPaths);
    for (const [k, v] of clipSigned) signedByKey.set(k, v);
  }

  const probeEntries = [
    ...manifest.map((m) => ({ key: m.audio_path, url: signedByKey.get(m.audio_path) })),
    ...[...clipsByIdx.values()].map((c) => ({ key: c.clip_url, url: signedByKey.get(c.clip_url) })),
  ];
  const durationByKey = await probeAll(probeEntries);

  const { fps, segments, totalFrames } = buildTimeline(rows, { manifestByIdx, clipsByIdx, durationByKey, signedByKey });
  const props = { fps, variant: VARIANT, script: { id: script.id, title: script.title }, segments };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(props, null, 2));
  const audio = segments.filter((s) => s.media && s.media.kind === "audio").length;
  const video = segments.filter((s) => s.media && s.media.kind === "video").length;
  const silent = segments.filter((s) => !s.media).length;
  console.log(`✓ ${OUT}`);
  console.log(`  ${segments.length} segments — audio:${audio} video:${video} silent:${silent}`);
  console.log(`  ${totalFrames} frames ≈ ${(totalFrames / fps).toFixed(1)}s @${fps}fps`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
