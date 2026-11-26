"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";
import {
  audioExportSeconds,
  readSeconds,
  roughly,
  timeLeft,
  videoExportSeconds,
  videoFits,
} from "@/lib/exportEstimate";
import { UNLOCK_PRICE, readCreditsEstimate, unlockCreditsForChars } from "@/lib/shared/plans";
import {
  READ_CHANGED_EVENT,
  readVoiceNeed,
  unvoicedMessage,
  voiceRead,
  type VoiceNeed,
} from "@/lib/shared/voiceCues";
import Link from "next/link";

/** Where a job is on its bar, as the worker last reported it (export-read brings the time left up to date). */
type Progress = {
  pct: number;
  stage: string;
  eta_seconds: number | null;
  age_seconds: number;
};

/** The durable download link (supabase/functions/download-export): a new signed address per click. */
const DOWNLOAD_LINK = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/download-export`;

type RenderRow = {
  id: string;
  status: "processing" | "ready" | "failed" | "posted";
  error: string | null;
  created_at: string;
  rendered_at: string | null;
  url: string | null;
  audio_url?: string | null;
  /** While processing: the worker's last report (null until it first reports)… */
  progress?: Progress | null;
  /** …and how long the job has been running. */
  elapsed_seconds?: number | null;
};

// Video only — feature renders run ~2x realtime and the job is stopped at 5½
// hours, so ~110 pages is the physical wall (covers nearly every real feature).
// Long renders resolve by email: the writer gets the download link when the
// render lands, no open tab required.
const MAX_VIDEO_PAGES = 110;
// Without a character count to estimate from, above this many pages set the
// "this takes hours, we'll email you" expectation.
const LONG_RENDER_PAGES = 40;
// An export that takes longer than this is one to walk away from.
const LONG_EXPORT_SECONDS = 600;

const STAGE_WORDS: Record<string, string> = {
  preparing: "Getting ready",
  rendering: "Rendering",
  finishing: "Finishing",
  uploading: "Saving the file",
  collecting: "Collecting the lines",
  stitching: "Joining them up",
};

/**
 * The bar under a running export. Three states, and it never invents a figure:
 *  - not reporting yet (the job is starting): the estimate for the whole job;
 *  - reporting: the worker's own percentage and time left;
 *  - gone quiet, or a job that never reports: the time left by the estimate
 *    alone, with no percentage claimed.
 */
function ExportProgress({
  what,
  row,
  estimate,
}: {
  what: "MP3" | "MP4";
  row: RenderRow | null;
  estimate: number | null;
}) {
  const p = row?.status === "processing" ? row.progress ?? null : null;
  // No word from the worker in three minutes: say so rather than freeze a figure.
  const quiet = !!p && p.age_seconds > 180;
  // A job two minutes in that has never reported is one that isn't going to
  // (a worker from before reporting existed, or one whose notes aren't landing).
  const elapsed = row?.status === "processing" ? row.elapsed_seconds ?? 0 : 0;
  const silentJob = row?.status === "processing" && !p && elapsed > 120;

  let words: string;
  let detail: string;
  let pct: number | null = null;
  if (p && !quiet) {
    pct = p.pct;
    words = STAGE_WORDS[p.stage] ?? "Working";
    detail = p.eta_seconds == null ? `${p.pct}%` : `${p.pct}% · ${timeLeft(p.eta_seconds)}`;
  } else if (p) {
    pct = p.pct;
    words = STAGE_WORDS[p.stage] ?? "Working";
    detail = `${p.pct}% · still working`;
  } else if (silentJob) {
    words = "Working";
    detail = estimate && estimate > elapsed ? timeLeft(estimate - elapsed) : "nearly there";
  } else {
    words = "Starting up";
    detail = estimate ? `${roughly(estimate)} in all` : "";
  }

  return (
    <div className="mt-2">
      <div
        role="progressbar"
        aria-label={`${what} export progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={detail ? `${words}, ${detail}` : words}
        className="h-2 w-full overflow-hidden rounded-full bg-tan/40"
      >
        <div
          className={`h-full rounded-full bg-brick transition-[width] duration-700 ${
            pct == null ? "w-1/4 animate-pulse" : ""
          }`}
          style={pct == null ? undefined : { width: `${Math.max(pct, 2)}%` }}
        />
      </div>
      <p className="mt-1.5 text-taupe">
        <span className="font-medium text-ink">{words}</span>
        {detail ? ` · ${detail}` : ""}
      </p>
    </div>
  );
}

/** The bar while the read is being voiced in this page, before an export can start. */
function VoicingProgress({ pct }: { pct: number }) {
  return (
    <div className="mt-2">
      <div
        role="progressbar"
        aria-label="Voicing the read"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`Voicing your read, ${pct}%`}
        className="h-2 w-full overflow-hidden rounded-full bg-tan/40"
      >
        <div
          className="h-full rounded-full bg-brick transition-[width] duration-700"
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
      </div>
      <p className="mt-1.5 text-taupe">
        <span className="font-medium text-ink">Voicing your read</span>
        {` · ${pct}%`}
      </p>
      <p className="mt-1 text-xs text-muted">
        Keep this page open until the voices are done. The export starts by itself after that.
      </p>
    </div>
  );
}

const credits = (n: number) => `${n} ${n === 1 ? "credit" : "credits"}`;

/**
 * Writer export — MP4 (page-capped) and MP3 (uncapped) run as two independent
 * jobs through the daily-render pipeline. This card dispatches and polls each,
 * says beforehand how long each will take, and shows how far along it is.
 *
 * An export is made from the read's voiced lines, and nothing voices a read
 * until someone asks for it. A writer who paid and went straight to "Prepare
 * MP3" used to start a job that refused a minute later ("lines haven't been
 * generated yet"), twice, before finding the play button. So the buttons here
 * voice whatever the read still lacks first — the same way Play does, charged
 * the same way, the cost said beforehand — and then start the export.
 */
export function ExportReadCard({
  scriptId,
  title,
  unlocked,
  pageCount,
  spokenChars,
  spokenLines,
}: {
  scriptId: string;
  title: string;
  unlocked: boolean;
  pageCount: number | null;
  /** Characters and lines that are read aloud: what the time estimates are made from. */
  spokenChars?: number;
  spokenLines?: number;
}) {
  const supabase = getBrowserClient();
  const [render, setRender] = useState<RenderRow | null>(null);
  const [audio, setAudio] = useState<RenderRow | null>(null);
  // dispatched, new row not seen yet
  const [waiting, setWaiting] = useState<{ video: boolean; audio: boolean }>({
    video: false,
    audio: false,
  });
  const [error, setError] = useState<string | null>(null);
  // What the read still needs before every line is voiced (null: not asked yet,
  // or the server couldn't say). Shown beside the buttons, so its credit figure
  // is one the writer has seen before anything is spent.
  const [need, setNeed] = useState<VoiceNeed | null>(null);
  // Looking up what the read needs, after a button was pressed.
  const [checking, setChecking] = useState<"video" | "audio" | null>(null);
  // Voicing in this page, for which export, and how far along.
  const [voicing, setVoicing] = useState<{ kind: "video" | "audio"; pct: number } | null>(null);
  // The read needs more than the writer had been shown: ask before spending.
  const [confirm, setConfirm] = useState<"video" | "audio" | null>(null);
  // The balance doesn't cover the voicing.
  const [short, setShort] = useState<{ needed: number; balance: number } | null>(null);
  const aliveRef = useRef(true);
  // Row id at dispatch time. The previous export's row is still present while
  // Actions boots, so "starting" only ends once a *different* row shows up.
  const prevIdRef = useRef<{ video: string | null; audio: string | null }>({
    video: null,
    audio: null,
  });

  // Two ways a video can be too long for one job: too many pages, or pages so
  // full that the read itself runs past what one job can render.
  const tooManyPages = (pageCount ?? 0) > MAX_VIDEO_PAGES;
  const readTooLong = !!spokenChars && !videoFits(spokenChars);
  const videoTooLong = tooManyPages || readTooLong;
  const videoEstimate = spokenChars ? videoExportSeconds(spokenChars) : null;
  // The unlock's credits are sized to the script, up to a ceiling; only a script
  // past that ceiling is not voiced in full by them.
  const unlockCoversRead =
    !spokenChars || readCreditsEstimate(spokenChars) <= unlockCreditsForChars(spokenChars);
  const audioEstimate = spokenLines ? audioExportSeconds(spokenLines) : null;
  const longVideo =
    videoEstimate != null
      ? videoEstimate > LONG_EXPORT_SECONDS
      : (pageCount ?? 0) > LONG_RENDER_PAGES;

  const refresh = useCallback(async () => {
    const { data } = await supabase.functions.invoke("export-read", {
      body: { script_id: scriptId, action: "status" },
    });
    const d = data as { render?: RenderRow | null; audio?: RenderRow | null } | null;
    const v = d?.render ?? null;
    const a = d?.audio ?? null;
    setRender(v);
    setAudio(a);
    // Preserve object identity when nothing changed: this state is an effect
    // dependency, and a fresh-but-equal object re-ran the effect, which polled
    // again, which set fresh state — a hot loop that hammered export-read as
    // fast as the network allowed (~83 req/min observed in prod logs).
    setWaiting((w) => {
      const next = {
        video: w.video && (!v || v.id === prevIdRef.current.video),
        audio: w.audio && (!a || a.id === prevIdRef.current.audio),
      };
      return next.video === w.video && next.audio === w.audio ? w : next;
    });
  }, [supabase, scriptId]);

  const videoInFlight = waiting.video || render?.status === "processing";
  const audioInFlight = waiting.audio || audio?.status === "processing";
  // An MP3 is done in a minute or so: poll often enough that its bar is worth
  // watching. A video takes hours; every fifteen seconds is plenty.
  const pollMs = audioInFlight ? 5_000 : 15_000;

  useEffect(() => {
    // Initial fetch (async boundary), then poll while an export is in flight.
    const first = window.setTimeout(refresh, 0);
    const t =
      videoInFlight || audioInFlight ? window.setInterval(refresh, pollMs) : undefined;
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
    // Primitive deps only — an object here is what caused the polling loop.
  }, [refresh, videoInFlight, audioInFlight, pollMs]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Ask once, when the card opens, what the read still needs: the note beside
  // the buttons is how the writer learns the cost before pressing one.
  useEffect(() => {
    if (!unlocked) return;
    let stale = false;
    readVoiceNeed(supabase, scriptId).then((n) => {
      if (!stale) setNeed(n);
    });
    return () => {
      stale = true;
    };
  }, [supabase, scriptId, unlocked]);

  // …and again when a voice is chosen or the read is played on this page (the
  // casting page and the player say so), so the note never describes a read
  // that has since changed. Not while a press of ours is being dealt with.
  const busyRef = useRef(false);
  useEffect(() => {
    if (!unlocked) return;
    let timer: number | undefined;
    const again = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (busyRef.current) return;
        readVoiceNeed(supabase, scriptId).then((n) => {
          if (aliveRef.current && !busyRef.current) setNeed(n);
        });
      }, 1500);
    };
    window.addEventListener(READ_CHANGED_EVENT, again);
    return () => {
      window.removeEventListener(READ_CHANGED_EVENT, again);
      window.clearTimeout(timer);
    };
  }, [supabase, scriptId, unlocked]);

  const dispatch = async (kind: "video" | "audio") => {
    setError(null);
    prevIdRef.current[kind] = (kind === "audio" ? audio : render)?.id ?? null;
    const { data, error: fnErr } = await supabase.functions.invoke("export-read", {
      body: { script_id: scriptId, action: "dispatch", kind },
    });
    if (!(data as { dispatched?: boolean } | null)?.dispatched) {
      const err = (data as { error?: string } | null)?.error ?? (fnErr as Error | null)?.message;
      setError(err ?? "Couldn't start the export.");
      return;
    }
    setWaiting((w) => ({ ...w, [kind]: true }));
  };

  /** Voice what the read lacks (the way Play does), then start the export. */
  const voiceThenExport = async (kind: "video" | "audio") => {
    setConfirm(null);
    setShort(null);
    setError(null);
    setVoicing({ kind, pct: 0 });
    try {
      const run = await voiceRead(supabase, scriptId, {
        // A run voices up to 80 lines; a long feature is several thousand.
        maxRounds: 400,
        onProgress: (p) => {
          if (aliveRef.current) setVoicing({ kind, pct: Math.round(p * 100) });
        },
        shouldCancel: () => !aliveRef.current,
      });
      if (run.cancelled || !aliveRef.current) return;
      const missing = run.failed + run.remaining;
      if (missing > 0) {
        setVoicing(null);
        setError(`${unvoicedMessage(missing, run.failedReason)} The export wasn’t started.`);
        setNeed(await readVoiceNeed(supabase, scriptId));
        return;
      }
      setVoicing({ kind, pct: 100 });
      setNeed((n) => ({
        lines: 0,
        credits: 0,
        balance: run.creditsLeft ?? n?.balance ?? 0,
        total: run.total || n?.total || 0,
      }));
    } catch (e) {
      if (!aliveRef.current) return;
      setVoicing(null);
      const err = e as Error & { code?: string; needed?: number; balance?: number };
      // What is left to voice now (lines voiced before the stop stay voiced).
      const left = await readVoiceNeed(supabase, scriptId);
      if (!aliveRef.current) return;
      setNeed(left);
      if (err?.code === "insufficient_credits") {
        setShort({
          needed: left && left.lines > 0 ? left.credits : err.needed ?? 0,
          balance: left?.balance ?? err.balance ?? 0,
        });
      } else {
        setError(`Couldn’t voice the read${err?.message ? ` (${err.message})` : ""}. Try again.`);
      }
      return;
    }
    await dispatch(kind);
    if (aliveRef.current) setVoicing(null);
  };

  /** A button was pressed: export now if the read is voiced, voice it first if not. */
  const start = async (kind: "video" | "audio") => {
    if (checking || voicing) return;
    setError(null);
    setShort(null);
    setConfirm(null);
    const told = need; // what the card has been showing until now
    setChecking(kind);
    const fresh = await readVoiceNeed(supabase, scriptId);
    if (!aliveRef.current) return;
    setChecking(null);
    setNeed(fresh);
    // Voiced in full, or the server couldn't say (the job itself checks again).
    if (!fresh || fresh.lines === 0) return dispatch(kind);
    if (fresh.credits > fresh.balance) {
      setShort({ needed: fresh.credits, balance: fresh.balance });
      return;
    }
    // Spend only a figure the writer has already been shown. If the note wasn't
    // up yet, or the voices changed since and it now costs more, ask first.
    if (!told || told.lines === 0 || fresh.credits > told.credits) {
      setConfirm(kind);
      return;
    }
    return voiceThenExport(kind);
  };

  const base = (title || "table-read").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  // Prefer the dedicated MP3 export; fall back to the sibling track of an
  // already-rendered MP4 so short scripts don't wait on a second job.
  const mp3Url = audio?.url ?? render?.audio_url ?? null;
  // The buttons point at the durable download link, the one the email carries,
  // not at the signed address that came with the status. That address was made
  // when the page loaded and stops working an hour later, so a tab left open
  // had a dead button; and a browser sent straight to it plays the file in the
  // tab instead of saving it. The durable link makes a fresh address per click
  // and has the file saved under the script's name.
  const mp4Href = render?.url ? `${DOWNLOAD_LINK}?render=${render.id}` : null;
  const mp3Href = audio?.url
    ? `${DOWNLOAD_LINK}?render=${audio.id}`
    : render?.audio_url
      ? `${DOWNLOAD_LINK}?render=${render.id}&format=mp3`
      : null;

  // Looking up what the read needs, or voicing it: no other button may start anything.
  const busy = !!checking || !!voicing;
  useEffect(() => {
    busyRef.current = busy || !!confirm;
  }, [busy, confirm]);
  // "Not voiced yet" for a read that has barely been started, a line count otherwise.
  const unvoiced = need && need.lines > 0 ? need : null;
  const wholeRead = !!unvoiced && (unvoiced.total === 0 || unvoiced.lines >= unvoiced.total * 0.9);

  return (
    <section className="mt-8 rounded-xl border border-tan bg-ivory p-5">
      <div>
        <h2 className="font-slab text-lg">Export MP4 &amp; MP3</h2>
        <p className="mt-1 text-sm text-taupe">
          Download the table read as a video or an audio file — yours to keep, send, or post
          anywhere.
        </p>
      </div>

      {!unlocked && (
        <p className="mt-3 text-sm text-muted">
          {`MP4 and MP3 downloads come with the full read — one payment of ${UNLOCK_PRICE} for this script`}
          {unlockCoversRead
            ? " unlocks all of it."
            : " unlocks it, though a script this long also needs a credit top-up to voice in full."}
        </p>
      )}

      {unlocked && (
        <div className="mt-4 space-y-4 text-sm">
          {/* Said before a button is pressed: what pressing it will voice, and for how many credits. */}
          {unvoiced && !voicing && !confirm && !short && (
            <p className="rounded-lg border border-tan bg-elevated px-3 py-2 text-taupe">
              {wholeRead
                ? "Your read hasn’t been voiced yet."
                : `${unvoiced.lines} ${unvoiced.lines === 1 ? "line" : "lines"} of your read ${unvoiced.lines === 1 ? "isn’t" : "aren’t"} voiced yet.`}{" "}
              {videoTooLong ? "The button" : "Either button"} below voices{" "}
              {wholeRead || unvoiced.lines === 1 ? "it" : "them"} first
              {unvoiced.credits > 0
                ? ` (about ${credits(unvoiced.credits)}; you have ${unvoiced.balance})`
                : ""}
              , then makes the file.
            </p>
          )}
          {confirm && unvoiced && !voicing && (
            <div className="rounded-lg border border-brick/40 bg-brick/5 px-3 py-3">
              <p className="text-ink">
                {wholeRead ? "Your read needs voicing first" : `${unvoiced.lines} ${unvoiced.lines === 1 ? "line needs" : "lines need"} voicing first`}
                {unvoiced.credits > 0
                  ? `: about ${credits(unvoiced.credits)}. You have ${unvoiced.balance}.`
                  : "."}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  onClick={() => voiceThenExport(confirm)}
                  className="rounded-lg bg-brick px-4 py-2 font-medium text-white"
                >
                  Voice {wholeRead || unvoiced.lines === 1 ? "it" : "them"} and{" "}
                  {confirm === "audio" ? "prepare the MP3" : "render the MP4"}
                </button>
                <button
                  onClick={() => setConfirm(null)}
                  className="rounded-lg border border-tan px-3 py-2 text-taupe hover:bg-elevated"
                >
                  Not now
                </button>
              </div>
            </div>
          )}
          {short && !voicing && (
            <div className="rounded-lg border border-brick/40 bg-brick/5 px-3 py-3">
              <p className="text-ink">
                Voicing the rest of your read needs about {credits(short.needed)} and you have{" "}
                {short.balance}.
              </p>
              <p className="mt-1 text-taupe">
                An export is made from the whole read, so it can’t start until every line is voiced.
                Lines already voiced stay voiced.
              </p>
              <Link
                href="/settings/billing"
                className="mt-2 inline-flex rounded-lg bg-brick px-4 py-2 font-medium text-white"
              >
                Add credits →
              </Link>
            </div>
          )}

          {/* MP3 — no page limit */}
          <div>
            <div className="flex flex-wrap items-center gap-2">
              {mp3Url && mp3Href && !audioInFlight ? (
                <a
                  href={mp3Href}
                  download={`${base}.mp3`}
                  className="inline-flex items-center gap-2 rounded-lg bg-brick px-4 py-2 font-medium text-white"
                >
                  ⬇ Download MP3
                </a>
              ) : (
                <button
                  onClick={() => start("audio")}
                  disabled={audioInFlight || busy}
                  className="rounded-lg bg-brick px-4 py-2 font-medium text-white disabled:opacity-60"
                >
                  {audioInFlight
                    ? "Preparing MP3…"
                    : checking === "audio"
                      ? "Checking…"
                      : voicing?.kind === "audio"
                        ? "Voicing the read…"
                        : "Prepare MP3"}
                </button>
              )}
              {mp3Url && !audioInFlight && (
                <button
                  onClick={() => start("audio")}
                  disabled={busy}
                  className="rounded-lg border border-tan px-3 py-2 text-taupe hover:bg-elevated disabled:opacity-60"
                >
                  {checking === "audio" ? "Checking…" : "Rebuild"}
                </button>
              )}
              <span className="text-xs text-muted">
                The whole read, any length.
                {audioEstimate && !audioInFlight ? ` Takes ${roughly(audioEstimate)}.` : ""}
              </span>
            </div>
            {voicing?.kind === "audio" && !audioInFlight && <VoicingProgress pct={voicing.pct} />}
            {audioInFlight && (
              <>
                <ExportProgress
                  what="MP3"
                  row={waiting.audio ? null : audio}
                  estimate={audioEstimate}
                />
                <p className="mt-1 text-xs text-muted">
                  This updates on its own; you can leave the page.
                </p>
              </>
            )}
            {!audioInFlight && audio?.status === "failed" && (
              <p className="mt-2 text-brick">
                MP3 export failed{audio.error ? ` — ${audio.error}` : ""}. Try again.
              </p>
            )}
          </div>

          {/* MP4 — capped, because rendering video scales with runtime */}
          <div className="border-t border-tan pt-4">
            {videoTooLong ? (
              <p className="text-muted">
                {tooManyPages
                  ? `Video export tops out at ${MAX_VIDEO_PAGES} pages — at ${pageCount} pages, the MP3 above is the complete read.`
                  : `This read runs ${roughly(readSeconds(spokenChars ?? 0))} — longer than we can render as one video, so the MP3 above is the complete read.`}{" "}
                Want the video anyway? Email{" "}
                <a className="text-brick hover:underline" href="mailto:hello@prelogue.studio">
                  hello@prelogue.studio
                </a>{" "}
                and we&apos;ll render it for you.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {render?.url && mp4Href && !videoInFlight ? (
                    <a
                      href={mp4Href}
                      download={`${base}.mp4`}
                      className="inline-flex items-center gap-2 rounded-lg border border-brick px-4 py-2 font-medium text-brick hover:bg-brick/5"
                    >
                      ⬇ Download MP4
                      {render.rendered_at && (
                        <span className="text-xs font-normal text-muted">
                          {new Date(render.rendered_at).toLocaleDateString()}
                        </span>
                      )}
                    </a>
                  ) : (
                    <button
                      onClick={() => start("video")}
                      disabled={videoInFlight || busy}
                      className="rounded-lg border border-brick px-4 py-2 font-medium text-brick hover:bg-brick/5 disabled:opacity-60"
                    >
                      {videoInFlight
                        ? "Rendering MP4…"
                        : checking === "video"
                          ? "Checking…"
                          : voicing?.kind === "video"
                            ? "Voicing the read…"
                            : "Render MP4"}
                    </button>
                  )}
                  {render?.url && !videoInFlight && (
                    <button
                      onClick={() => start("video")}
                      disabled={busy}
                      className="rounded-lg border border-tan px-3 py-2 text-taupe hover:bg-elevated disabled:opacity-60"
                    >
                      {checking === "video" ? "Checking…" : "Re-render"}
                    </button>
                  )}
                  {/* Said before they press it: a feature is hours, not minutes. */}
                  {videoEstimate && !videoInFlight && !render?.url && (
                    <span className="text-xs text-muted">
                      Takes {roughly(videoEstimate)}
                      {longVideo
                        ? " for a read this long. We email you the link when it’s ready."
                        : "."}
                    </span>
                  )}
                </div>
                {voicing?.kind === "video" && !videoInFlight && <VoicingProgress pct={voicing.pct} />}
                {videoInFlight && (
                  <>
                    <ExportProgress
                      what="MP4"
                      row={waiting.video ? null : render}
                      estimate={videoEstimate}
                    />
                    <p className="mt-1 text-xs text-muted">
                      {longVideo
                        ? "Close the tab if you like — we’ll email you the download link when it’s ready."
                        : "This updates on its own; you can leave the page."}
                    </p>
                  </>
                )}
                {!videoInFlight && render?.status === "failed" && (
                  <p className="mt-2 text-brick">
                    Render failed{render.error ? ` — ${render.error}` : ""}. Try again.
                  </p>
                )}
              </>
            )}
          </div>

          {error && <p className="text-brick">{error}</p>}
        </div>
      )}
    </section>
  );
}
