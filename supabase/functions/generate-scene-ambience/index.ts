// Generate a scene's background bed: MUSIC (Eleven Music, instrumental score)
// or SFX (Sound Effects v2, seamless ambient loop). Writer-gated — generation
// spends real ElevenLabs credits (music ≈ 900/min, sfx = 40/sec), so unlike
// voice re-casting there is NO demo exception; visitors only ever play back
// what the writer saved.
//
// Content-addressed cache in the private `scripts` bucket:
//   ambience/{script_id}/{sha1(kind|prompt|length_ms)}.mp3
// Re-generating an unchanged prompt returns the cached file and spends nothing.
// The client saves the resulting path into scripts.ambience_config itself.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";
const BUCKET = "scripts";

const MUSIC_MIN_MS = 15_000;
const MUSIC_MAX_MS = 180_000;
const SFX_MIN_MS = 5_000;
const SFX_MAX_MS = 30_000; // sound-generation hard cap
const PROMPT_MAX = 500;

const clampNum = (v: unknown, d: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, typeof v === "number" && isFinite(v) ? v : d));

async function sha1(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
    const { script_id, kind, prompt, length_ms } = await req.json();
    if (!script_id || typeof prompt !== "string" || !prompt.trim()) {
      return json({ error: "script_id and prompt required" }, 400);
    }
    if (kind !== "music" && kind !== "sfx") {
      return json({ error: "kind must be \"music\" or \"sfx\"" }, 400);
    }
    if (prompt.length > PROMPT_MAX) {
      return json({ error: `Prompt too long (max ${PROMPT_MAX} characters)` }, 400);
    }
    if (!ELEVENLABS_API_KEY) return json({ error: "ELEVENLABS_API_KEY not configured" }, 500);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Writer gate — the caller must own the script. No demo exception:
    // generation costs credits; playback of saved beds is what visitors get.
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
    const { data: script, error: scriptErr } = await supabase
      .from("scripts")
      .select("writer_id")
      .eq("id", script_id)
      .single();
    if (scriptErr || !script) return json({ error: "Script not found" }, 404);
    if (!callerId || callerId !== script.writer_id) {
      return json({ error: "Only the writer can generate scene music" }, 403);
    }

    const cleanPrompt = prompt.trim().replace(/\s+/g, " ");
    const ms =
      kind === "music"
        ? Math.round(clampNum(length_ms, 60_000, MUSIC_MIN_MS, MUSIC_MAX_MS))
        : Math.round(clampNum(length_ms, 20_000, SFX_MIN_MS, SFX_MAX_MS));

    const hash = await sha1(`${kind}|${cleanPrompt}|${ms}`);
    const dir = `ambience/${script_id}`;
    const filename = `${hash}.mp3`;
    const path = `${dir}/${filename}`;

    // Cached already? (Identical prompt + length ⇒ same file, zero credits.)
    const { data: existing } = await supabase.storage
      .from(BUCKET)
      .list(dir, { limit: 5, search: filename });
    const cached = (existing ?? []).some((o) => o.name === filename);

    if (!cached) {
      let res: Response;
      if (kind === "music") {
        res = await fetch(`${ELEVENLABS_BASE}/music?output_format=mp3_44100_128`, {
          method: "POST",
          headers: {
            "xi-api-key": ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            prompt: cleanPrompt,
            music_length_ms: ms,
            force_instrumental: true, // a bed under dialogue must never sing
          }),
        });
      } else {
        res = await fetch(
          `${ELEVENLABS_BASE}/sound-generation?output_format=mp3_44100_128`,
          {
            method: "POST",
            headers: {
              "xi-api-key": ELEVENLABS_API_KEY,
              "Content-Type": "application/json",
              Accept: "audio/mpeg",
            },
            body: JSON.stringify({
              text: cleanPrompt,
              duration_seconds: ms / 1000,
              loop: true, // seamless loop for room tone / weather beds
              model_id: "eleven_text_to_sound_v2",
            }),
          }
        );
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        console.error(`ambience ${kind} TTS ${res.status}: ${detail.slice(0, 300)}`);
        return json({ error: `Generation failed (${res.status})` }, 502);
      }
      const audio = new Uint8Array(await res.arrayBuffer());
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, audio, { contentType: "audio/mpeg", upsert: true });
      if (upErr) {
        console.error("ambience upload error:", upErr.message);
        return json({ error: "Couldn't store the audio" }, 500);
      }
    }

    const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
    if (!signed?.signedUrl) return json({ error: "Couldn't sign the audio" }, 500);

    return json({ path, url: signed.signedUrl, cached, kind, length_ms: ms });
  } catch (err) {
    console.error("generate-scene-ambience error:", err);
    return json({ error: "Internal error", details: String(err) }, 500);
  }
});
