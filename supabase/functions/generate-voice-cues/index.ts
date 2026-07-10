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

// ElevenLabs generation settings (mirror the picker's sliders). Defaults match
// the historical hardcoded values so existing cached audio stays valid.
const DEFAULT_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0, speed: 1.0 };
const clampNum = (v: unknown, d: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, typeof v === "number" && isFinite(v) ? v : d));

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
  supabase: any,
  voiceSettings: Record<string, number>
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
            voice_settings: voiceSettings,
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

    // Only the writer (or the public demo) may override the saved voices; for
    // everyone else the override is ignored and the writer's configured voices
    // play. Stops non-writers burning TTS credits re-casting a paid script.
    const DEMO_SCRIPT_ID = "b0078900-0000-4000-8000-000000000009";
    let callerId: string | null = null;
    const authHeader = req.headers.get("Authorization");
    if (authHeader) {
      const {
        data: { user: caller },
      } = await createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } }
      ).auth.getUser();
      callerId = caller?.id ?? null;
    }
    const allowOverride =
      script_id === DEMO_SCRIPT_ID || (!!callerId && callerId === script.writer_id);

    // The override (visitor voice-picking) wins only when allowed; the
    // content-addressed manifest hash keys on the resolved config, so an
    // override yields its own manifest and reuses any cached per-voice audio.
    const cfg = (((allowOverride ? voiceConfigOverride : null) ?? script.voice_config) as any) || {};
    const mode: "single" | "per_character" =
      cfg.mode === "single" ? "single" : "per_character";
    const narratorVoiceId: string = cfg.narrator_voice_id || DEFAULT_NARRATOR;
    const singleVoiceId: string =
      cfg.single_voice_id || cfg.narrator_voice_id || FALLBACK_VOICES[0];
    const charMap: Record<string, string> = cfg.characters || {};

    // Per-role voice generation settings (the picker's sliders, keyed by role:
    // UPPER-CASED character names + "__narrator__" / "__single__"). Each role
    // resolves to a TTS body (stability + similarity always; style/speed only when
    // changed) and a cache-key tag (empty at default → reuses the text-only audio,
    // so default reads generate byte-identical audio and skip needless work).
    const roleSettings = (cfg.role_settings as Record<string, Record<string, unknown>>) || {};
    const NARRATOR_KEY = "__narrator__";
    const SINGLE_KEY = "__single__";
    const settingsCache = new Map<string, { body: Record<string, number>; tag: string }>();
    const resolveSettings = (roleKey: string) => {
      const cached = settingsCache.get(roleKey);
      if (cached) return cached;
      const raw = roleSettings[roleKey] || {};
      const s = {
        stability: clampNum(raw.stability, DEFAULT_SETTINGS.stability, 0, 1),
        similarity_boost: clampNum(raw.similarity_boost, DEFAULT_SETTINGS.similarity_boost, 0, 1),
        style: clampNum(raw.style, DEFAULT_SETTINGS.style, 0, 1),
        speed: clampNum(raw.speed, DEFAULT_SETTINGS.speed, 0.7, 1.2),
      };
      const isDefault =
        s.stability === DEFAULT_SETTINGS.stability &&
        s.similarity_boost === DEFAULT_SETTINGS.similarity_boost &&
        s.style === DEFAULT_SETTINGS.style &&
        s.speed === DEFAULT_SETTINGS.speed;
      const body: Record<string, number> = {
        stability: s.stability,
        similarity_boost: s.similarity_boost,
      };
      if (s.style !== DEFAULT_SETTINGS.style) body.style = s.style;
      if (s.speed !== DEFAULT_SETTINGS.speed) body.speed = s.speed;
      const tag = isDefault
        ? ""
        : `_s${Math.round(s.stability * 100)}b${Math.round(s.similarity_boost * 100)}y${Math.round(
            s.style * 100
          )}v${Math.round(s.speed * 100)}`;
      const resolved = { body, tag };
      settingsCache.set(roleKey, resolved);
      return resolved;
    };

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
      audio_key: string; // voiceId/hash(/settingsTag) for existence checks
      settings: Record<string, number>; // ElevenLabs voice_settings for this line
    }
    const entries: Entry[] = [];
    let globalIdx = 0;
    const effChars: Record<string, string> = {};
    const effSettings: Record<string, string> = {}; // role → non-default tag (manifest hash)

    for (const scene of scenes) {
      for (const el of scene.elements ?? []) {
        const myIndex = globalIdx++;
        const norm = normalizeText(el.text);
        if (el.type === "dialogue" && norm) {
          const roleKey = mode === "single" ? SINGLE_KEY : (el.character_name || "").toUpperCase();
          const voiceId = mode === "single" ? singleVoiceId : characterVoice(el.character_name);
          effChars[(el.character_name || "").toUpperCase()] = voiceId;
          const { body, tag } = resolveSettings(roleKey);
          if (tag) effSettings[roleKey] = tag;
          const hash = await sha1(norm);
          entries.push({
            element_index: myIndex,
            type: "dialogue",
            character: el.character_name ?? null,
            text: norm,
            voice_id: voiceId,
            audio_path: `voice-cues/audio/${voiceId}/${hash}${tag}.mp3`,
            audio_key: `${voiceId}/${hash}${tag}`,
            settings: body,
          });
        } else if (el.type === "action" && norm) {
          const roleKey = mode === "single" ? SINGLE_KEY : NARRATOR_KEY;
          const voiceId = mode === "single" ? singleVoiceId : narratorVoiceId;
          const { body, tag } = resolveSettings(roleKey);
          if (tag) effSettings[roleKey] = tag;
          const hash = await sha1(norm);
          entries.push({
            element_index: myIndex,
            type: "action",
            character: null,
            text: norm,
            voice_id: voiceId,
            audio_path: `voice-cues/audio/${voiceId}/${hash}${tag}.mp3`,
            audio_key: `${voiceId}/${hash}${tag}`,
            settings: body,
          });
        }
        // character / parenthetical: index consumed, no audio entry
      }
    }

    // Free tier: voice only the opening of the script.
    if (locked && entries.length > FREE_PREVIEW_LIMIT) {
      entries.length = FREE_PREVIEW_LIMIT;
    }

    // Content digest over the ordered audible stream (index/type/character/text)
    // so ANY line edit — reassign, reorder, merge, split, text change, delete —
    // produces a new manifest key. Without this the manifest keyed only on the
    // voice config, so editing parsed_json would replay stale audio against the
    // new lines. Per-line audio is still content-addressed, so unchanged lines
    // are reused; only genuinely changed lines regenerate.
    const contentDigest = (
      await sha1(
        entries.map((e) => `${e.element_index}|${e.type}|${e.character ?? ""}|${e.text}`).join("\n")
      )
    ).slice(0, 16);

    // Config hash over the output-affecting fields (canonical/sorted) + content.
    // Fold in only the roles whose settings are non-default, so an all-default
    // read keeps its existing manifest key (no needless regeneration) while any
    // per-role change gets its own manifest.
    const settingsKey = Object.keys(effSettings).length ? { role_settings: effSettings } : {};
    const hashInput =
      mode === "single"
        ? { mode, single_voice_id: singleVoiceId, content: contentDigest, ...settingsKey }
        : { mode, narrator_voice_id: narratorVoiceId, characters: effChars, content: contentDigest, ...settingsKey };
    const voiceConfigHash = (await sha1(canonical(hashInput))).slice(0, 16);
    const manifestPath = `voice-cues/script/${script_id}/${voiceConfigHash}/manifest.json`;

    // Existence check: list cached hashes per distinct voice.
    const distinctJobs = new Map<
      string,
      { voiceId: string; text: string; path: string; settings: Record<string, number> }
    >();
    for (const e of entries) {
      if (!distinctJobs.has(e.audio_key)) {
        distinctJobs.set(e.audio_key, {
          voiceId: e.voice_id,
          text: e.text,
          path: e.audio_path,
          settings: e.settings,
        });
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
        batch.map(([, job]) => ttsAndUpload(job, supabase, job.settings))
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
