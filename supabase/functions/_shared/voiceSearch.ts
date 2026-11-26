// Searching the voice provider's whole library by word, for the picker's
// search box.
//
// The picker's own list (list-voices' catalog) is the account's voices plus
// about a thousand library voices: the first pages of the provider's listing,
// which is its newest voices. A writer who typed "Boston" found nothing,
// because no voice in that slice carries the word, while the provider's
// library holds several. The search box now asks the provider as well.
//
// These are the parts with no network in them: what counts as a search term,
// which of the provider's rows may be offered, and in what order.

/** A voice as the picker lists it (list-voices' `Voice`), with what a search adds. */
export interface FoundVoice {
  voice_id: string;
  name: string;
  category: string | null;
  labels: Record<string, string>;
  preview_url: string | null;
  public_owner_id?: string | null;
  /** The owner's own line about the voice. A search often matches on this, so the picker shows it. */
  description?: string;
  /** The owner has live moderation on: the voice can decline a line (a house voice then reads it). */
  moderated?: true;
}

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 60;

/** A search term as the provider is asked for it (trimmed, single-spaced, lower case), or null when it isn't one. */
export function cleanTerm(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const term = raw
    .normalize("NFKC")
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (term.length < SEARCH_MIN || term.length > SEARCH_MAX) return null;
  return term;
}

/** The picker's Gender filter, when it is one the provider's listing filters by. */
export function cleanGender(raw: unknown): "male" | "female" | "neutral" | null {
  const g = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return g === "male" || g === "female" || g === "neutral" ? g : null;
}

const LABEL_KEYS = ["gender", "accent", "language", "age", "descriptive", "use_case"];

/**
 * True when the voice's owner charges more than the standard rate. A read is
 * charged to the writer by its characters at one price, so such a voice would
 * cost more to voice than the read is charged for: it is not offered.
 */
// deno-lint-ignore no-explicit-any
export function costsExtra(row: any): boolean {
  if (typeof row?.rate === "number" && row.rate > 1) return true;
  return typeof row?.fiat_rate === "number" && row.fiat_rate > 0;
}

/** One row of the provider's library listing as a voice the picker can offer, or null when it can't. */
// deno-lint-ignore no-explicit-any
export function fromLibraryRow(row: any): FoundVoice | null {
  if (!row || typeof row.voice_id !== "string" || !row.voice_id) return null;
  if (typeof row.name !== "string" || !row.name.trim()) return null;
  if (costsExtra(row)) return null;
  const labels: Record<string, string> = {};
  for (const key of LABEL_KEYS) {
    const v = row[key];
    if (v) labels[key] = String(v);
  }
  const description =
    typeof row.description === "string" ? row.description.replace(/\s+/g, " ").trim().slice(0, 240) : "";
  return {
    voice_id: row.voice_id,
    name: row.name,
    category: row.category ?? "library",
    labels,
    preview_url: typeof row.preview_url === "string" && row.preview_url ? row.preview_url : null,
    public_owner_id: row.public_owner_id ?? null,
    ...(description ? { description } : {}),
    ...(row.live_moderation_enabled === true ? { moderated: true as const } : {}),
  };
}

/**
 * The provider's rows for one search as the picker's list: voices that may be
 * offered, one of each, the ones that never decline a line first, and within
 * each sort the most used first (by how many people have taken the voice, then
 * by how much it has been used in the last year).
 */
// deno-lint-ignore no-explicit-any
export function offerFound(rows: any[]): { voices: FoundVoice[]; skipped: number } {
  const seen = new Set<string>();
  const kept: { voice: FoundVoice; users: number; used: number; at: number }[] = [];
  let skipped = 0;
  (Array.isArray(rows) ? rows : []).forEach((row, at) => {
    const voice = fromLibraryRow(row);
    if (!voice) {
      skipped++;
      return;
    }
    if (seen.has(voice.voice_id)) return;
    seen.add(voice.voice_id);
    const n = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : 0);
    kept.push({ voice, users: n(row.cloned_by_count), used: n(row.usage_character_count_1y), at });
  });
  kept.sort(
    (a, b) =>
      Number(!!a.voice.moderated) - Number(!!b.voice.moderated) ||
      b.users - a.users ||
      b.used - a.used ||
      a.at - b.at
  );
  return { voices: kept.map((k) => k.voice), skipped };
}

/** What a search is remembered under: the same word with the same filter is asked of the provider once. */
export function searchKey(term: string, gender: string | null): string {
  return `${gender ?? ""}|${term}`;
}

/**
 * Answers kept for a while, so a word typed twice (or by two writers) is asked
 * of the provider once. Oldest out when full.
 */
export class Remembered<T> {
  private kept = new Map<string, { at: number; value: T }>();
  private ttlMs: number;
  private max: number;
  constructor(ttlMs: number, max: number) {
    this.ttlMs = ttlMs;
    this.max = max;
  }
  get(key: string, now: number): T | undefined {
    const hit = this.kept.get(key);
    if (!hit) return undefined;
    if (now - hit.at > this.ttlMs) {
      this.kept.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key: string, value: T, now: number) {
    this.kept.delete(key);
    this.kept.set(key, { at: now, value });
    while (this.kept.size > this.max) {
      const oldest = this.kept.keys().next().value;
      if (oldest === undefined) break;
      this.kept.delete(oldest);
    }
  }
  get size() {
    return this.kept.size;
  }
}

/** No more than `max` in any `windowMs`: the picker's search box must not become a way to hammer the provider. */
export class Pace {
  private times: number[] = [];
  private max: number;
  private windowMs: number;
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }
  allow(now: number): boolean {
    this.times = this.times.filter((t) => now - t < this.windowMs);
    if (this.times.length >= this.max) return false;
    this.times.push(now);
    return true;
  }
}
