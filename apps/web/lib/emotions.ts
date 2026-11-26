// The emotions a writer can give a line. Each is an "audio tag": the line is
// sent to the voice model as "[sad] I told you." and performed that way.
//
// The model takes tags as free text, so this list is a choice, not a limit of
// the provider's. It holds every direction ElevenLabs' own prompting guide
// names for a single line of speech (checked 2026-11-26), plus the ones
// writers here already use. Sound effects ([gunshot]) and accents are left
// out: a table read's narrator handles the first, a voice the second.
//
// `value` is what is sent and what a clip is filed under, so it must stay a
// single lower-case word, and one already in use must never be renamed: a
// script's saved lines hold it. KEEP IN STEP with the EMOTIONS sets in
// supabase/functions/generate-voice-cues and preview-voice-line: a value the
// functions don't know is read with no emotion at all.
export const EMOTIONS: { value: string; label: string }[] = [
  { value: "angry", label: "Angry" },
  { value: "annoyed", label: "Annoyed" },
  { value: "appalled", label: "Appalled" },
  { value: "calm", label: "Calm" },
  { value: "cheerfully", label: "Cheerful" },
  { value: "crying", label: "Crying" },
  { value: "curious", label: "Curious" },
  { value: "deadpan", label: "Deadpan" },
  { value: "dramatically", label: "Dramatic" },
  { value: "excited", label: "Excited" },
  { value: "frustrated", label: "Frustrated" },
  { value: "happy", label: "Happy" },
  { value: "laughing", label: "Laughing" },
  { value: "mischievously", label: "Mischievous" },
  { value: "muttering", label: "Muttering" },
  { value: "nervous", label: "Nervous" },
  { value: "sad", label: "Sad" },
  { value: "sarcastic", label: "Sarcastic" },
  { value: "scared", label: "Scared" },
  { value: "shouts", label: "Shout" },
  { value: "sighs", label: "Sighing" },
  { value: "surprised", label: "Surprised" },
  { value: "thoughtful", label: "Thoughtful" },
  { value: "tired", label: "Tired" },
  { value: "warmly", label: "Warm" },
  { value: "whispers", label: "Whisper" },
];

const NARRATOR = "__narrator__";

/**
 * Where the picker opens when it is opened to direct a line (the demo's "Edit
 * Lines & Add Emotions"): the first line of the first role an AI voice reads,
 * a character before the narrator. A role an actor's recording reads has no
 * voice settings and so no emotion to choose; with no such role at all there
 * is nothing to open on, and the picker shows its cast list as usual.
 */
export function firstLineToDirect(o: {
  characters: string[];
  voices: { narrator_voice_id?: string | null; characters?: Record<string, string> | null };
  /** Role → the actor's read cast in it, if one is. */
  cast: Record<string, string | undefined>;
  linesByRole: Record<string, { index: number; text: string }[] | undefined>;
}): { role: string; line: number } | null {
  const voiceOf = (r: string) => (r === NARRATOR ? o.voices.narrator_voice_id : o.voices.characters?.[r]);
  const usable = (r: string) => !o.cast[r] && !!voiceOf(r) && (o.linesByRole[r]?.length ?? 0) > 0;
  const all = [NARRATOR, ...o.characters.map((c) => c.toUpperCase())];
  const role = all.find((r) => r !== NARRATOR && usable(r)) ?? all.find(usable);
  return role ? { role, line: o.linesByRole[role]![0].index } : null;
}
