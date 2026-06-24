import type { SupabaseClient } from "@supabase/supabase-js";
import type { VoiceConfig } from "./types";

export interface VoiceCueEntry {
  element_index: number;
  type?: string;
  character?: string | null;
  text?: string;
  voice_id?: string;
  audio_path: string;
  signedUrl: string;
}

// generate-voice-cues caps generation per call (resumable); loop to `done`.
const MAX_ROUNDS = 40;

export interface PrepareVoiceCuesOptions {
  onProgress?: (pct: number) => void;
  shouldCancel?: () => boolean;
  /**
   * Optional per-request voice override (visitor voice-picking). Forwarded to
   * generate-voice-cues; when omitted the server uses scripts.voice_config.
   * Requires the additive backend tweak that reads body.voice_config.
   */
  voiceConfig?: VoiceConfig | null;
}

/**
 * Client-injected port of the mobile `prepareVoiceCues`: drive
 * `generate-voice-cues` to completion (0..1 progress), then load + freshly
 * re-sign the manifest (signed URLs expire ~24h). Pass any Supabase client
 * (browser or server); pass `shouldCancel` to bail when the view unmounts.
 */
export async function prepareVoiceCues(
  client: SupabaseClient,
  scriptId: string,
  opts: PrepareVoiceCuesOptions = {}
): Promise<Map<number, VoiceCueEntry>> {
  const { onProgress, shouldCancel, voiceConfig } = opts;
  let manifestPath: string | null = null;
  let initialMisses = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (shouldCancel?.()) return new Map();

    const body: Record<string, unknown> = { script_id: scriptId };
    if (voiceConfig) body.voice_config = voiceConfig;

    const { data, error } = await client.functions.invoke("generate-voice-cues", { body });
    if (error) throw new Error((error as any)?.message ?? String(error));
    if ((data as any)?.error) throw new Error((data as any).error);

    manifestPath = (data as any)?.manifest_path ?? manifestPath;
    const remaining = Number((data as any)?.remaining ?? 0);
    const generated = Number((data as any)?.generated_now ?? 0);
    const failed = Number((data as any)?.failed ?? 0);

    if (round === 0) initialMisses = generated + failed + remaining;
    if (onProgress) {
      onProgress(
        initialMisses <= 0 ? 1 : Math.min(0.99, (initialMisses - remaining) / initialMisses)
      );
    }
    if ((data as any)?.done) break;
  }

  if (shouldCancel?.()) return new Map();

  const map = new Map<number, VoiceCueEntry>();
  if (!manifestPath) return map;

  const { data: signed } = await client.storage.from("scripts").createSignedUrl(manifestPath, 3600);
  if (!signed?.signedUrl) return map;

  const res = await fetch(signed.signedUrl);
  const cues: Omit<VoiceCueEntry, "signedUrl">[] = await res.json();

  const uniquePaths = [...new Set(cues.map((c) => c.audio_path))];
  const urlByPath = new Map<string, string>();
  if (uniquePaths.length) {
    const { data: fresh } = await client.storage
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
