// @supabase/supabase-js (realtime) needs a global WebSocket; Node < 22 has none,
// so polyfill from `ws` to run on the GitHub Actions Node 20 runner. On Node 22+
// (native WebSocket) this is a no-op.
if (typeof globalThis.WebSocket === "undefined") {
  try {
    globalThis.WebSocket = require("ws");
  } catch (_) {
    /* native WebSocket present */
  }
}
const { createClient } = require("@supabase/supabase-js");

// Service-role data access for the render pipeline (reads private buckets, signs
// URLs for headless Chrome). Never exposed to the client.
function makeClient(url, serviceKey) {
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

async function fetchScript(supabase, scriptId) {
  const { data, error } = await supabase
    .from("scripts")
    .select("id, title, parsed_json, voice_config, ambience_config, full_read_unlocked")
    .eq("id", scriptId)
    .single();
  if (error) throw error;
  return data;
}

// Drive generate-voice-cues to completion (resumable, like prepareVoiceCues),
// then return its final response ({ manifest_path, total_lines, done, ... }).
async function ensureVoiceCues(supabaseUrl, serviceKey, scriptId) {
  let last;
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${supabaseUrl}/functions/v1/generate-voice-cues`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ script_id: scriptId }),
    });
    last = await res.json();
    if (last.error) throw new Error("generate-voice-cues: " + last.error);
    if (last.done) return last;
  }
  return last;
}

// Dry-run generate-voice-cues: resolves the manifest path and how many lines
// are still ungenerated, without generating (or spending) anything.
async function priceVoiceCues(supabaseUrl, serviceKey, scriptId) {
  const res = await fetch(`${supabaseUrl}/functions/v1/generate-voice-cues`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ script_id: scriptId, dry_run: true }),
  });
  const out = await res.json();
  if (out.error) throw new Error("generate-voice-cues (dry run): " + out.error);
  return out;
}

async function fetchManifest(supabase, manifestPath) {
  const { data, error } = await supabase.storage.from("scripts").download(manifestPath);
  if (error) throw error;
  const text = await data.text();
  return JSON.parse(text); // [{ element_index, audio_path, text, voice_id, type, character }]
}

// createSignedUrls rejects more than 1000 paths per call, and a feature-length
// read runs to several thousand clips — so batch. (Same 1000-item ceiling that
// made storage.list() silently under-report the audio cache.)
const SIGN_BATCH = 500;

async function signPaths(supabase, bucket, paths, ttl = 21600) {
  const uniq = [...new Set(paths.filter(Boolean))];
  const map = new Map();
  if (!uniq.length) return map;
  for (let i = 0; i < uniq.length; i += SIGN_BATCH) {
    const batch = uniq.slice(i, i + SIGN_BATCH);
    const { data, error } = await supabase.storage.from(bucket).createSignedUrls(batch, ttl);
    if (error) throw error;
    batch.forEach((p, j) => map.set(p, (data && data[j] && data[j].signedUrl) || ""));
  }
  return map;
}

// Composite variant: element_index → clip {clip_url, trim_start?, trim_end?, volume?}
async function fetchClips(supabase, scriptId, submissionIds) {
  let q = supabase.from("submissions").select("id, clips").eq("script_id", scriptId);
  if (submissionIds && submissionIds.length) q = q.in("id", submissionIds);
  const { data } = await q;
  const byIdx = new Map();
  for (const s of data || []) for (const c of s.clips || []) byIdx.set(c.element_index, c);
  return byIdx;
}

module.exports = {
  makeClient,
  fetchScript,
  ensureVoiceCues,
  priceVoiceCues,
  fetchManifest,
  signPaths,
  fetchClips,
};
