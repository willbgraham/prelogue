import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isServiceRole } from "../_shared/serviceRole.ts";
import { creditsToVoice } from "../_shared/credits.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
// The override exists for the test rig, which points it at a stand-in provider.
const ELEVENLABS_BASE = Deno.env.get("ELEVENLABS_API_BASE") ?? "https://api.elevenlabs.io/v1";

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
// When the provider says no
// ---------------------------------------------------------------------------
// Two things were found in production (Nov 2026), both of which left lines of
// a read silent under a banner blaming "voice credits":
//
//  1. A community voice's very FIRST use. The provider adds the voice to the
//     account on the first request; the other lines of the same five-line batch
//     arrive while that is happening and are answered 409. One line was voiced,
//     four were not — and on a locked script's ten-line taste, which is a single
//     run, nothing ever asked again. Seen for every one of eight voices on their
//     first day. The answer is to wait a moment and ask again.
//
//  2. A community voice that will not read a particular line. Its owner can
//     restrict what it says, and the provider then answers 403 for that text on
//     that voice, every time, while other voices read the same words. Two lines
//     of a 1,292-line read stayed silent. The answer is a stand-in: a house
//     voice of the same sort reads the line, stored where the chosen voice's
//     clip would be, and the writer is told (stand_ins in the reply).
const TTS_TRIES = 4; // one request plus three more for answers that pass in a moment
const LINE_WAIT_MS = 8_000; // …but never more than this much waiting on one line
// Stop starting new batches after this long and hand the rest back as
// `remaining`: the caller asks again. Keeps a provider brown-out (every line
// waiting and retrying) well inside the platform's wall-clock limit.
const RUN_BUDGET_MS = Number(Deno.env.get("VOICE_RUN_BUDGET_MS")) || 60_000;
// The voice list the picker is built from, kept by list-voices. Read only when a
// voice has refused a line, to learn what sort of voice needs standing in for.
const CATALOG_PATH = "voice-cues/_catalog/voices.json";

// House voices (the provider's own, always in the account, and not subject to
// an owner's restrictions), in order of preference for each sort of voice.
const STAND_INS: Record<string, Record<string, string[]>> = {
  male: {
    young: ["bIHbv24MWmeRgasZH58o", "TX3LPaxmHKxFdv7VOQHJ"], // Will, Liam
    middle_aged: ["iP95p4xoKVk53GoZ742B", "CwhRBWXzGAHq8TQ4Fs17", "cjVigY5qzO86Huf0OWal"], // Chris, Roger, Eric
    old: ["pqHfZKP75CvOlQylNhV4", "nPczCjzI2devNBz1zQrb"], // Bill, Brian
    british: ["JBFqnCBsd6RMkjVDRZzb", "onwK4e9ZLuTAKqWW03F9"], // George, Daniel
  },
  female: {
    young: ["cgSgspJ2msm6clMCkdW9", "EXAVITQu4vr4xnSDxMaL", "FGY2WhTYpPnrIDTdsKH5"], // Jessica, Sarah, Laura
    middle_aged: ["XrExE9yKIg1WjnnlVkGX", "hpp4J3VqNfWAUOO0d1Us"], // Matilda, Bella
    old: ["XrExE9yKIg1WjnnlVkGX", "hpp4J3VqNfWAUOO0d1Us"],
    british: ["Xb7hH8MSUJpSbSDYk0k2", "pFZP5JQG7iQjIQuC4Bku"], // Alice, Lily
  },
};
const STAND_IN_NEUTRAL = ["SAz9YHcvj6GT2YYXdXww"]; // River

/** House voices suited to stand in for a voice with these labels, best first. */
function standInCandidates(labels: Record<string, string> | null): string[] {
  const gender = (labels?.gender ?? "").toLowerCase();
  if (gender === "neutral" || gender === "non-binary") return STAND_IN_NEUTRAL;
  const sort = STAND_INS[gender];
  if (!sort) return [];
  if (/brit|engl|scot|irish|wel/.test((labels?.accent ?? "").toLowerCase())) return sort.british;
  const age = (labels?.age ?? "").toLowerCase();
  return sort[age === "young" ? "young" : age === "old" ? "old" : "middle_aged"];
}

/** True when the answer means "this voice will not (or cannot) read this", as opposed to "not now". */
function voiceDeclined(status: number, reason: string): boolean {
  // 403: the voice's owner restricts it. 404 (400 on older API versions): the
  // voice has been withdrawn from the library since the writer chose it.
  return status === 403 || status === 404 || (status === 400 && /voice/i.test(reason));
}

type FailKind = "quota" | "declined" | "storage" | "busy";
function failKind(status: number, reason: string): FailKind {
  if (status === 401 || status === 402 || /quota|credit|payment|subscription/i.test(reason)) return "quota";
  if (status === -1) return "storage";
  if (voiceDeclined(status, reason)) return "declined";
  return "busy";
}

// ElevenLabs generation settings (mirror the picker's sliders). Defaults match
// the historical hardcoded values so existing cached audio stays valid.
const DEFAULT_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0, speed: 1.0 };
const clampNum = (v: unknown, d: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, typeof v === "number" && isFinite(v) ? v : d));

// Emotional delivery (v3 audio tags), line-level only. A tagged line renders on
// eleven_v3 — the only model that honors [sad]/[nervous]/… direction. Whitelist
// keeps the tag a known word (it's interpolated into the TTS text) and bounds
// cost: v3 ≈ 2× flash per char, so only explicitly tagged lines pay it.
const EMOTIONS = new Set([
  "sad", "angry", "scared", "nervous", "excited", "calm", "frustrated",
  "sarcastic", "whispers", "shouts", "crying", "deadpan", "cheerfully", "tired",
]);
const V3_MODEL = "eleven_v3";
// v3 stability is modal: 0 Creative / 0.5 Natural / 1 Robust — snap to nearest.
const snapV3Stability = (v: number) => (v < 0.25 ? 0 : v < 0.75 ? 0.5 : 1);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizeText(t: string): string {
  return (t || "").replace(/\s+/g, " ").trim();
}

// Screenplay speaker extensions — "(V.O.)", "(O.S.)", "(CONT'D)", etc. — aren't
// part of a character's identity. Strip trailing parentheticals so "MARSH (V.O.)"
// resolves to the same voice/settings as "MARSH" (which is how the casting picker
// and the characters table list them). Display still uses the full name.
function baseCharName(name?: string): string {
  return (name || "").replace(/(\s*\([^)]*\))+\s*$/g, "").trim();
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

/**
 * The provider's own short reason for saying no: its code and a little of its
 * message. Built only from fields that describe the refusal — a validation
 * error can carry the submitted text back, and that is never read or logged.
 */
async function reasonOf(res: Response): Promise<string> {
  try {
    const j = await res.json();
    const d = Array.isArray(j?.detail) ? j.detail[0] : j?.detail;
    const code = typeof d === "string" ? d : d?.status ?? d?.code ?? d?.type ?? "";
    const message = d && typeof d === "object" && !Array.isArray(j?.detail) ? d.message ?? "" : "";
    return `${code} ${message}`.replace(/\s+/g, " ").trim().slice(0, 140);
  } catch {
    return "";
  }
}

type Spoken = { ok: true; audio: Uint8Array } | { ok: false; status: number; reason: string };

/** One line, one voice. Waits out the answers that pass in a moment; returns the first that doesn't. */
async function speak(
  voiceId: string,
  job: { text: string; model?: string },
  voiceSettings: Record<string, number>
): Promise<Spoken> {
  const giveUpAt = Date.now() + LINE_WAIT_MS;
  let status = 0;
  let reason = "";
  for (let attempt = 0; attempt < TTS_TRIES; attempt++) {
    let wait: number;
    try {
      const res = await fetch(
        `${ELEVENLABS_BASE}/text-to-speech/${voiceId}?output_format=mp3_22050_32`,
        {
          method: "POST",
          headers: {
            "xi-api-key": ELEVENLABS_API_KEY!,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text: job.text,
            model_id: job.model ?? "eleven_flash_v2_5",
            voice_settings: voiceSettings,
          }),
        }
      );
      if (res.ok) return { ok: true, audio: new Uint8Array(await res.arrayBuffer()) };

      status = res.status;
      const retryAfter = Number(res.headers.get("retry-after")) || 2;
      reason = await reasonOf(res);
      if (status === 429) {
        wait = Math.min(retryAfter, 5) * 1000; // busy: the provider says when
      } else if (status === 409 || status >= 500) {
        // 409: a voice on its first use, still being added to the account
        // while the rest of the batch asks for it. 5xx: the provider stumbled.
        wait = 600 * (attempt + 1) + Math.floor(Math.random() * 400);
      } else {
        break; // a refusal — asking again for the same thing changes nothing
      }
    } catch (err) {
      status = 0;
      reason = `no answer: ${String(err).slice(0, 80)}`;
      wait = 600 * (attempt + 1) + Math.floor(Math.random() * 400);
    }
    if (attempt === TTS_TRIES - 1 || Date.now() + wait > giveUpAt) break;
    await sleep(wait);
  }
  return { ok: false, status, reason };
}

type Job = {
  voiceId: string;
  text: string;
  path: string;
  settings: Record<string, number>;
  model?: string;
  role: string; // the speaking character (upper-cased base name); "" for narration
  kind: "dialogue" | "action";
};
type Made =
  | { ok: true; voiceUsed: string }
  | { ok: false; status: number; reason: string };

/**
 * Voice one line and store it. If the chosen voice declines the line, a house
 * voice reads it instead — into the SAME file, so the read is whole — and the
 * voice that actually spoke is reported back (it goes in the cache index, which
 * is how later runs know the clip is a stand-in).
 */
async function ttsAndUpload(
  job: Job,
  supabase: any,
  standInFor: (job: Job) => Promise<string | null>
): Promise<Made> {
  let voiceUsed = job.voiceId;
  let said = await speak(job.voiceId, job, job.settings);
  if (!said.ok) {
    console.error(`TTS ${said.status} for ${job.path} — ${said.reason || "no reason given"}`);
    if (!voiceDeclined(said.status, said.reason)) {
      return { ok: false, status: said.status, reason: said.reason };
    }
    const standIn = await standInFor(job);
    const again = standIn ? await speak(standIn, job, job.settings) : null;
    if (!standIn || !again || !again.ok) {
      if (again && !again.ok) {
        console.error(`stand-in ${standIn}: TTS ${again.status} for ${job.path} — ${again.reason}`);
      }
      // Report the stand-in's answer only when it says something new (the
      // account is out of quota, say); otherwise the line was "declined".
      const told =
        again && !again.ok && failKind(again.status, again.reason) === "quota" ? again : said;
      return { ok: false, status: told.status, reason: told.reason };
    }
    console.log(`stand-in ${standIn} read ${job.path}`);
    said = again;
    voiceUsed = standIn;
  }

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(job.path, said.audio, { contentType: "audio/mpeg", upsert: true });
  if (error) {
    console.error("Upload error:", error.message);
    return { ok: false, status: -1, reason: `upload: ${error.message}`.slice(0, 140) };
  }
  return { ok: true, voiceUsed };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Per-script generation mutex state (see claim below). Declared out here so
  // the catch block can release on crash; the 4-minute staleness window in
  // claim_generation_lock is the backstop if even that fails.
  let lockHeld = false;
  let lockScriptId: string | null = null;

  try {
    const { script_id, voice_config: voiceConfigOverride, dry_run } = await req.json();
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
      .select("parsed_json, voice_config, writer_id, full_read_unlocked, listen_gated")
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
    // A script's full read is unlocked by a purchase (scripts.full_read_unlocked,
    // flipped by the Stripe webhook / subscription-unlock). On a locked script,
    // the WRITER gets a free taste — the first OWNER_PREVIEW_LINES spoken
    // elements, with full voice choice — because hearing your own pages is the
    // best sales pitch we have (~1 credit ≈ 8¢ per cast, cached forever).
    // Everyone else still gets nothing: the public demo is the visitor tryout.
    // Enforced here (service role) so it can't be bypassed from the client.
    const OWNER_PREVIEW_LINES = 10;
    // …and no more than this many characters. Ten lines of a screenplay run
    // about a thousand; but "line" here means a parsed block, and a document
    // that isn't laid out as a screenplay (prose printed from a browser) parses
    // into blocks of up to 2,500 characters each. Three such uploads were given
    // 24,000+ characters of free audio apiece — a quarter of a paid month's
    // credits. Measured across every script on file, this cap leaves 56 of 64
    // tastes at their full ten lines and none can cost more than one block.
    const OWNER_PREVIEW_CHARS = 2500;
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

    // Voices an anonymous demo visitor may apply. These are pre-generated for
    // the demo, so a swap is a cache hit and costs nothing — which is what
    // keeps ad traffic from draining the ElevenLabs balance. The picker still
    // shows the full library; this is the server-side half of that gate (a
    // client-side lock is trivially bypassed).
    // KEEP IN SYNC with apps/web/lib/shared/demoVoices.ts.
    const DEMO_VOICE_ALLOWLIST = new Set([
      "yRkCcID7C7SG09Wb6tIg", "4YWIJNXODjo9x7Nz4BhO", "SOYHLrjzK2X1ezoPC6cr",
      "jmovCppyUT0hdwQb6rmj", "vOIRno85PgKv4YKFyUlz", "hLygPNd2gK6Azddorc5W",
      "VC6vCXhVaI8BZefRtXZV", "MDrnb4sU30RxVQwLWmU3", "H7Fc5Qy614JJMoitlc8A",
      "eR8vsPZKHCfpn1pfTMTZ", "TAXL9Duy50pxAXIMCYbu", "Q86KUByuoHsuv9sOa4NX",
      "UrdIUsVuyr5QSUJdS5hu", "d8WcCpplp8meHt10UhL8", "6de0u4cGYWDeBlsfrX39",
      "QyCGbzzEtSqHWJ8rNRMK",
    ]);
    const serviceBearer = isServiceRole(authHeader);
    const isDemoVisitor =
      script_id === DEMO_SCRIPT_ID && !serviceBearer && callerId !== script.writer_id;
    if (isDemoVisitor && voiceConfigOverride) {
      const ov = voiceConfigOverride as any;
      const requested = [
        ov.narrator_voice_id,
        ov.single_voice_id,
        ...Object.values(ov.characters ?? {}),
      ].filter(Boolean) as string[];
      const bad = requested.find((v) => !DEMO_VOICE_ALLOWLIST.has(v));
      if (bad) {
        return new Response(
          JSON.stringify({ error: "demo_voice_not_allowed", voice_id: bad }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ----- Request-to-listen gate -----
    // A showcase script (listen_gated) is listed publicly but only the writer,
    // an approved requester, or the trusted render worker (service-role bearer)
    // may generate/fetch its audio. Enforced here (service role) so the client
    // can't bypass it; the script TEXT is separately protected by RLS
    // (visibility 'private' + can_view_script).
    if ((script as any).listen_gated === true) {
      const isService = isServiceRole(authHeader);
      const isWriter = !!callerId && callerId === script.writer_id;
      let approved = false;
      if (!isService && !isWriter && callerId) {
        const { data: lr } = await supabase
          .from("listen_requests")
          .select("id")
          .eq("script_id", script_id)
          .eq("requester_id", callerId)
          .eq("status", "approved")
          .maybeSingle();
        approved = !!lr;
        // An actor the writer invited to read a part also needs the read.
        if (!approved) {
          const { data: caller } = await supabase.auth.admin.getUserById(callerId);
          const email = caller?.user?.email ?? "";
          if (email) {
            const { data: ri } = await supabase
              .from("role_invites")
              .select("id")
              .eq("script_id", script_id)
              .ilike("email", email)
              .maybeSingle();
            approved = !!ri;
          }
        }
      }
      if (!isService && !isWriter && !approved) {
        return new Response(
          JSON.stringify({ error: "listen_access_required" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

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

    // Voice generation settings (the picker's sliders): per-role (keyed by
    // UPPER-CASED character names + "__narrator__" / "__single__") with optional
    // per-line overrides (keyed by global element_index). A line's settings win
    // over its role's. Each resolves to a TTS body (stability + similarity
    // always; style/speed only when changed) and a cache-key tag (empty at
    // default → reuses the text-only audio, so default reads generate
    // byte-identical audio and skip needless work).
    const roleSettings = (cfg.role_settings as Record<string, Record<string, unknown>>) || {};
    const lineSettingsCfg = (cfg.line_settings as Record<string, Record<string, unknown>>) || {};
    const NARRATOR_KEY = "__narrator__";
    const SINGLE_KEY = "__single__";
    // Resolved shape: TTS body + cache tag + (for emotion lines) the v3 model
    // and the "[tag] " text prefix that carries the emotional direction.
    type Resolved = {
      body: Record<string, number>;
      tag: string;
      model?: string;
      ttsPrefix?: string;
    };
    const resolveRaw = (raw: Record<string, unknown>, emotion?: string): Resolved => {
      const s = {
        stability: clampNum(raw.stability, DEFAULT_SETTINGS.stability, 0, 1),
        similarity_boost: clampNum(raw.similarity_boost, DEFAULT_SETTINGS.similarity_boost, 0, 1),
        style: clampNum(raw.style, DEFAULT_SETTINGS.style, 0, 1),
        speed: clampNum(raw.speed, DEFAULT_SETTINGS.speed, 0.7, 1.2),
      };
      if (emotion) {
        // v3: modal stability, no style/speed; tag folds emotion + settings.
        const stab = snapV3Stability(s.stability);
        return {
          body: { stability: stab, similarity_boost: s.similarity_boost },
          tag: `_v3${emotion}s${Math.round(stab * 100)}b${Math.round(s.similarity_boost * 100)}`,
          model: V3_MODEL,
          ttsPrefix: `[${emotion}] `,
        };
      }
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
      return { body, tag };
    };
    const settingsCache = new Map<string, Resolved>();
    // Role-level settings never carry an emotion (line-level only — bounds v3 cost).
    const resolveSettings = (roleKey: string) => {
      const cached = settingsCache.get(roleKey);
      if (cached) return cached;
      const resolved = resolveRaw(roleSettings[roleKey] || {});
      settingsCache.set(roleKey, resolved);
      return resolved;
    };
    // Line override merges OVER the role's settings (an untouched knob inherits).
    const resolveFor = (roleKey: string, idx: number) => {
      const lineRaw = lineSettingsCfg[String(idx)];
      if (!lineRaw) return resolveSettings(roleKey);
      const key = `line:${idx}`;
      const cached = settingsCache.get(key);
      if (cached) return cached;
      const emotionRaw = typeof lineRaw.emotion === "string" ? lineRaw.emotion.toLowerCase() : "";
      const emotion = EMOTIONS.has(emotionRaw) ? emotionRaw : undefined;
      const resolved = resolveRaw({ ...(roleSettings[roleKey] ?? {}), ...lineRaw }, emotion);
      settingsCache.set(key, resolved);
      return resolved;
    };

    const characterVoice = (name?: string): string => {
      const key = baseCharName(name).toUpperCase();
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
      tts_text: string; // what's sent to TTS (emotion lines carry a "[tag] " prefix)
      model?: string; // eleven_v3 for emotion lines; default flash otherwise
    }
    const entries: Entry[] = [];
    let globalIdx = 0;
    const effChars: Record<string, string> = {};
    // Effective settings tags for the manifest hash: roleKey → tag for role-level,
    // "#<element_index>" → tag for line overrides. A line override that resolves
    // back to defaults still records "default" so it hashes differently from the
    // same config without the override (its audio differs when the role is custom).
    const effTags: Record<string, string> = {};

    for (const scene of scenes) {
      for (const el of scene.elements ?? []) {
        const myIndex = globalIdx++;
        const norm = normalizeText(el.text);
        if (el.type === "dialogue" && norm) {
          const baseName = baseCharName(el.character_name).toUpperCase();
          const roleKey = mode === "single" ? SINGLE_KEY : baseName;
          const voiceId = mode === "single" ? singleVoiceId : characterVoice(el.character_name);
          effChars[baseName] = voiceId;
          const { body, tag, model, ttsPrefix } = resolveFor(roleKey, myIndex);
          if (lineSettingsCfg[String(myIndex)]) effTags[`#${myIndex}`] = tag || "default";
          else if (tag) effTags[roleKey] = tag;
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
            tts_text: `${ttsPrefix ?? ""}${norm}`,
            model,
          });
        } else if (el.type === "action" && norm) {
          const roleKey = mode === "single" ? SINGLE_KEY : NARRATOR_KEY;
          const voiceId = mode === "single" ? singleVoiceId : narratorVoiceId;
          const { body, tag, model, ttsPrefix } = resolveFor(roleKey, myIndex);
          if (lineSettingsCfg[String(myIndex)]) effTags[`#${myIndex}`] = tag || "default";
          else if (tag) effTags[roleKey] = tag;
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
            tts_text: `${ttsPrefix ?? ""}${norm}`,
            model,
          });
        }
        // character / parenthetical: index consumed, no audio entry
      }
    }

    // Free tier: on a locked script, the writer hears the opening; everyone
    // else hears nothing. (Service role never generates on locked scripts —
    // exports require the unlock upstream.)
    const isOwnerCaller = !!callerId && callerId === (script as any).writer_id;
    const FREE_PREVIEW_LIMIT = locked ? (isOwnerCaller ? OWNER_PREVIEW_LINES : 0) : Infinity;
    if (locked && entries.length > FREE_PREVIEW_LIMIT) {
      entries.length = FREE_PREVIEW_LIMIT;
    }
    if (locked && entries.length > 0) {
      // The first block always plays, so a taste is never silent; after that,
      // stop before the block that would take it past the cap.
      let chars = 0;
      let keep = 0;
      for (const e of entries) {
        const len = (e.tts_text ?? e.text ?? "").length;
        if (keep > 0 && chars + len > OWNER_PREVIEW_CHARS) break;
        chars += len;
        keep++;
      }
      entries.length = keep;
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
    // Fold in only the roles/lines whose settings are non-default, so an
    // all-default read keeps its existing manifest key (no needless
    // regeneration) while any per-role or per-line change gets its own manifest.
    const settingsKey = Object.keys(effTags).length ? { settings_tags: effTags } : {};
    const hashInput =
      mode === "single"
        ? { mode, single_voice_id: singleVoiceId, content: contentDigest, ...settingsKey }
        : { mode, narrator_voice_id: narratorVoiceId, characters: effChars, content: contentDigest, ...settingsKey };
    const voiceConfigHash = (await sha1(canonical(hashInput))).slice(0, 16);
    const manifestPath = `voice-cues/script/${script_id}/${voiceConfigHash}/manifest.json`;

    // Existence check: list cached hashes per distinct voice.
    const distinctJobs = new Map<string, Job>();
    for (const e of entries) {
      if (!distinctJobs.has(e.audio_key)) {
        distinctJobs.set(e.audio_key, {
          voiceId: e.voice_id,
          text: e.tts_text, // emotion lines carry their "[tag] " prefix
          path: e.audio_path,
          settings: e.settings,
          model: e.model,
          role: e.type === "dialogue" ? baseCharName(e.character ?? "").toUpperCase() : "",
          kind: e.type === "dialogue" ? "dialogue" : "action",
        });
      }
    }
    // Serialize generation per script. Two concurrent runs each saw the same
    // cache misses, generated the same clips, and BOTH debited the writer —
    // observed in prod as paired ledger entries and a double-spent balance.
    // The miss computation below must happen under the lock, or the second
    // run works from a stale list. Dry runs read-only, so they skip it.
    // Fail-open on RPC *error* (e.g. migration not applied yet) — the lock is
    // protection, not a dependency; only an explicit "false" means busy.
    if (!dry_run) {
      const { data: claimed, error: claimErr } = await supabase.rpc("claim_generation_lock", {
        p_script: script_id,
      });
      if (!claimErr && claimed === false) {
        // HTTP 200 deliberately: supabase-js functions.invoke() surfaces
        // non-2xx as { data: null, error }, which would hide the body from
        // clients. 200 + an error field flows through `data` cleanly.
        return new Response(
          JSON.stringify({ error: "generation_in_progress", retry_in: 4 }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (!claimErr) {
        lockHeld = true;
        lockScriptId = script_id;
      }
    }

    // Existence check against the voice_audio_cache index: ask only about the
    // keys this run needs, rather than listing whole storage folders (which
    // capped at 1000 objects and silently made cached audio look missing).
    // Chunked to keep the query string bounded.
    const wantedKeys = [...distinctJobs.keys()];
    const existing = new Set<string>();
    // key → the voice that actually spoke the clip. It is the chosen voice,
    // except where a house voice stood in for one that declined the line.
    const spokenBy = new Map<string, string>();
    const CHUNK = 200;
    for (let i = 0; i < wantedKeys.length; i += CHUNK) {
      const { data: rows } = await supabase
        .from("voice_audio_cache")
        .select("key, voice_id")
        .in("key", wantedKeys.slice(i, i + CHUNK));
      for (const r of rows ?? []) {
        const row = r as { key: string; voice_id: string | null };
        existing.add(row.key);
        if (row.voice_id) spokenBy.set(row.key, row.voice_id);
      }
    }

    // Generate the misses, capped per run (resumable).
    const allMisses = [...distinctJobs.entries()].filter(([k]) => !existing.has(k));
    let toDo = allMisses.slice(0, MAX_NEW_PER_RUN);

    // Server-side budget for DEMO generation. The demo is deliberately open
    // (anyone can re-cast voices) and the only client-side cap is localStorage,
    // so curl in a loop could drain the ElevenLabs balance.
    //
    // Sized against the actual plan: 600k credits/month, and TTS bills 0.5
    // credits per character, so 1 char = 0.5 credits. The monthly ceiling is
    // the one that matters — it caps the demo at ~12% of the plan, leaving the
    // rest for paying writers. The daily ceiling just stops a single day from
    // eating the whole month. Past either, the demo serves cache only.
    const DEMO_DAILY_CHAR_BUDGET = 12_000; // 6k credits/day
    const DEMO_MONTHLY_CHAR_BUDGET = 150_000; // 75k credits ≈ 12% of 600k
    const todayKey = new Date().toISOString().slice(0, 10);
    const monthStart = `${todayKey.slice(0, 7)}-01`;
    let demoBudgetExceeded = false;
    // Service-role callers (ops pre-warming the curated demo voices, the render
    // worker) are exempt — the budget exists to bound anonymous visitors.
    if (script_id === DEMO_SCRIPT_ID && toDo.length && !serviceBearer) {
      const { data: rows } = await supabase
        .from("demo_tts_usage")
        .select("day, chars")
        .gte("day", monthStart);
      const today = (rows ?? []).find((r: { day: string }) => r.day === todayKey)?.chars ?? 0;
      const month = (rows ?? []).reduce(
        (n: number, r: { chars: number }) => n + (r.chars ?? 0),
        0
      );
      if (today >= DEMO_DAILY_CHAR_BUDGET || month >= DEMO_MONTHLY_CHAR_BUDGET) {
        demoBudgetExceeded = true;
        toDo = [];
      }
    }
    // ---- Credits ----------------------------------------------------------
    // 1 credit = 1,000 characters of generated speech. Only genuine cache
    // MISSES cost anything: replays, and re-selecting a voice already used for
    // a line, are free. The script's WRITER pays (not whoever presses play), so
    // an approved listener or invited actor can hear the read without being
    // billed for someone else's script.
    // The demo is exempt (pre-warmed + its own budget) and so is the service
    // role (the render worker).
    const CHARS_PER_CREDIT = 1000;
    const payerId = script.writer_id as string;
    const isDemoScript = script_id === DEMO_SCRIPT_ID;
    // Locked scripts are exempt: a locked run is at most the writer's 10-line
    // free preview (entries were sliced above), and that's the sales sample —
    // charging for it would 402 a writer with 0 credits out of their own taste.
    const meterCredits = !isDemoScript && !serviceBearer && !locked && toDo.length > 0;

    // A dry run prices the job without generating anything, so the client can
    // warn "this will use N credits" BEFORE spending. Costs nothing to call.
    if (dry_run) {
      const chars = toDo.reduce((n, [, j]) => n + (j.text?.length ?? 0), 0);
      const needed = chars > 0 ? Math.max(1, Math.ceil(chars / CHARS_PER_CREDIT)) : 0;
      // The figures above are for the NEXT RUN only (at most MAX_NEW_PER_RUN
      // lines). Shown to a writer as the cost of the read they were wrong by
      // the number of runs: "this will use 5 credits" for a read that took 29,
      // and an export refused for "80 lines" when 494 were unvoiced. So the
      // whole job is priced too: every line the read still lacks, and what
      // voicing all of them will be charged.
      const pending = demoBudgetExceeded ? [] : allMisses;
      const meterAll = !isDemoScript && !serviceBearer && !locked && pending.length > 0;
      const creditsToFinish = meterAll
        ? creditsToVoice(pending.map(([, j]) => j.text?.length ?? 0), MAX_NEW_PER_RUN)
        : 0;
      let balance = 0;
      if (!isDemoScript) {
        const { data: payer } = await supabase
          .from("users")
          .select("credits_balance")
          .eq("id", payerId)
          .single();
        balance = payer?.credits_balance ?? 0;
      }
      return new Response(
        JSON.stringify({
          dry_run: true,
          credits_needed: meterCredits ? needed : 0,
          balance,
          new_lines: toDo.length,
          remaining_after_run: Math.max(0, allMisses.length - toDo.length),
          // The whole job (see above). Read these, not the two before them,
          // to say what a read needs before it can be played or exported whole.
          missing_lines: pending.length,
          credits_to_finish: creditsToFinish,
          cached: allMisses.length === 0,
          // Lets the export worker find the read's manifest without triggering
          // generation (it runs as service role, which is credit-exempt).
          manifest_path: manifestPath,
          total_lines: entries.length,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (meterCredits) {
      const charsToGenerate = toDo.reduce((n, [, j]) => n + (j.text?.length ?? 0), 0);
      const estimate = Math.max(1, Math.ceil(charsToGenerate / CHARS_PER_CREDIT));
      const { data: payer } = await supabase
        .from("users")
        .select("credits_balance")
        .eq("id", payerId)
        .single();
      const balance = payer?.credits_balance ?? 0;
      if (balance < estimate) {
        if (lockHeld && lockScriptId) {
          lockHeld = false;
          await supabase.rpc("release_generation_lock", { p_script: lockScriptId });
        }
        return new Response(
          JSON.stringify({
            error: "insufficient_credits",
            needed: estimate,
            balance,
            is_owner: callerId === payerId,
          }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Which house voice reads a line its chosen voice won't. The voice list is
    // fetched at most once a run, and only if a voice has actually declined.
    const voicesInThisRead = new Set<string>(entries.map((e) => e.voice_id));
    const known = new Map<string, Record<string, string>>(); // voice → its labels
    // One fetch shared by every line of a batch that needs it (they ask at once).
    let voiceListRead: Promise<void> | null = null;
    const readVoiceList = async () => {
      try {
        const { data } = await supabase.storage.from(BUCKET).download(CATALOG_PATH);
        const list = data ? JSON.parse(await data.text())?.data : null;
        for (const v of Array.isArray(list) ? list : []) {
          if (v?.voice_id) known.set(v.voice_id, v.labels ?? {});
        }
      } catch (_) {
        /* no list to consult: choose by the character's name, below */
      }
    };
    const standInFor = async (job: Job): Promise<string | null> => {
      await (voiceListRead ??= readVoiceList());
      // House voices of the same sort, skipping any that has left the provider's
      // list, then the voice this role would have had with no choice made at all.
      const suited = standInCandidates(known.get(job.voiceId) ?? null).filter(
        (v) => known.size === 0 || known.has(v)
      );
      const byName = job.kind === "action" ? DEFAULT_NARRATOR : fallbackVoiceForName(job.role);
      const candidates = [...suited, byName, DEFAULT_NARRATOR].filter((v) => v !== job.voiceId);
      // Prefer one no other role in this read is using, so two people don't
      // suddenly share a voice; settle for one that is if there's no other.
      return candidates.find((v) => !voicesInThisRead.has(v)) ?? candidates[0] ?? null;
    };

    const generatedKeys = new Set<string>();
    const failures: { status: number; reason: string }[] = [];
    let failed = 0;
    let attempted = 0;
    const stopAt = Date.now() + RUN_BUDGET_MS;

    for (let i = 0; i < toDo.length; i += BATCH_SIZE) {
      // Out of time for this run (the provider is slow or refusing): what's
      // left is reported as `remaining` and the caller asks again.
      if (i > 0 && Date.now() > stopAt) break;
      const batch = toDo.slice(i, i + BATCH_SIZE);
      attempted += batch.length;
      const results = await Promise.all(
        batch.map(([, job]) => ttsAndUpload(job, supabase, standInFor))
      );
      results.forEach((made, j) => {
        if (made.ok) {
          generatedKeys.add(batch[j][0]);
          spokenBy.set(batch[j][0], made.voiceUsed);
        } else {
          failed++;
          failures.push({ status: made.status, reason: made.reason });
        }
      });
    }

    // Index what we just made, so the next run sees it as cached (and nobody
    // pays for it twice). Upsert keeps it idempotent across resumable runs.
    if (generatedKeys.size) {
      const rows = toDo
        .filter(([k]) => generatedKeys.has(k))
        .map(([k, j]) => ({
          key: k,
          // The voice that spoke it: the chosen one, or the house voice that
          // stood in (the key and the path still belong to the chosen voice).
          voice_id: spokenBy.get(k) ?? j.voiceId,
          path: j.path,
          chars: j.text?.length ?? null,
        }));
      await supabase.from("voice_audio_cache").upsert(rows, { onConflict: "key" });
    }

    // Debit for what was ACTUALLY generated (never the failures, never the
    // cache hits). The pre-flight check above already guaranteed the balance
    // covers this, so the debit can't push anyone negative.
    let creditsSpent = 0;
    let creditsLeft: number | null = null;
    if (meterCredits && generatedKeys.size) {
      const charsDone = toDo
        .filter(([k]) => generatedKeys.has(k))
        .reduce((n, [, j]) => n + (j.text?.length ?? 0), 0);
      creditsSpent = Math.max(1, Math.ceil(charsDone / CHARS_PER_CREDIT));
      const { data: newBalance } = await supabase.rpc("spend_credits", {
        p_user: payerId,
        p_credits: creditsSpent,
        p_reason: "generation",
        p_ref: script_id,
      });
      creditsLeft = typeof newBalance === "number" ? newBalance : null;
    }

    // Tally what the demo actually generated against the budget. Ops pre-warming
    // (service role) is excluded — it shouldn't eat visitors' allowance.
    if (script_id === DEMO_SCRIPT_ID && generatedKeys.size && !serviceBearer) {
      const genChars = toDo
        .filter(([k]) => generatedKeys.has(k))
        .reduce((n, [, j]) => n + j.text.length, 0);
      const { data: cur } = await supabase
        .from("demo_tts_usage")
        .select("chars")
        .eq("day", todayKey)
        .maybeSingle();
      await supabase
        .from("demo_tts_usage")
        .upsert({ day: todayKey, chars: (cur?.chars ?? 0) + genChars });
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

    if (lockHeld && lockScriptId) {
      lockHeld = false;
      await supabase.rpc("release_generation_lock", { p_script: lockScriptId });
    }

    const remaining = allMisses.length - attempted;

    // Lines of this read that a house voice is standing in for (from this run
    // or any earlier one), and whose they are — so the writer can be told, and
    // can choose another voice for that role if they'd rather have one voice
    // throughout.
    const standIns = entries.filter((e) => {
      const spoke = spokenBy.get(e.audio_key);
      return !!spoke && spoke !== e.voice_id && available(e.audio_key);
    });
    const standInRoles = [
      ...new Set(
        standIns.map((e) =>
          e.type === "dialogue" ? baseCharName(e.character ?? "").toUpperCase() || "A ROLE" : "NARRATOR"
        )
      ),
    ].slice(0, 6);
    // Why this run's failures failed, worst first: "quota" (the studio's own
    // account — nothing the writer can do), "declined" (the voice won't read
    // it and no stand-in could), "storage", else "busy" (worth trying again).
    const kinds = new Set(failures.map((f) => failKind(f.status, f.reason)));
    const failedReason = (["quota", "declined", "storage", "busy"] as FailKind[]).find((k) =>
      kinds.has(k)
    );
    return new Response(
      JSON.stringify({
        success: true,
        script_id,
        unlocked: fullAccess,
        locked,
        preview_limit: locked ? FREE_PREVIEW_LIMIT : 0,
        voice_config_hash: voiceConfigHash,
        manifest_path: manifestPath,
        mode,
        total_lines: entries.length,
        generated_now: generatedKeys.size,
        already_cached: entries.length - allMisses.length,
        failed,
        failed_reason: failedReason,
        stand_ins: standIns.length || undefined,
        stand_in_roles: standInRoles.length ? standInRoles : undefined,
        remaining,
        // Budget-capped demo runs report done so clients don't retry-loop a
        // ceiling that won't lift until tomorrow.
        done: demoBudgetExceeded ? true : remaining === 0,
        demo_budget_exceeded: demoBudgetExceeded || undefined,
        credits_spent: creditsSpent || undefined,
        credits_left: creditsLeft ?? undefined,
        cached: allMisses.length === 0,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Voice cue generation error:", err);
    // The service client is try-scoped; mint a fresh one to release the lock.
    // If even this fails, the 4-minute staleness window clears it.
    if (lockHeld && lockScriptId) {
      try {
        await createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        ).rpc("release_generation_lock", { p_script: lockScriptId });
      } catch (_) {
        /* stale-window backstop */
      }
    }
    return new Response(
      JSON.stringify({ error: "Internal error", details: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
