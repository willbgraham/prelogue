import type { VoiceConfig } from "./types";
import { signPathsCached } from "./signedUrlCache";

/**
 * Minimal structural type for the Supabase client methods this helper uses.
 * Keeps this shared package dependency-free (no @supabase/supabase-js import),
 * which matters when it's consumed from another app's build (e.g. the web app,
 * where packages/shared's own node_modules isn't installed). A real
 * SupabaseClient (browser or server) is structurally assignable.
 */
export interface SupabaseClientLike {
  functions: {
    invoke(fn: string, opts: { body: Record<string, unknown> }): Promise<any>;
  };
  storage: {
    from(bucket: string): {
      createSignedUrl(path: string, expiresIn: number): Promise<any>;
      createSignedUrls(paths: string[], expiresIn: number): Promise<any>;
    };
  };
}

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
  /**
   * Fires once after generation settles, with the final counts. When
   * `failed + remaining > 0`, some lines couldn't be voiced (e.g. the voice
   * provider is out of credits), so the caller can surface a retry instead of
   * silently skipping those lines in playback.
   */
  onResult?: (r: {
    failed: number;
    remaining: number;
    total: number;
    locked: boolean;
    creditsSpent?: number;
    creditsLeft?: number;
  }) => void;
}

/**
 * Client-injected port of the mobile `prepareVoiceCues`: drive
 * `generate-voice-cues` to completion (0..1 progress), then load + freshly
 * re-sign the manifest (signed URLs expire ~24h). Pass any Supabase client
 * (browser or server); pass `shouldCancel` to bail when the view unmounts.
 */
export async function prepareVoiceCues(
  client: SupabaseClientLike,
  scriptId: string,
  opts: PrepareVoiceCuesOptions = {}
): Promise<Map<number, VoiceCueEntry>> {
  const { onProgress, shouldCancel, voiceConfig, onResult } = opts;
  let manifestPath: string | null = null;
  let initialMisses = 0;
  let finalStats: {
    failed: number;
    remaining: number;
    total: number;
    locked: boolean;
    creditsSpent?: number;
    creditsLeft?: number;
  } = { failed: 0, remaining: 0, total: 0, locked: false };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (shouldCancel?.()) return new Map();

    const body: Record<string, unknown> = { script_id: scriptId };
    if (voiceConfig) body.voice_config = voiceConfig;

    const { data, error } = await client.functions.invoke("generate-voice-cues", { body });
    // Another tab/surface is generating this same script (per-script server
    // lock). Wait — its clips land in the shared cache, so when we get a turn
    // our miss list has shrunk instead of duplicating (and double-billing).
    if ((data as { error?: string } | null)?.error === "generation_in_progress") {
      await new Promise((r) => setTimeout(r, 4000));
      continue;
    }
    if (error) throw new Error((error as any)?.message ?? String(error));
    if ((data as any)?.error === "insufficient_credits") {
      // Typed so the player can offer a top-up instead of showing a raw string.
      const e = new Error("insufficient_credits") as Error & {
        code?: string;
        needed?: number;
        balance?: number;
      };
      e.code = "insufficient_credits";
      e.needed = (data as any).needed;
      e.balance = (data as any).balance;
      throw e;
    }
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
    finalStats = {
      failed,
      remaining,
      total: Number((data as any)?.total_lines ?? 0),
      locked: !!(data as any)?.locked,
      creditsSpent: (finalStats.creditsSpent ?? 0) + Number((data as any)?.credits_spent ?? 0),
      creditsLeft: (data as any)?.credits_left ?? finalStats.creditsLeft,
    };
    if ((data as any)?.done) break;
    // No progress this round — every attempt failed (the voice provider is
    // erroring or out of credits). Stop retrying the same lines and let the
    // caller surface the failure instead of silently looping to MAX_ROUNDS.
    if (generated === 0 && failed > 0) break;
  }

  onResult?.(finalStats);

  if (shouldCancel?.()) return new Map();

  const map = new Map<number, VoiceCueEntry>();
  if (!manifestPath) return map;

  const { data: signed } = await client.storage.from("scripts").createSignedUrl(manifestPath, 3600);
  if (!signed?.signedUrl) return map;

  const res = await fetch(signed.signedUrl);
  const cues: Omit<VoiceCueEntry, "signedUrl">[] = await res.json();

  // Batched + reused: signing all of a feature's clips in one call exceeds
  // Supabase's 1000-path limit, which used to blank every URL and leave the
  // read silent. See signedUrlCache for the egress side of this.
  const uniquePaths = [...new Set(cues.map((c) => c.audio_path))];
  const urlByPath = await signPathsCached(client, "scripts", uniquePaths);
  for (const c of cues) {
    map.set(c.element_index, { ...c, signedUrl: urlByPath.get(c.audio_path) ?? "" });
  }
  onProgress?.(1);
  return map;
}
