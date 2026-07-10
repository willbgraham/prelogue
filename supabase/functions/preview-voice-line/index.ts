// Preview ONE line of a script with specific ElevenLabs voice settings.
// Content-addressed exactly like generate-voice-cues (voice-cues/audio/
// {voiceId}/{sha1(text)}{settingsTag}.mp3), so a preview primes the read's
// cache: the full read later reuses the same file at zero extra TTS cost.
//
// Guards: only the script's writer (or anyone on the public demo) may preview —
// same rule as voice re-casting. Locked scripts only preview lines inside the
// free window, so this can't be used to voice a whole script line-by-line free.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

const DEMO_SCRIPT_ID = "b0078900-0000-4000-8000-000000000009";
const FREE_PREVIEW_LIMIT = 30; // must match generate-voice-cues
const BUCKET = "scripts";

const DEFAULT_NARRATOR = "onwK4e9ZLuTAKqWW03F9"; // Daniel
const FALLBACK_VOICES = [
  "pNInz6obpgDQGcFmaJgB", // Adam
  "EXAVITQu4vr4xnSDxMaL", // Bella
  "VR6AewLTigWG4xSOukaG", // Arnold
  "jBpfuIE2acCO8z3wKNLl", // Gigi
  "onwK4e9ZLuTAKqWW03F9", // Daniel
];

const DEFAULT_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0, speed: 1.0 };
const clampNum = (v: unknown, d: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, typeof v === "number" && isFinite(v) ? v : d));

function normalizeText(t: string): string {
  return (t || "").replace(/\s+/g, " ").trim();
}

async function sha1(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fallbackVoiceForName(name: string): string {
  let h = 0;
  const key = (name || "").toUpperCase();
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return FALLBACK_VOICES[h % FALLBACK_VOICES.length];
}

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
    const { script_id, element_index, voice_id, settings } = await req.json();
    if (!script_id || typeof element_index !== "number" || element_index < 0) {
      return json({ error: "script_id and element_index required" }, 400);
    }
    if (!ELEVENLABS_API_KEY) return json({ error: "ELEVENLABS_API_KEY not configured" }, 500);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: script, error: scriptErr } = await supabase
      .from("scripts")
      .select("parsed_json, voice_config, writer_id, full_read_unlocked")
      .eq("id", script_id)
      .single();
    if (scriptErr || !script) return json({ error: "Script not found" }, 404);

    // Writer-or-demo gate (same as voice re-casting in generate-voice-cues).
    if (script_id !== DEMO_SCRIPT_ID) {
      const authHeader = req.headers.get("Authorization");
      let callerId: string | null = null;
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
      if (!callerId || callerId !== script.writer_id) {
        return json({ error: "Only the writer can preview voice settings" }, 403);
      }
    }

    // Locate the element by GLOBAL index (same walk as generate-voice-cues) and
    // its ordinal among voiced entries (for the free-preview gate).
    const scenes: any[] = (script.parsed_json as any)?.scenes ?? [];
    let globalIdx = 0;
    let voicedOrdinal = 0;
    let target: { type: string; character: string | null; text: string } | null = null;
    outer: for (const scene of scenes) {
      for (const el of scene.elements ?? []) {
        const myIndex = globalIdx++;
        const norm = normalizeText(el.text);
        const voiced = (el.type === "dialogue" || el.type === "action") && !!norm;
        if (voiced) voicedOrdinal++;
        if (myIndex === element_index) {
          if (!voiced) return json({ error: "That line isn't a spoken element" }, 400);
          target = { type: el.type, character: el.character_name ?? null, text: norm };
          break outer;
        }
      }
    }
    if (!target) return json({ error: "Line not found" }, 404);

    if (!script.full_read_unlocked && voicedOrdinal > FREE_PREVIEW_LIMIT) {
      return json({ error: "Unlock the full read to preview lines past the free window" }, 403);
    }

    // Voice: explicit (the picker's current, possibly-unsaved selection) or
    // resolved from the saved config the way generate-voice-cues would.
    const cfg = (script.voice_config as any) || {};
    let vid: string | null = typeof voice_id === "string" ? voice_id : null;
    if (vid && !/^[A-Za-z0-9]{8,48}$/.test(vid)) return json({ error: "Invalid voice_id" }, 400);
    if (!vid) {
      if (cfg.mode === "single") {
        vid = cfg.single_voice_id || cfg.narrator_voice_id || FALLBACK_VOICES[0];
      } else if (target.type === "action") {
        vid = cfg.narrator_voice_id || DEFAULT_NARRATOR;
      } else {
        const key = (target.character || "").toUpperCase();
        vid = (cfg.characters || {})[key] || fallbackVoiceForName(key);
      }
    }

    // Settings → TTS body + cache tag (identical scheme to generate-voice-cues).
    const raw = (settings as Record<string, unknown>) || {};
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

    const hash = await sha1(target.text);
    const dir = `voice-cues/audio/${vid}`;
    const filename = `${hash}${tag}.mp3`;
    const path = `${dir}/${filename}`;

    // Cached already? (Preview replays and prior generations are free.)
    const { data: existing } = await supabase.storage
      .from(BUCKET)
      .list(dir, { limit: 5, search: filename });
    let cached = (existing ?? []).some((o) => o.name === filename);

    if (!cached) {
      const res = await fetch(
        `${ELEVENLABS_BASE}/text-to-speech/${vid}?output_format=mp3_22050_32`,
        {
          method: "POST",
          headers: {
            "xi-api-key": ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text: target.text,
            model_id: "eleven_flash_v2_5",
            voice_settings: body,
          }),
        }
      );
      if (!res.ok) {
        console.error(`preview TTS ${res.status} for ${path}`);
        return json({ error: `Voice generation failed (${res.status})` }, 502);
      }
      const audio = new Uint8Array(await res.arrayBuffer());
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, audio, { contentType: "audio/mpeg", upsert: true });
      if (upErr) {
        console.error("preview upload error:", upErr.message);
        return json({ error: "Couldn't store the preview" }, 500);
      }
    }

    const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
    if (!signed?.signedUrl) return json({ error: "Couldn't sign the preview" }, 500);

    return json({
      url: signed.signedUrl,
      cached,
      voice_id: vid,
      element_index,
      text_preview: target.text.slice(0, 60),
    });
  } catch (err) {
    console.error("preview-voice-line error:", err);
    return json({ error: "Internal error", details: String(err) }, 500);
  }
});
