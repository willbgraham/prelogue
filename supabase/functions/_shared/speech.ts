// How a line is asked of the voice provider, and what its clip is called.
//
// A plain line is voiced by the fast model at the provider's text-to-speech
// address. A line with an emotion ("[sad] …") needs a model that acts on
// audio tags. Until November 2026 that was eleven_v3, at the same address.
// It is eleven_v4 now: the provider's current model for directed delivery,
// the same price per character as v3, and served only at its text-to-dialogue
// address. That takes a differently shaped request: a list of turns (one
// turn in one voice is a line) and settings named `similarity` where
// text-to-speech says `similarity_boost`.
//
// eleven_v3 stays on as the understudy. Whatever v4 answers that isn't audio,
// v3 is asked for the same line in the same voice, so the move can't cost a
// read a line.
//
// A clip is named for the model that voiced it: …_v4sads50b75.mp3 or
// …_v3sads50b75.mp3. A read plays whichever it has, v4 first. So the emotion
// clips made before the move are still found (nobody pays for a line twice,
// and no read changes under its writer), and a v3 clip is never mistaken for
// a v4 one.
//
// Used by generate-voice-cues and preview-voice-line, which must agree on
// every name here: a preview's clip is the clip the read plays.

/** Voices a line with no emotion. */
export const PLAIN_MODEL = "eleven_flash_v2_5";
/** Voices a line with an emotion. */
export const EMOTION_MODEL = "eleven_v4";
/** Voiced them before, and still does when EMOTION_MODEL won't. */
export const EMOTION_MODEL_BEFORE = "eleven_v3";

const OUTPUT_FORMAT = "mp3_22050_32";

/**
 * Stability for an emotion line is one of three: 0 Creative, 0.5 Natural,
 * 1 Robust. eleven_v3 accepts nothing else. Kept for eleven_v4 so a line's
 * settings mean the same whichever of the two voices it, and so the picker's
 * note to the writer ("Stability snaps to…") stays true.
 */
export const snapStability = (v: number) => (v < 0.25 ? 0 : v < 0.75 ? 0.5 : 1);

export type EmotionLine = {
  /** Sent to the provider (text-to-speech names; `speechRequest` renames them where needed). */
  settings: { stability: number; similarity_boost: number };
  /** Goes in front of the line's text: the direction itself. */
  prefix: string;
  /** Ends the name of a clip EMOTION_MODEL voiced. */
  tag: string;
  /** Ends the name of a clip EMOTION_MODEL_BEFORE voiced. */
  tagBefore: string;
};

/** A line with an emotion: what is asked for, and the two names its clip can have. */
export function emotionLine(emotion: string, stability: number, similarityBoost: number): EmotionLine {
  const stab = snapStability(stability);
  const rest = `${emotion}s${Math.round(stab * 100)}b${Math.round(similarityBoost * 100)}`;
  return {
    settings: { stability: stab, similarity_boost: similarityBoost },
    prefix: `[${emotion}] `,
    tag: `_v4${rest}`,
    tagBefore: `_v3${rest}`,
  };
}

/** Where to send a line and what to send, for the model that is to voice it. */
export function speechRequest(
  base: string,
  voiceId: string,
  ask: { text: string; model?: string; settings: Record<string, number> }
): { url: string; body: Record<string, unknown> } {
  const model = ask.model ?? PLAIN_MODEL;
  if (model === EMOTION_MODEL) {
    return {
      url: `${base}/text-to-dialogue?output_format=${OUTPUT_FORMAT}`,
      body: {
        inputs: [{ text: ask.text, voice_id: voiceId }],
        model_id: model,
        settings: { stability: ask.settings.stability, similarity: ask.settings.similarity_boost },
      },
    };
  }
  return {
    url: `${base}/text-to-speech/${voiceId}?output_format=${OUTPUT_FORMAT}`,
    body: { text: ask.text, model_id: model, voice_settings: ask.settings },
  };
}

/**
 * Is a 2xx answer actually a clip? An empty body, or one that says it is JSON
 * or text, is not: stored, it would be a silent line that looks voiced for
 * ever after.
 */
export function isAudio(contentType: string | null, bytes: number): boolean {
  return bytes > 0 && !/json|text\//i.test(contentType ?? "");
}
