/**
 * How many voice credits the one-time unlock of a script includes.
 *
 * The unlock used to grant a flat 150 credits. That covers an ordinary feature
 * with room to spare (a 105-page script needs about 90), but a script that is
 * mostly description needs far more: a 107-page one needed 175, so its writer
 * paid $19 for "the full read", ran out part-way and had to buy a top-up. The
 * grant now follows the script: one full read of it, plus a quarter again for
 * re-casting, never less than the old 150.
 *
 * Pure logic, no I/O and no Deno APIs, so it runs the same in the edge
 * functions and in a plain Node test.
 * KEEP IN SYNC with apps/web/lib/shared/plans.ts (the page shows the figure
 * before purchase; create-checkout-session fixes it at checkout; stripe-webhook
 * grants it).
 */

/** Characters of speech per credit. */
export const CHARS_PER_CREDIT = 1000;

/** The least an unlock includes: what every unlock included before it was sized. */
export const UNLOCK_MIN_CREDITS = 150;

/**
 * The most an unlock includes. A credit costs us about 4 cents of speech, so
 * 400 is $16 against the $19 paid (less the card fee): still not a loss if every
 * one of them is used. The longest script seen so far needs 321.
 */
export const UNLOCK_MAX_CREDITS = 400;

/**
 * Characters that are read aloud in a stored parse (pass scripts.parsed_json's
 * `scenes`): dialogue and action, counted the way generate-voice-cues counts
 * what it bills (whitespace collapsed, ends trimmed). Speaker names,
 * parentheticals and scene headings are not spoken.
 */
export function spokenChars(scenes: unknown): number {
  let chars = 0;
  if (!Array.isArray(scenes)) return 0;
  for (const scene of scenes) {
    const elements = (scene as { elements?: unknown } | null)?.elements;
    if (!Array.isArray(elements)) continue;
    for (const el of elements) {
      const type = (el as { type?: unknown } | null)?.type;
      if (type !== "dialogue" && type !== "action") continue;
      const text = (el as { text?: unknown }).text;
      if (typeof text !== "string") continue;
      chars += text.replace(/\s+/g, " ").trim().length;
    }
  }
  return chars;
}

/** Credits one full read costs, by its spoken characters (0 for nothing to read). */
export function creditsForChars(chars: number): number {
  return chars > 0 && isFinite(chars) ? Math.ceil(chars / CHARS_PER_CREDIT) : 0;
}

/** Credits the one-time unlock includes for a script with this many spoken characters. */
export function unlockCreditsForChars(chars: number): number {
  const read = creditsForChars(chars);
  // A full read and a quarter again (whole credits, so no rounding surprises).
  const sized = read + Math.ceil(read / 4);
  return Math.min(UNLOCK_MAX_CREDITS, Math.max(UNLOCK_MIN_CREDITS, sized));
}

/** The same, straight from a stored parse. */
export function unlockCreditsForScenes(scenes: unknown): number {
  return unlockCreditsForChars(spokenChars(scenes));
}

/**
 * The figure create-checkout-session wrote into the Stripe session, if it is
 * one this rule could have produced. Anything else (an older session with no
 * figure, or a value that is not ours) is ignored and the caller works it out
 * again from the script.
 */
export function unlockCreditsFromMetadata(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{1,4}$/.test(value)) return null;
  const n = Number(value);
  return n >= UNLOCK_MIN_CREDITS && n <= UNLOCK_MAX_CREDITS ? n : null;
}
