const crypto = require("crypto");

// Generate a fresh scene with Claude, persist it as a HIDDEN house-account
// script (parsed_json + characters + auto voice_config, full_read_unlocked),
// then render it. Env: ANTHROPIC_API_KEY, optional ANTHROPIC_MODEL.
const HOUSE_USERNAME = "prelogue-originals";
const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_NARRATOR = "onwK4e9ZLuTAKqWW03F9";

const SYSTEM = [
  "You are a screenwriter. Write a short, self-contained dramatic scene for a social-media table read.",
  "Rules: 2-4 characters; ~10-16 dialogue lines; a strong hook in the first beat and a twist or button at the end;",
  "vivid but concise action lines; PG-13 at most; no real people or copyrighted characters.",
  "Respond with ONLY valid JSON (no markdown, no prose) matching exactly:",
  '{"title":str,"genre":str,"logline":str,"synopsis":str,',
  '"scenes":[{"heading":"INT./EXT. PLACE - TIME","elements":[{"type":"action"|"character"|"dialogue","character_name":str?,"text":str}]}],',
  '"characters":[{"name":str,"gender":"male"|"female"|"neutral"}]}',
  "Element rules: a 'character' element (text = the NAME in caps) immediately precedes each run of that character's 'dialogue' elements;",
  "'action' elements are narration/stage directions; all character names UPPERCASE.",
].join(" ");

const GENRES = [
  "thriller", "dark comedy", "sci-fi", "noir", "romance", "horror", "heist",
  "western", "workplace comedy", "psychological drama", "mystery", "crime",
  "fantasy", "period drama", "coming-of-age", "family drama", "war", "sports",
];

async function generateScene(apiKey, model) {
  // Force a random genre each run — the model otherwise converges on the same
  // heist/forgery premise despite "vary the genre".
  const genre = GENRES[Math.floor(Math.random() * GENRES.length)];
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 2500,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Write a fresh, original ${genre.toUpperCase()} scene now — a specific premise, characters, and setting you would not typically default to (NOT art forgery or a heist unless the genre is heist). Keep it punchy: ~10-16 dialogue lines. Return only the JSON.`,
        },
      ],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error("anthropic: " + JSON.stringify(data.error));
  const text = (data.content || []).map((c) => c.text || "").join("");
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text);
}

async function buildVoiceConfig(supabaseUrl, serviceKey, characters) {
  let voices = [];
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/list-voices`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "content-type": "application/json" },
      body: "{}",
    });
    voices = (await res.json()).voices || [];
  } catch (_) {
    /* fall back to defaults below */
  }
  const pools = { male: [], female: [], neutral: [] };
  for (const v of voices) {
    const g = ((v.labels && v.labels.gender) || "").toLowerCase();
    if (g.includes("female")) pools.female.push(v.voice_id);
    else if (g.includes("male")) pools.male.push(v.voice_id);
    else pools.neutral.push(v.voice_id);
  }
  const all = voices.map((v) => v.voice_id);
  const used = new Set();
  const pick = (gender) => {
    const pool = pools[gender] && pools[gender].length ? pools[gender] : all;
    for (const id of pool) if (!used.has(id)) return (used.add(id), id);
    return (pool[0] || DEFAULT_NARRATOR);
  };
  const chars = {};
  for (const c of characters || []) {
    const g = (c.gender || "neutral").toLowerCase();
    const gg = g.startsWith("m") ? "male" : g.startsWith("f") ? "female" : "neutral";
    chars[String(c.name || "").toUpperCase()] = pick(gg);
  }
  return {
    mode: "per_character",
    narrator_voice_id: DEFAULT_NARRATOR,
    single_voice_id: null,
    characters: chars,
    updated_at: new Date().toISOString(),
  };
}

async function generateAndRenderDaily({ supabase, supabaseUrl, serviceKey }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const { data: house } = await supabase.from("users").select("id").eq("username", HOUSE_USERNAME).single();
  if (!house) throw new Error("house account missing — run scripts/seed-infra.js");

  const scene = await generateScene(apiKey, model);

  const scenes = (scene.scenes || []).map((s, i) => {
    // Claude puts each speaker's name in a "character" element (often only in
    // `text`) and omits character_name on the dialogue. Propagate the speaker
    // onto the following dialogue so labels AND per-character voices work —
    // buildRows / generate-voice-cues key on dialogue.character_name.
    let speaker;
    const elements = (s.elements || []).map((el) => {
      if (el.type === "character") {
        speaker = String(el.character_name || el.text || "").toUpperCase() || speaker;
        return { type: "character", character_name: speaker, text: el.text || speaker || "" };
      }
      if (el.type === "dialogue" || el.type === "parenthetical") {
        const cn = el.character_name ? String(el.character_name).toUpperCase() : speaker;
        return { type: el.type, character_name: cn, text: el.text || "" };
      }
      return { type: el.type, text: el.text || "" };
    });
    return { heading: s.heading || "", scene_index: i, elements };
  });
  const lineCount = {};
  for (const s of scenes) for (const el of s.elements) {
    if (el.type === "dialogue" && el.character_name) lineCount[el.character_name] = (lineCount[el.character_name] || 0) + 1;
  }
  const characters = (scene.characters || []).map((c) => {
    const name = String(c.name || "").toUpperCase();
    return { name, description: null, line_count: lineCount[name] || 0 };
  });
  const parsed_json = { scenes, characters: characters.map((c) => ({ ...c, lines: [] })) };
  const voice_config = await buildVoiceConfig(supabaseUrl, serviceKey, scene.characters);

  const scriptId = crypto.randomUUID();
  const { error: insErr } = await supabase.from("scripts").insert({
    id: scriptId,
    writer_id: house.id,
    title: scene.title || "Untitled Scene",
    genre: scene.genre || "Drama",
    logline: scene.logline || "",
    synopsis: scene.synopsis || null,
    file_url: "generated/none.pdf",
    status: "open",
    visibility: "hidden",
    full_read_unlocked: true,
    format: "short",
    submission_deadline: "2099-12-31",
    parsed_json,
    voice_config,
  });
  if (insErr) throw insErr;
  if (characters.length) {
    await supabase
      .from("characters")
      .insert(characters.map((c) => ({ script_id: scriptId, name: c.name, description: null, line_count: c.line_count })));
  }
  console.log(`generated script ${scriptId}: "${scene.title}" (${scene.genre})`);

  const { renderScene } = require("./renderScene");
  return renderScene({ supabase, supabaseUrl, serviceKey, scriptId, variant: "ai" });
}

module.exports = { generateAndRenderDaily, generateScene, buildVoiceConfig };
