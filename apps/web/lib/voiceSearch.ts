// The voice picker's search box, beyond the picker's own list.
//
// The picker's list is a slice of the voice library (about 1,200 voices). A
// writer who wanted a Boston accent typed "Boston" and found nothing, though
// the library holds such voices: the search only looked through the slice,
// and only at names and labels. So a typed word is also put to the whole
// library (list-voices with `{ search }`), and its matches are listed under
// the picker's own.
//
// Also here: what a script records about the voices chosen for it
// (voice_config.voice_info), so a voice that is not in the picker's list still
// has its name on the cast list.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChosenVoiceInfo, VoiceCatalogItem, VoiceConfig } from "@/lib/shared";

/** The fewest letters worth putting to the whole library. */
export const LIBRARY_SEARCH_MIN = 3;
const LIBRARY_SEARCH_MAX = 60;
/** How long the typing has to rest before the library is asked. */
export const LIBRARY_SEARCH_PAUSE_MS = 450;

/** The search box's text as a word to put to the whole library, or null when it is too short to be one. */
export function libraryTerm(raw: string): string | null {
  const term = (raw ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return term.length >= LIBRARY_SEARCH_MIN && term.length <= LIBRARY_SEARCH_MAX ? term : null;
}

/** The picker's Gender filter, when it is one the library can be asked by. */
export function libraryGender(raw: string | null | undefined): "male" | "female" | "neutral" | null {
  const g = (raw ?? "").trim().toLowerCase();
  return g === "male" || g === "female" || g === "neutral" ? g : null;
}

/** What one search is kept under while the picker is open. */
export function libraryKey(term: string, gender: string | null): string {
  return `${gender ?? ""}|${term}`;
}

export type LibraryResult =
  | { state: "found"; voices: VoiceCatalogItem[]; total: number | null; more: boolean }
  | { state: "unavailable" };

type Invoker = { functions: Pick<SupabaseClient["functions"], "invoke"> };

/** Put a word to the whole library. Never throws: any trouble is "unavailable", and the picker's own list stands. */
export async function searchLibrary(client: Invoker, term: string, gender: string | null): Promise<LibraryResult> {
  try {
    const { data, error } = await client.functions.invoke("list-voices", {
      body: { search: term, ...(gender ? { gender } : {}) },
    });
    const d = data as {
      voices?: unknown;
      search?: unknown;
      total?: unknown;
      more?: unknown;
      unavailable?: unknown;
      busy?: unknown;
    } | null;
    // A server from before the search existed ignores the word and sends its
    // whole list; one that is busy or couldn't reach the library says so.
    if (error || !d || d.search !== term || d.unavailable || d.busy || !Array.isArray(d.voices)) {
      return { state: "unavailable" };
    }
    const seen = new Set<string>();
    const voices: VoiceCatalogItem[] = [];
    for (const v of d.voices as Partial<VoiceCatalogItem>[]) {
      if (!v || typeof v.voice_id !== "string" || !v.voice_id || typeof v.name !== "string") continue;
      if (seen.has(v.voice_id)) continue;
      seen.add(v.voice_id);
      voices.push({
        voice_id: v.voice_id,
        name: v.name,
        category: v.category ?? null,
        labels: v.labels && typeof v.labels === "object" ? v.labels : {},
        preview_url: typeof v.preview_url === "string" ? v.preview_url : null,
        public_owner_id: v.public_owner_id ?? null,
        ...(typeof v.description === "string" && v.description ? { description: v.description } : {}),
        ...(v.moderated === true ? { moderated: true } : {}),
      });
    }
    return {
      state: "found",
      voices,
      total: typeof d.total === "number" && d.total > 0 ? d.total : null,
      more: d.more === true,
    };
  } catch {
    return { state: "unavailable" };
  }
}

/**
 * A label as it is compared. The same thing is written three ways: the library
 * says "middle_aged", the account's own voices "middle-aged" or "Middle Aged".
 */
export function labelKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}
const same = (a: string, b: string) => labelKey(a) === labelKey(b);

/** The picker's dropdown filters (gender, accent, language, age), as they apply to any voice. */
export function matchesFilters(
  voice: Pick<VoiceCatalogItem, "labels">,
  filters: Record<string, string>,
  keys: string[]
): boolean {
  for (const key of keys) {
    const want = filters[key];
    if (want && !same(String(voice.labels?.[key] ?? ""), want)) return false;
  }
  return true;
}

/**
 * The library's matches that belong under the picker's own: not already
 * listed above, and passing the same dropdown filters. `hidden` says whether
 * the filters held any back.
 */
export function moreFromLibrary(
  found: VoiceCatalogItem[],
  listed: Set<string>,
  filters: Record<string, string>,
  keys: string[]
): { voices: VoiceCatalogItem[]; hidden: boolean } {
  const voices: VoiceCatalogItem[] = [];
  let hidden = false;
  for (const v of found) {
    if (listed.has(v.voice_id)) continue;
    if (matchesFilters(v, filters, keys)) voices.push(v);
    else hidden = true;
  }
  return { voices, hidden };
}

// ---------------------------------------------------------------------------
// What a script records about its chosen voices
// ---------------------------------------------------------------------------
const short = (v: unknown) => (typeof v === "string" && v.trim() && v.length <= 40 ? v.trim() : undefined);

/** A voice as the script records it when it is chosen. */
export function voiceInfo(voice: Pick<VoiceCatalogItem, "name" | "labels">): ChosenVoiceInfo {
  const gender = short(voice.labels?.gender);
  const age = short(voice.labels?.age);
  const accent = short(voice.labels?.accent);
  return {
    name: voice.name.trim().slice(0, 120),
    ...(gender ? { gender } : {}),
    ...(age ? { age } : {}),
    ...(accent ? { accent } : {}),
  };
}

type Assigned = Pick<VoiceConfig, "narrator_voice_id" | "single_voice_id" | "characters">;

/** Every voice a config gives a part to, in a steady order. */
export function assignedVoices(cfg: Assigned | null | undefined): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v && !out.includes(v)) out.push(v);
  };
  add(cfg?.narrator_voice_id);
  add(cfg?.single_voice_id);
  for (const v of Object.values(cfg?.characters ?? {})) add(v);
  return out;
}

/**
 * The voice notes to save with a config: those the script already held, for
 * voices that still have a part, and a new one for each voice brought into
 * the script here. A voice that already had its part and no note gains none
 * from being pressed again, so re-applying an unchanged cast saves the
 * unchanged config (the player takes a changed config for a re-cast).
 * Undefined when there is nothing to record.
 */
export function voiceInfoToSave(
  cfg: Assigned,
  start: (Assigned & Pick<VoiceConfig, "voice_info">) | null | undefined,
  picked: Record<string, Pick<VoiceCatalogItem, "name" | "labels">>
): Record<string, ChosenVoiceInfo> | undefined {
  const now = assignedVoices(cfg);
  const before = new Set(assignedVoices(start));
  const out: Record<string, ChosenVoiceInfo> = {};
  for (const [id, info] of Object.entries(start?.voice_info ?? {})) {
    if (now.includes(id) && info && typeof info.name === "string") out[id] = info;
  }
  for (const id of now) {
    if (!(id in out) && picked[id] && !before.has(id)) out[id] = voiceInfo(picked[id]);
  }
  return Object.keys(out).length ? out : undefined;
}

/** The name a script recorded for a voice, when the picker's list no longer (or doesn't yet) hold it. */
export function recordedVoiceName(
  cfg: Pick<VoiceConfig, "voice_info"> | null | undefined,
  voiceId: string | null | undefined
): string | null {
  if (!voiceId) return null;
  const name = cfg?.voice_info?.[voiceId]?.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}
