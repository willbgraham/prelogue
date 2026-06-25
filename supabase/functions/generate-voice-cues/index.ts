import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

// Default voice pool (ElevenLabs). Used as fallbacks when the writer hasn't
// configured voice_config yet.
const DEFAULT_NARRATOR = "onwK4e9ZLuTAKqWW03F9"; // Daniel
const FALLBACK_VOICES = [
  "pNInz6obpgDQGcFmaJgB", // Adam
  "EXAVITQu4vr4xnSDxMaL", // Bella
  "VR6AewLTigWG4xSOukaG", // Arnold
  "jBpfuIE2acCO8z3wKNLl", // Gigi
  "onwK4e9ZLuTAKqWW03F9", // Daniel
];

const BUCKET = "scripts";
const BATCH_SIZE = 5; // parallel TTS per batch
const MAX_NEW_PER_RUN = 80; // generation cap per invocation (resumable)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizeText(t: string): string {
  return (t || "").replace(/\s+/g, " ").trim();
}

async function sha1(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Deterministic, stable per-character fallback assignment by name.
function fallbackVoiceForName(name: string): string {
  let h = 0;
  const key = (name || "").toUpperCase();
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return FALLBACK_VOICES[h % FALLBACK_VOICES.length];
}

// Canonical (key-sorted) JSON so the config hash is stable regardless of key order.
function canonical(obj: unknown): string {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const o = obj as Record<string, unknown>;
    return (
      "{" +
      Object.keys(o)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(o[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(obj);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ttsAndUpload(
  job: { voiceId: string; text: string; path: string },
  supabase: any
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(
        `${ELEVENLABS_BASE}/text-to-speech/${job.voiceId}?output_format=mp3_22050_32`,
        {
          method: "POST",
          headers: {
            "xi-api-key": ELEVENLABS_API_KEY!,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text: job.text,
            model_id: "eleven_flash_v2_5",
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
        }
      );

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 2;
        await sleep(Math.min(retryAfter, 5) * 1000);
        continue; // retry once
      }
      if (!res.ok) {
        console.error(`TTS ${res.status} for ${job.path}`);
        return false;
      }

      const audio = new Uint8Array(await res.arrayBuffer());
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(job.path, audio, { contentType: "audio/mpeg", upsert: true });
      if (error) {
        console.error("Upload error:", error.message);
        return false;
      }
      return true;
    } catch (err) {
      console.error("TTS exception:", err);
      return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { script_id, voice_config: voiceConfigOverride } = await req.json();
    if (!script_id) {
      return new Response(JSON.stringify({ error: "script_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!ELEVENLABS_API_KEY) {
      return new Response(
        JSON.stringify({ error: "ELEVENLABS_API_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Fetch parsed script + voice config
    const { data: script, error: scriptErr } = await supabase
      .from("scripts")
      .select("parsed_json, voice_config, writer_id, full_read_unlocked")
      .eq("id", script_id)
      .single();

    if (scriptErr || !script) {
      return new Response(JSON.stringify({ error: "Script not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const parsed = script.parsed_json as any;
    const scenes: any[] = parsed?.scenes ?? [];
    const hasElements = scenes.some((s) => (s.elements?.length ?? 0) > 0);
    if (!hasElements) {
      return new Response(
        JSON.stringify({
          error: "Script has no parsed elements — re-parse required",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ----- Unlock gate -----
    // A script's full read is unlocked by a one-time purchase
    // (scripts.full_read_unlocked, flipped by the Stripe webhook). Until then
    // only a short opening preview is voiced. Enforced here (service role) so
    // it can't be bypassed from the client.
    const FREE_PREVIEW_LIMIT = 30; // spoken elements voiced before unlock
    const fullAccess = (script as any).full_read_unlocked === true;
    const locked = !fullAccess;

    // Resolve voice configuration. An optional per-request override (visitor
    // voice-picking on the web) wins over the script's saved config; the
    // content-addressed manifest hash already keys on this, so an override
    // yields its own manifest and reuses any cached per-voice audio.
    const cfg = ((voiceConfigOverride ?? script.voice_config) as any) || {};
    const mode: "single" | "per_character" =
      cfg.mode === "single" ? "single" : "per_character";
    const narratorVoiceId: string = cfg.narrator_voice_id || DEFAULT_NARRATOR;
    const singleVoiceId: string =
      cfg.single_voice_id || cfg.narrator_voice_id || FALLBACK_VOICES[0];
    const charMap: Record<string, string> = cfg.characters || {};

    const characterVoice = (name?: string): string => {
      const key = (name || "").toUpperCase();
      return charMap[key] || fallbackVoiceForName(key);
    };

    // Walk the flattened element stream. The GLOBAL index counts EVERY element
    // (so it matches the client's indexing); we only create entries for
    // dialogue + action (parentheticals and speaker labels are not spoken).
    interface Entry {
      element_index: number;
      type: string;
      character: string | null;
      text: string;
      voice_id: string;
      audio_path: string;
      audio_key: string; // voiceId/hash for existence checks
    }
    const entries: Entry[] = [];
    let globalIdx = 0;
    const effChars: Record<string, string> = {};

    for (const scene of scenes) {
      for (const el of scene.elements ?? []) {
        const myIndex = globalIdx++;
        const norm = normalizeText(el.text);
        if (el.type === "dialogue" && norm) {
          const voiceId = mode === "single" ? singleVoiceId : characterVoice(el.character_name);
          effChars[(el.character_name || "").toUpperCase()] = voiceId;
          const hash = await sha1(norm);
          entries.push({
            element_index: myIndex,
            type: "dialogue",
            character: el.character_name ?? null,
            text: norm,
            voice_id: voiceId,
            audio_path: `voice-cues/audio/${voiceId}/${hash}.mp3`,
            audio_key: `${voiceId}/${hash}`,
          });
        } else if (el.type === "action" && norm) {
          const voiceId = mode === "single" ? singleVoiceId : narratorVoiceId;
          const hash = await sha1(norm);
          entries.push({
            element_index: myIndex,
            type: "action",
            character: null,
            text: norm,
            voice_id: voiceId,
            audio_path: `voice-cues/audio/${voiceId}/${hash}.mp3`,
            audio_key: `${voiceId}/${hash}`,
          });
        }
        // character / parenthetical: index consumed, no audio entry
      }
    }

    // Free tier: voice only the opening of the script.
    if (locked && entries.length > FREE_PREVIEW_LIMIT) {
      entries.length = FREE_PREVIEW_LIMIT;
    }

    // Config hash over only the output-affecting fields (canonical/sorted).
    const hashInput =
      mode === "single"
        ? { mode, single_voice_id: singleVoiceId }
        : { mode, narrator_voice_id: narratorVoiceId, characters: effChars };
    const voiceConfigHash = (await sha1(canonical(hashInput))).slice(0, 16);
    const manifestPath = `voice-cues/script/${script_id}/${voiceConfigHash}/manifest.json`;

    // Existence check: list cached hashes per distinct voice.
    const distinctJobs = new Map<string, { voiceId: string; text: string; path: string }>();
    for (const e of entries) {
      if (!distinctJobs.has(e.audio_key)) {
        distinctJobs.set(e.audio_key, { voiceId: e.voice_id, text: e.text, path: e.audio_path });
      }
    }
    const voiceIds = new Set([...distinctJobs.values()].map((j) => j.voiceId));
    const existing = new Set<string>();
    for (const vid of voiceIds) {
      const { data: objs } = await supabase.storage
        .from(BUCKET)
        .list(`voice-cues/audio/${vid}`, { limit: 1000 });
      for (const o of objs ?? []) {
        existing.add(`${vid}/${o.name.replace(/\.mp3$/, "")}`);
      }
    }

    // Generate the misses, capped per run (resumable).
    const allMisses = [...distinctJobs.entries()].filter(([k]) => !existing.has(k));
    const toDo = allMisses.slice(0, MAX_NEW_PER_RUN);
    const generatedKeys = new Set<string>();
    let failed = 0;

    for (let i = 0; i < toDo.length; i += BATCH_SIZE) {
      const batch = toDo.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(([, job]) => ttsAndUpload(job, supabase))
      );
      results.forEach((ok, j) => {
        if (ok) generatedKeys.add(batch[j][0]);
        else failed++;
      });
    }

    // An entry's audio is available if it pre-existed or we just generated it.
    const available = (key: string) => existing.has(key) || generatedKeys.has(key);
    const manifest = entries
      .filter((e) => available(e.audio_key))
      .map((e) => ({
        element_index: e.element_index,
        type: e.type,
        character: e.character,
        text: e.text,
        voice_id: e.voice_id,
        audio_path: e.audio_path,
      }));

    await supabase.storage
      .from(BUCKET)
      .upload(manifestPath, new TextEncoder().encode(JSON.stringify(manifest)), {
        contentType: "application/json",
        upsert: true,
      });

    const remaining = allMisses.length - toDo.length;
    return new Response(
      JSON.stringify({
        success: true,
        script_id,
        unlocked: fullAccess,
        locked,
        preview_limit: FREE_PREVIEW_LIMIT,
        voice_config_hash: voiceConfigHash,
        manifest_path: manifestPath,
        mode,
        total_lines: entries.length,
        generated_now: generatedKeys.size,
        already_cached: entries.length - allMisses.length,
        failed,
        remaining,
        done: remaining === 0,
        cached: allMisses.length === 0,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Voice cue generation error:", err);
    return new Response(
      JSON.stringify({ error: "Internal error", details: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
