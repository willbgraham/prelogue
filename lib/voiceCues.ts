import { supabase } from "./supabase";

export interface VoiceCueEntry {
  element_index: number;
  type?: string;
  character?: string | null;
  text?: string;
  voice_id?: string;
  audio_path: string;
  signedUrl: string;
}

// generate-voice-cues caps generation per call (resumable). A full first-time
// script can need many rounds; cap generously since cached re-runs are instant.
const MAX_ROUNDS = 40;

/**
 * Drive `generate-voice-cues` to completion for a script, reporting 0..1
 * progress, then load + freshly sign the manifest (signed URLs expire). The
 * function is resumable + content-addressed server-side, so a second call with
 * the same writer voices is effectively instant.
 *
 * Looping all the way to `done` is important: stopping early (the old 10-round
 * cap) left lines with no audio, which is why playback was silent.
 *
 * Pass `shouldCancel` to bail when the screen is left — this prevents stray
 * playback and the "double play" that happened when a stale prepare finished
 * after navigating away.
 */
export async function prepareVoiceCues(
  scriptId: string,
  onProgress?: (pct: number) => void,
  shouldCancel?: () => boolean
): Promise<Map<number, VoiceCueEntry>> {
  let manifestPath: string | null = null;
  let initialMisses = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (shouldCancel?.()) return new Map();

    const { data, error } = await supabase.functions.invoke("generate-voice-cues", {
      body: { script_id: scriptId },
    });
    if (error) throw new Error(error?.message ?? String(error));
    if (data?.error) throw new Error(data.error);

    manifestPath = data?.manifest_path ?? manifestPath;
    const remaining = Number(data?.remaining ?? 0);
    const generated = Number(data?.generated_now ?? 0);
    const failed = Number(data?.failed ?? 0);

    // On the first round, remaining + work-done = the total to generate.
    if (round === 0) initialMisses = generated + failed + remaining;
    if (onProgress) {
      onProgress(
        initialMisses <= 0 ? 1 : Math.min(0.99, (initialMisses - remaining) / initialMisses)
      );
    }
    if (data?.done) break;
  }

  if (shouldCancel?.()) return new Map();

  const map = new Map<number, VoiceCueEntry>();
  if (!manifestPath) return map;

  const { data: signed } = await supabase.storage
    .from("scripts")
    .createSignedUrl(manifestPath, 3600);
  if (!signed?.signedUrl) return map;

  const res = await fetch(signed.signedUrl);
  const cues: Omit<VoiceCueEntry, "signedUrl">[] = await res.json();

  const uniquePaths = [...new Set(cues.map((c) => c.audio_path))];
  const urlByPath = new Map<string, string>();
  if (uniquePaths.length) {
    const { data: fresh } = await supabase.storage
      .from("scripts")
      .createSignedUrls(uniquePaths, 86400);
    uniquePaths.forEach((p, i) => urlByPath.set(p, fresh?.[i]?.signedUrl ?? ""));
  }
  for (const c of cues) {
    map.set(c.element_index, { ...c, signedUrl: urlByPath.get(c.audio_path) ?? "" });
  }
  onProgress?.(1);
  return map;
}
