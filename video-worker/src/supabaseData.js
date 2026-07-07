const { createClient } = require("@supabase/supabase-js");

// Service-role data access for the render pipeline (reads private buckets, signs
// URLs for headless Chrome). Never exposed to the client.
function makeClient(url, serviceKey) {
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

async function fetchScript(supabase, scriptId) {
  const { data, error } = await supabase
    .from("scripts")
    .select("id, title, parsed_json, voice_config, full_read_unlocked")
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

async function fetchManifest(supabase, manifestPath) {
  const { data, error } = await supabase.storage.from("scripts").download(manifestPath);
  if (error) throw error;
  const text = await data.text();
  return JSON.parse(text); // [{ element_index, audio_path, text, voice_id, type, character }]
}

async function signPaths(supabase, bucket, paths, ttl = 21600) {
  const uniq = [...new Set(paths.filter(Boolean))];
  const map = new Map();
  if (!uniq.length) return map;
  const { data, error } = await supabase.storage.from(bucket).createSignedUrls(uniq, ttl);
  if (error) throw error;
  uniq.forEach((p, i) => map.set(p, (data && data[i] && data[i].signedUrl) || ""));
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

module.exports = { makeClient, fetchScript, ensureVoiceCues, fetchManifest, signPaths, fetchClips };
