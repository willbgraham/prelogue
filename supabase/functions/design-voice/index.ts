import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
const EL = "https://api.elevenlabs.io/v1/text-to-voice";

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * ElevenLabs Voice Design — writers craft a custom voice for a character from a
 * text prompt. Two actions:
 *   preview: { action:"preview", description }  -> { previews:[{generated_voice_id, audio_base_64, media_type}], text }
 *   create:  { action:"create", name, description, generated_voice_id } -> { voice_id, name }
 * Writer-gated (the caller must have the 'writer' role).
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!ELEVENLABS_API_KEY) return json({ error: "Voice design not configured" }, 500);
    const body = await req.json();

    // Auth + writer-role gate.
    const authHeader = req.headers.get("Authorization") ?? "";
    const {
      data: { user },
    } = await createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    ).auth.getUser();
    if (!user) return json({ error: "Not authorized" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: profile } = await admin.from("users").select("roles").eq("id", user.id).single();
    const roles = (profile?.roles as string[] | null) ?? [];
    if (!roles.includes("writer")) {
      return json({ error: "Designing voices is a writer feature. Add the Writer role to your profile." }, 403);
    }

    const elHeaders = {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
    };

    if (body.action === "preview") {
      const description = String(body.description ?? "").trim();
      if (description.length < 20) {
        return json({ error: "Describe the voice in a bit more detail (at least 20 characters)." }, 400);
      }
      const r = await fetch(`${EL}/create-previews`, {
        method: "POST",
        headers: elHeaders,
        body: JSON.stringify({ voice_description: description, auto_generate_text: true }),
      });
      const j = await r.json();
      if (!r.ok) return json({ error: j?.detail?.message ?? j?.detail ?? "Voice design failed" }, 400);
      const previews = (j.previews ?? []).map((p: Record<string, unknown>) => ({
        generated_voice_id: p.generated_voice_id,
        audio_base_64: p.audio_base_64,
        media_type: p.media_type ?? "audio/mpeg",
      }));
      return json({ previews, text: j.text ?? "" });
    }

    if (body.action === "create") {
      const name = String(body.name ?? "").trim();
      const description = String(body.description ?? "").trim();
      const generated_voice_id = String(body.generated_voice_id ?? "");
      if (!name || !generated_voice_id) {
        return json({ error: "name and generated_voice_id required" }, 400);
      }
      const r = await fetch(`${EL}/create-voice-from-preview`, {
        method: "POST",
        headers: elHeaders,
        body: JSON.stringify({ voice_name: name, voice_description: description, generated_voice_id }),
      });
      const j = await r.json();
      if (!r.ok) return json({ error: j?.detail?.message ?? j?.detail ?? "Couldn't save the voice" }, 400);
      return json({ voice_id: j.voice_id, name: j.name ?? name });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "error" }, 500);
  }
});
