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

async function ttsAndUpload(
  job: { voiceId: string; text: string; path: string; model?: string },
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
            model_id: job.model ?? "eleven_flash_v2_5",
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
    // flipped by the Stripe webhook / subscription-unlock). A locked script
    // voices NOTHING — the public demo is the free tryout; your own script is
    // paid. Enforced here (service role) so it can't be bypassed from the client.
    const FREE_PREVIEW_LIMIT = 0; // spoken elements voiced before unlock
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
    const serviceBearer =
      (authHeader ?? "").replace(/^Bearer\s+/i, "") === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
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
      const bearer = (authHeader ?? "").replace(/^Bearer\s+/i, "");
      const isService = !!bearer && bearer === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
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
    const distinctJobs = new Map<
      string,
      { voiceId: string; text: string; path: string; settings: Record<string, number>; model?: string }
    >();
    for (const e of entries) {
      if (!distinctJobs.has(e.audio_key)) {
        distinctJobs.set(e.audio_key, {
          voiceId: e.voice_id,
          text: e.tts_text, // emotion lines carry their "[tag] " prefix
          path: e.audio_path,
          settings: e.settings,
          model: e.model,
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

    // Tally what the demo actually generated against the daily budget.
    if (script_id === DEMO_SCRIPT_ID && generatedKeys.size) {
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
        // Budget-capped demo runs report done so clients don't retry-loop a
        // ceiling that won't lift until tomorrow.
        done: demoBudgetExceeded ? true : remaining === 0,
        demo_budget_exceeded: demoBudgetExceeded || undefined,
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
