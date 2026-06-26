// Returns voices the writer can pick from: the account's voices (ready to use)
// plus a slice of the ElevenLabs shared Voice Library (female-weighted for
// variety). Library voices carry `public_owner_id` and must be added to the
// account before TTS (see the add-voice function).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
const V1 = "https://api.elevenlabs.io/v1";
const V2 = "https://api.elevenlabs.io/v2";

interface Voice {
  voice_id: string;
  name: string;
  category: string | null;
  labels: Record<string, string>;
  preview_url: string | null;
  /** Present only for library voices (means: must be added before use). */
  public_owner_id?: string | null;
}

let cache: { at: number; data: Voice[] } | null = null;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

function pickLabels(src: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["gender", "accent", "language", "age", "descriptive", "use_case"]) {
    const v = src[key];
    if (v) out[key] = String(v);
  }
  return out;
}

// Account voices (/v2/voices) — directly usable for TTS.
async function fetchAccountVoices(): Promise<Voice[]> {
  const out: Voice[] = [];
  let pageToken = "";
  for (let page = 0; page < 25; page++) {
    const url = new URL(`${V2}/voices`);
    url.searchParams.set("page_size", "100");
    if (pageToken) url.searchParams.set("next_page_token", pageToken);
    const res = await fetch(url.toString(), { headers: { "xi-api-key": ELEVENLABS_API_KEY! } });
    if (!res.ok) break;
    const json = await res.json();
    for (const v of json.voices ?? []) {
      out.push({
        voice_id: v.voice_id,
        name: v.name,
        category: v.category ?? null,
        labels: v.labels ?? {},
        preview_url: v.preview_url ?? null,
        public_owner_id: null,
      });
    }
    if (!json.has_more || !json.next_page_token) break;
    pageToken = json.next_page_token;
  }
  return out;
}

// Shared Voice Library (/v1/shared-voices). These voices are usable directly in
// TTS by voice_id (verified) — no add-voice / slot needed. Page through to build
// a large, browsable set the picker can filter client-side.
async function fetchLibraryVoices(
  gender: string,
  maxPages: number,
  pageSize = 100
): Promise<Voice[]> {
  const out: Voice[] = [];
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${V1}/shared-voices`);
    url.searchParams.set("page_size", String(pageSize));
    url.searchParams.set("page", String(page));
    if (gender) url.searchParams.set("gender", gender);
    const res = await fetch(url.toString(), { headers: { "xi-api-key": ELEVENLABS_API_KEY! } });
    if (!res.ok) break;
    const json = await res.json();
    const voices = json.voices ?? [];
    for (const v of voices) {
      out.push({
        voice_id: v.voice_id,
        name: v.name,
        category: v.category ?? "library",
        labels: pickLabels(v),
        preview_url: v.preview_url ?? null,
        public_owner_id: v.public_owner_id ?? null,
      });
    }
    if (!json.has_more || voices.length === 0) break;
  }
  return out;
}

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

    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return new Response(JSON.stringify({ voices: cache.data, cached: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=600" },
      });
    }

    // Page through the shared library for a large, diverse, browsable set
    // (the picker filters client-side by gender/accent/language/age/search).
    const [account, female, male] = await Promise.all([
      fetchAccountVoices(),
      fetchLibraryVoices("female", 5), // up to ~500
      fetchLibraryVoices("male", 4), // up to ~400
    ]);

    // Drop library voices already in the account (by name) to avoid duplicates.
    const accountNames = new Set(account.map((v) => v.name.toLowerCase()));
    const seen = new Set<string>();
    const library = [...female, ...male].filter((v) => {
      if (accountNames.has(v.name.toLowerCase())) return false;
      if (seen.has(v.voice_id)) return false;
      seen.add(v.voice_id);
      return true;
    });

    const voices = [...account, ...library];
    cache = { at: Date.now(), data: voices };

    return new Response(
      JSON.stringify({ voices, cached: false, account: account.length, library: library.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=600" } }
    );
  } catch (err) {
    console.error("list-voices error:", err);
    return new Response(
      JSON.stringify({ error: "Internal error", details: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
