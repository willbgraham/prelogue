import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

// Voice IDs for different character archetypes
const VOICES: Record<string, string> = {
  male_default: "pNInz6obpgDQGcFmaJgB", // Adam
  female_default: "EXAVITQu4vr4xnSDxMaL", // Bella
  male_gruff: "VR6AewLTigWG4xSOukaG", // Arnold
  female_young: "jBpfuIE2acCO8z3wKNLl", // Gigi
  narrator: "onwK4e9ZLuTAKqWW03F9", // Daniel
};

const BATCH_SIZE = 5; // Parallel requests per batch
const MAX_CUES = 20; // Keep total cues manageable for speed

/**
 * Generate a single TTS cue and upload to storage.
 * Returns manifest entry or null on failure.
 */
async function generateAndUploadCue(
  cue: { character: string; text: string; index: number },
  voiceId: string,
  storagePath: string,
  supabase: any
): Promise<{ index: number; character: string; text: string; audio_url: string } | null> {
  try {
    const ttsResponse = await fetch(
      `${ELEVENLABS_BASE}/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY!,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: cue.text,
          model_id: "eleven_flash_v2_5",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );

    if (!ttsResponse.ok) {
      console.error(`ElevenLabs error for cue ${cue.index}: ${ttsResponse.status}`);
      return null;
    }

    const audioBuffer = await ttsResponse.arrayBuffer();

    const { error: uploadError } = await supabase.storage
      .from("scripts")
      .upload(storagePath, new Uint8Array(audioBuffer), {
        contentType: "audio/mpeg",
        upsert: true,
      });

    if (uploadError) {
      console.error(`Upload error for cue ${cue.index}:`, uploadError);
      return null;
    }

    const { data: urlData } = await supabase.storage
      .from("scripts")
      .createSignedUrl(storagePath, 86400);

    if (!urlData) return null;

    return {
      index: cue.index,
      character: cue.character,
      text: cue.text,
      audio_url: urlData.signedUrl,
    };
  } catch (err) {
    console.error(`Failed cue ${cue.index}:`, err);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { character_id } = await req.json();
    if (!character_id) {
      return new Response(
        JSON.stringify({ error: "character_id required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
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

    // Check if cues already exist for this character (skip regeneration)
    const manifestPath = `voice-cues/${character_id}/manifest.json`;
    const { data: existing } = await supabase.storage
      .from("scripts")
      .download(manifestPath);

    if (existing) {
      const text = await existing.text();
      const parsed = JSON.parse(text);
      return new Response(
        JSON.stringify({
          success: true,
          cues_generated: parsed.length,
          cached: true,
          manifest_path: manifestPath,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get character and script
    const { data: character, error: charError } = await supabase
      .from("characters")
      .select("id, name, script_id")
      .eq("id", character_id)
      .single();

    if (charError || !character) {
      return new Response(
        JSON.stringify({ error: "Character not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: script } = await supabase
      .from("scripts")
      .select("parsed_json")
      .eq("id", character.script_id)
      .single();

    if (!script?.parsed_json) {
      return new Response(
        JSON.stringify({ error: "Script has no parsed data" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const parsed = script.parsed_json as any;
    const actorCharName = character.name.toUpperCase();

    // Collect other characters' lines
    const cueLines: { character: string; text: string; index: number }[] = [];
    let lineIndex = 0;

    for (const otherChar of parsed.characters || []) {
      if (otherChar.name.toUpperCase() === actorCharName) continue;
      for (const line of (otherChar.lines || []).slice(0, 15)) {
        cueLines.push({
          character: otherChar.name,
          text: line.text,
          index: lineIndex++,
        });
      }
    }

    if (cueLines.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No cue lines to generate", cues: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const limitedCues = cueLines.slice(0, MAX_CUES);

    // Assign voices per character
    const charVoices = new Map<string, string>();
    const voiceKeys = Object.keys(VOICES);
    let voiceIdx = 0;

    for (const cue of limitedCues) {
      if (!charVoices.has(cue.character)) {
        charVoices.set(cue.character, voiceKeys[voiceIdx % voiceKeys.length]);
        voiceIdx++;
      }
    }

    // Process in parallel batches of BATCH_SIZE
    const manifest: { index: number; character: string; text: string; audio_url: string }[] = [];

    for (let i = 0; i < limitedCues.length; i += BATCH_SIZE) {
      const batch = limitedCues.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map((cue) => {
          const voiceType = charVoices.get(cue.character)!;
          const voiceId = VOICES[voiceType];
          const storagePath = `voice-cues/${character_id}/cue-${cue.index}.mp3`;
          return generateAndUploadCue(cue, voiceId, storagePath, supabase);
        })
      );

      for (const result of results) {
        if (result) manifest.push(result);
      }

      console.log(`Batch complete: ${Math.min(i + BATCH_SIZE, limitedCues.length)}/${limitedCues.length}`);
    }

    // Store manifest
    await supabase.storage
      .from("scripts")
      .upload(
        manifestPath,
        new TextEncoder().encode(JSON.stringify(manifest)),
        { contentType: "application/json", upsert: true }
      );

    return new Response(
      JSON.stringify({
        success: true,
        cues_generated: manifest.length,
        total_cue_lines: limitedCues.length,
        manifest_path: manifestPath,
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
