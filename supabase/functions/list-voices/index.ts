// Returns voices the writer can pick from: the account's voices (ready to use)
// plus a slice of the ElevenLabs shared Voice Library (female-weighted for
// variety). Library voices carry `public_owner_id` and must be added to the
// account before TTS (see the add-voice function).
//
// With `{ search: "boston" }` in the body it answers from the provider's WHOLE
// library instead (the picker's search box): see searchLibrary below.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  cleanGender,
  cleanTerm,
  offerFound,
  Pace,
  Remembered,
  searchKey,
  type FoundVoice,
} from "../_shared/voiceSearch.ts";

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

// Durable copy of the catalog. The in-memory cache above dies with the
// isolate, and on a quiet site nearly every picker open is a cold start —
// which meant paging ~12 ElevenLabs requests while the visitor watched a
// spinner for 25+ seconds (and forever during an ElevenLabs outage). Voices
// barely change week to week, so: serve the stored copy instantly, refresh it
// in the background when stale, and never overwrite it with a thin result.
const CATALOG_PATH = "voice-cues/_catalog/voices.json";
let refreshing = false; // one background refresh per isolate at a time
const MIN_SANE_VOICES = 200;
const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

async function loadDurable(): Promise<{ at: number; data: Voice[] } | null> {
  try {
    const { data, error } = await admin.storage.from("scripts").download(CATALOG_PATH);
    if (error || !data) return null;
    const parsed = JSON.parse(await data.text());
    if (!Array.isArray(parsed?.data) || parsed.data.length < MIN_SANE_VOICES) return null;
    return { at: Number(parsed.at) || 0, data: parsed.data as Voice[] };
  } catch {
    return null;
  }
}

async function saveDurable(entry: { at: number; data: Voice[] }) {
  if (entry.data.length < MIN_SANE_VOICES) return; // never persist an outage
  await admin.storage
    .from("scripts")
    .upload(CATALOG_PATH, new TextEncoder().encode(JSON.stringify(entry)), {
      contentType: "application/json",
      upsert: true,
    });
}

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
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { "xi-api-key": ELEVENLABS_API_KEY! },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      break; // hung or failed — keep what we have
    }
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
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { "xi-api-key": ELEVENLABS_API_KEY! },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      break; // hung or failed — keep what we have
    }
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

// Page through the shared library for a large, diverse, browsable set (the
// picker filters client-side by gender/accent/language/age/search). Page
// depth sets the marketing number: the site says "1,000+ voices", so serve
// comfortably past 1,000 after dedupe.
async function buildCatalog(): Promise<Voice[]> {
  const [account, female, male] = await Promise.all([
    fetchAccountVoices(),
    fetchLibraryVoices("female", 6), // up to ~600
    fetchLibraryVoices("male", 5), // up to ~500
  ]);
  // Drop library voices already in the account — by voice_id AND by name.
  // The same voice often appears in both lists under a slightly different name
  // (a trailing space, a translated label), so a name-only check misses it and
  // leaves a duplicate voice_id, which then breaks the picker's list render.
  const accountNames = new Set(account.map((v) => v.name.toLowerCase()));
  const seen = new Set<string>(account.map((v) => v.voice_id));
  const library = [...female, ...male].filter((v) => {
    if (accountNames.has(v.name.toLowerCase())) return false;
    if (seen.has(v.voice_id)) return false;
    seen.add(v.voice_id);
    return true;
  });
  return [...account, ...library];
}

// ---------------------------------------------------------------------------
// The picker's search box: the provider's whole library, by word.
//
// The list above is a slice (the account's voices and the first pages of the
// library's listing), and the picker's search could only look through that. A
// writer asked for a Boston accent, typed "Boston", and found nothing, though
// the library holds such voices. So a typed word is also put to the provider,
// which searches every shared voice by name, labels and description.
//
// One page of answers (the provider's most taken voices for the word), kept
// for half an hour, so the same word is asked once however many people type
// it. Asked at a limited pace: the function is open to the demo's visitors.
// ---------------------------------------------------------------------------
type SearchAnswer = { voices: FoundVoice[]; total: number | null; more: boolean; left_out: number };
const SEARCH_PAGE = 100;
const searches = new Remembered<SearchAnswer>(CACHE_TTL_MS, 300);
const asking = new Map<string, Promise<SearchAnswer | null>>(); // one request per word at a time
const pace = new Pace(30, 60_000); // provider searches a minute, per isolate

async function askLibrary(term: string, gender: string | null): Promise<SearchAnswer | null> {
  // Most taken first. If the provider won't have the ordering, ask plainly:
  // the answers are put in order here either way.
  for (const sort of ["cloned_by_count", null]) {
    const url = new URL(`${V1}/shared-voices`);
    url.searchParams.set("search", term);
    url.searchParams.set("page_size", String(SEARCH_PAGE));
    url.searchParams.set("page", "0");
    if (sort) url.searchParams.set("sort", sort);
    if (gender) url.searchParams.set("gender", gender);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { "xi-api-key": ELEVENLABS_API_KEY! },
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      console.error(`library search: no answer (${String(e).slice(0, 120)})`);
      return null;
    }
    if (!res.ok) {
      console.error(`library search: provider answered ${res.status}${sort ? ` (sorted by ${sort})` : ""}`);
      // A refused request (not an outage, not a pacing answer) may be the ordering: try once without it.
      if (sort && (res.status === 400 || res.status === 422)) continue;
      return null;
    }
    const json = await res.json().catch(() => null);
    if (!json || !Array.isArray(json.voices)) return null;
    const { voices, skipped } = offerFound(json.voices);
    const total = typeof json.total_count === "number" && json.total_count > 0 ? json.total_count : null;
    // The shape of the page, never the word: enough to see from the logs that
    // the provider did send its most taken voices first.
    // deno-lint-ignore no-explicit-any
    const taken = json.voices.map((v: any) => (typeof v?.cloned_by_count === "number" ? v.cloned_by_count : 0));
    console.log(
      `library search: ${json.voices.length} of ${total ?? "?"} rows${sort ? ` by ${sort}` : ", unsorted"}; ` +
        `first taken ${taken[0] ?? 0} times, last ${taken.at(-1) ?? 0}; ${skipped} not offered`
    );
    return { voices, total, more: json.has_more === true, left_out: skipped };
  }
  return null;
}

// deno-lint-ignore no-explicit-any
async function searchLibrary(asked: any): Promise<Response> {
  const answer = (body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), {
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  const term = cleanTerm(asked?.search);
  if (!term) return answer({ voices: [], search: null, invalid: true });
  const gender = cleanGender(asked?.gender);
  const key = searchKey(term, gender);

  const kept = searches.get(key, Date.now());
  if (kept) return answer({ ...kept, search: term, cached: true });

  let pending = asking.get(key);
  if (!pending) {
    // Not answered, not being asked: this one goes to the provider, if the pace allows.
    if (!pace.allow(Date.now())) return answer({ voices: [], search: term, busy: true });
    pending = askLibrary(term, gender).finally(() => asking.delete(key));
    asking.set(key, pending);
  }
  const found = await pending;
  // A failed search is not kept: the next try asks again.
  if (!found) return answer({ voices: [], search: term, unavailable: true });
  searches.set(key, found, Date.now());
  return answer({ ...found, search: term });
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

    // A word typed into the picker's search box. Every other caller sends an
    // empty body and gets the picker's list, below, exactly as before.
    const asked = req.method === "POST" ? await req.json().catch(() => null) : null;
    if (asked && typeof asked === "object" && "search" in asked) {
      return await searchLibrary(asked);
    }

    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return new Response(JSON.stringify({ voices: cache.data, cached: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=600" },
      });
    }

    const respond = (voices: Voice[], extra: Record<string, unknown>) =>
      new Response(JSON.stringify({ voices, ...extra }), {
        headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=600" },
      });

    // Cold isolate: serve the stored catalog immediately; refresh behind the
    // response if it's stale. Only a first-ever run pays the full fetch.
    const durable = await loadDurable();
    if (durable) {
      cache = durable;
      if (Date.now() - durable.at > CACHE_TTL_MS && !refreshing) {
        refreshing = true;
        const refresh = buildCatalog()
          .then(async (voices) => {
            if (voices.length < MIN_SANE_VOICES) return; // provider degraded — keep the good copy
            const entry = { at: Date.now(), data: voices };
            cache = entry;
            await saveDurable(entry);
          })
          .catch((e) => console.error("list-voices background refresh failed:", e))
          .finally(() => {
            refreshing = false;
          });
        // deno-lint-ignore no-explicit-any
        const rt = (globalThis as any).EdgeRuntime;
        if (rt?.waitUntil) rt.waitUntil(refresh);
      }
      return respond(durable.data, { cached: true, source: "stored" });
    }

    const voices = await buildCatalog();
    const entry = { at: Date.now(), data: voices };
    cache = entry;
    await saveDurable(entry);
    return respond(voices, { cached: false });
  } catch (err) {
    console.error("list-voices error:", err);
    return new Response(
      JSON.stringify({ error: "Internal error", details: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
