// What a script records about the voices chosen for it:
// scripts.voice_config.voice_info, keyed by voice id, written by the web
// picker when a voice is chosen.
//
// It is there because a voice is not always in the picker's own list
// (voice-cues/_catalog/voices.json): one found by searching the provider's
// whole library joins that list only after it has been used and the list has
// next been rebuilt, and the list's library slice turns over as new voices
// arrive. Without this note such a voice has no name on the cast list, and a
// line it declines would get a stand-in chosen with no idea whether the voice
// was a man's or a woman's.
//
// The note is written by the writer's own page, so it is trusted only as far
// as that goes: a name to show on their own script, and which sort of house
// voice stands in on their own read.

const KEYS = ["gender", "age", "accent"] as const;

/** The labels a stand-in is chosen by, as recorded when the voice was chosen; null when nothing usable was. */
export function recordedLabels(cfg: unknown, voiceId: string): Record<string, string> | null {
  // deno-lint-ignore no-explicit-any
  const info = (cfg as any)?.voice_info?.[voiceId];
  if (!info || typeof info !== "object") return null;
  const out: Record<string, string> = {};
  for (const key of KEYS) {
    const v = info[key];
    if (typeof v === "string" && v && v.length <= 40) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}
