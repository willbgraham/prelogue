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
// How long to wait before asking again while another tab's run holds the script.
const WAIT_FOR_OTHER_MS = 4000;

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
   * `failed + remaining > 0`, some lines couldn't be voiced, so the caller can
   * surface a retry instead of silently skipping those lines in playback.
   */
  onResult?: (r: VoiceRunResult) => void;
}

/**
 * Why lines went unvoiced, worst first. "quota": the studio's own account with
 * the voice provider. "declined": the chosen voice won't read the line and no
 * stand-in could. "storage" / "busy": passing trouble, worth another try.
 * Absent when nothing failed (or the server predates it).
 */
export type VoiceFailReason = "quota" | "declined" | "storage" | "busy";

export interface VoiceRunResult {
  failed: number;
  remaining: number;
  total: number;
  locked: boolean;
  creditsSpent?: number;
  creditsLeft?: number;
  failedReason?: VoiceFailReason;
  /**
   * Lines of this read spoken by a house voice because the voice chosen for the
   * role wouldn't read them (a voice's owner can restrict what it says), and
   * the roles they belong to ("NARRATOR" for narration).
   */
  standIns?: number;
  standInRoles?: string[];
}

/**
 * What to say when lines have no audio. This used to be one sentence for every
 * cause — "the studio may be temporarily out of voice credits" — which was a
 * guess, and the wrong one each time it was shown. The server now says why
 * (an older server says nothing, and gets the plain wording).
 */
export function unvoicedMessage(missing: number, reason?: VoiceFailReason): string {
  const lines = `${missing} ${missing === 1 ? "line" : "lines"}`;
  const them = missing === 1 ? "it" : "them";
  if (reason === "quota") {
    return `${lines} couldn’t be voiced: the studio has run out of voice capacity for the moment. Please try again a little later.`;
  }
  if (reason === "declined") {
    return `${lines} couldn’t be voiced: the voice chosen for ${them} wouldn’t read ${them}. Choosing another voice for that role will fix it.`;
  }
  return `${lines} couldn’t be voiced just now.`;
}

/** The body of a function's non-2xx answer: supabase-js hands back only "non-2xx" and keeps the answer in `context`. */
export async function refusalBody(error: unknown): Promise<Record<string, unknown> | null> {
  const ctx = (error as { context?: { json?: () => Promise<unknown>; clone?: () => unknown } } | null)
    ?.context;
  if (!ctx || typeof ctx.json !== "function") return null;
  try {
    const res = (typeof ctx.clone === "function" ? ctx.clone() : ctx) as { json: () => Promise<unknown> };
    const body = await res.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Thrown when the writer's credits don't cover the next run. Typed so a caller can offer a top-up. */
function outOfCredits(from: Record<string, unknown>): Error {
  const e = new Error("insufficient_credits") as Error & {
    code?: string;
    needed?: number;
    balance?: number;
  };
  e.code = "insufficient_credits";
  e.needed = Number(from.needed ?? 0);
  e.balance = Number(from.balance ?? 0);
  return e;
}

/**
 * Fired on the window when what a read needs may have changed: a voice was
 * chosen, or lines were just voiced. The export card states what pressing its
 * buttons will voice and cost, so it asks again when it hears this.
 */
export const READ_CHANGED_EVENT = "prelogue:read-changed";

/** Say that a read's voices, or what is voiced of it, just changed. Safe to call anywhere. */
export function announceReadChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(READ_CHANGED_EVENT));
}

/** What a read still needs before every line of it is voiced. */
export interface VoiceNeed {
  /** Lines not voiced yet (0: the whole read is voiced). */
  lines: number;
  /** Credits voicing them will take (0 where nothing is charged). */
  credits: number;
  /** The writer's balance now. */
  balance: number;
  /** Lines in the read altogether (0 if the server didn't say). */
  total: number;
}

/**
 * Ask what a read still needs, without voicing or charging anything. Null when
 * the server couldn't say; a caller should carry on rather than block on it.
 */
export async function readVoiceNeed(
  client: SupabaseClientLike,
  scriptId: string
): Promise<VoiceNeed | null> {
  try {
    const { data, error } = await client.functions.invoke("generate-voice-cues", {
      body: { script_id: scriptId, dry_run: true },
    });
    const d = data as Record<string, unknown> | null;
    if (error || !d || d.error) return null;
    const num = (v: unknown) => (typeof v === "number" && isFinite(v) && v > 0 ? v : 0);
    const balance = num(d.balance);
    const total = num(d.total_lines);
    if (typeof d.missing_lines === "number") {
      return { lines: num(d.missing_lines), credits: num(d.credits_to_finish), balance, total };
    }
    // A server from before it priced the whole job: it speaks only of the next
    // run, so the rest is scaled up from it.
    const next = num(d.new_lines);
    const lines = next + num(d.remaining_after_run);
    const credits = next > 0 ? Math.ceil((num(d.credits_needed) * lines) / next) : 0;
    return { lines, credits, balance, total };
  } catch {
    return null;
  }
}

export interface VoiceReadOptions {
  onProgress?: (pct: number) => void;
  shouldCancel?: () => boolean;
  voiceConfig?: VoiceConfig | null;
  /** How many runs to drive before giving up (a run voices up to 80 lines). */
  maxRounds?: number;
  /** How long to wait before asking again while another tab is voicing this script. */
  waitMs?: number;
}

export interface VoiceReadOutcome extends VoiceRunResult {
  manifestPath: string | null;
  cancelled: boolean;
}

/**
 * Drive `generate-voice-cues` until the read is voiced (0..1 progress): the
 * loop the player runs when Play is pressed, on its own, so that anything else
 * that needs the read voiced (an export) can voice it the same way, charged
 * the same way. Throws a typed "insufficient_credits" when the balance runs out.
 */
export async function voiceRead(
  client: SupabaseClientLike,
  scriptId: string,
  opts: VoiceReadOptions = {}
): Promise<VoiceReadOutcome> {
  const { onProgress, shouldCancel, voiceConfig } = opts;
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS;
  const waitMs = opts.waitMs ?? WAIT_FOR_OTHER_MS;
  let manifestPath: string | null = null;
  let initialMisses = -1;
  let finalStats: VoiceRunResult = { failed: 0, remaining: 0, total: 0, locked: false };
  // Waiting for another tab's run is not a round of ours, but must still end.
  let waits = 0;

  for (let round = 0; round < maxRounds; ) {
    if (shouldCancel?.()) return { ...finalStats, manifestPath, cancelled: true };

    const body: Record<string, unknown> = { script_id: scriptId };
    if (voiceConfig) body.voice_config = voiceConfig;

    const { data, error } = await client.functions.invoke("generate-voice-cues", { body });
    // Another tab/surface is generating this same script (per-script server
    // lock). Wait — its clips land in the shared cache, so when we get a turn
    // our miss list has shrunk instead of duplicating (and double-billing).
    if ((data as { error?: string } | null)?.error === "generation_in_progress") {
      if (++waits > 150) throw new Error("This read is being voiced somewhere else. Try again in a minute.");
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (error) {
      // A refusal for want of credits arrives as HTTP 402, which supabase-js
      // reports as a bare "non-2xx" error with the answer tucked away.
      const said = await refusalBody(error);
      if (said?.error === "insufficient_credits") throw outOfCredits(said);
      throw new Error(typeof said?.error === "string" ? said.error : (error as any)?.message ?? String(error));
    }
    if ((data as any)?.error === "insufficient_credits") throw outOfCredits(data as Record<string, unknown>);
    if ((data as any)?.error) throw new Error((data as any).error);
    round++;

    manifestPath = (data as any)?.manifest_path ?? manifestPath;
    const remaining = Number((data as any)?.remaining ?? 0);
    const generated = Number((data as any)?.generated_now ?? 0);
    const failed = Number((data as any)?.failed ?? 0);

    // What the server adds about lines it couldn't voice, or voiced another way.
    const said = data as {
      failed_reason?: VoiceFailReason;
      stand_ins?: number;
      stand_in_roles?: unknown[];
    } | null;

    if (initialMisses < 0) initialMisses = generated + failed + remaining;
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
      failedReason: said?.failed_reason ?? undefined,
      // Counted over the whole read by the server each run, so the last run's
      // figure is the read's figure.
      standIns: Number(said?.stand_ins ?? 0),
      standInRoles: Array.isArray(said?.stand_in_roles) ? said.stand_in_roles.map(String) : [],
    };
    if ((data as any)?.done) break;
    // No progress this round — every attempt failed (the voice provider is
    // erroring or out of credits). Stop retrying the same lines and let the
    // caller surface the failure instead of silently looping to the limit.
    if (generated === 0 && failed > 0) break;
  }

  return { ...finalStats, manifestPath, cancelled: false };
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
  const run = await voiceRead(client, scriptId, { onProgress, shouldCancel, voiceConfig });
  if (run.cancelled) return new Map();
  const manifestPath = run.manifestPath;
  const finalStats: VoiceRunResult = {
    failed: run.failed,
    remaining: run.remaining,
    total: run.total,
    locked: run.locked,
    creditsSpent: run.creditsSpent,
    creditsLeft: run.creditsLeft,
    failedReason: run.failedReason,
    standIns: run.standIns,
    standInRoles: run.standInRoles,
  };

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
