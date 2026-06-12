// Adds a voice from the ElevenLabs shared Voice Library to the account so it
// becomes usable for text-to-speech. Returns the new account voice_id.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!ELEVENLABS_API_KEY) {
      return new Response(
        JSON.stringify({ error: "ELEVENLABS_API_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { public_owner_id, voice_id, name } = await req.json();
    if (!public_owner_id || !voice_id) {
      return new Response(
        JSON.stringify({ error: "public_owner_id and voice_id required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const newName = String(name || "Cast voice").slice(0, 100);
    const res = await fetch(
      `${ELEVENLABS_BASE}/voices/add/${public_owner_id}/${voice_id}`,
      {
        method: "POST",
        headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ new_name: newName }),
      }
    );

    const text = await res.text();
    if (!res.ok) {
      // Return 200 with success:false so the client reliably reads the message
      // (e.g. "voice limit reached") instead of a generic invoke error.
      let msg = `ElevenLabs error ${res.status}`;
      try {
        const j = JSON.parse(text);
        msg = j?.detail?.message || j?.detail || j?.message || msg;
      } catch {
        /* keep default */
      }
      return new Response(
        JSON.stringify({ success: false, error: String(msg).slice(0, 200) }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let json: any = {};
    try {
      json = JSON.parse(text);
    } catch {
      // ignore
    }

    return new Response(
      JSON.stringify({ success: true, voice_id: json.voice_id ?? null, name: newName }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("add-voice error:", err);
    return new Response(
      JSON.stringify({ error: "Internal error", details: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
