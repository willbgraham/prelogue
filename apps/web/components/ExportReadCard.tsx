"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";
import {
  audioExportSeconds,
  roughly,
  timeLeft,
  videoExportSeconds,
} from "@/lib/exportEstimate";

/** Where a job is on its bar, as the worker last reported it (export-read brings the time left up to date). */
type Progress = {
  pct: number;
  stage: string;
  eta_seconds: number | null;
  age_seconds: number;
};

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

/**
 * Writer export — MP4 (page-capped) and MP3 (uncapped) run as two independent
 * jobs through the daily-render pipeline. This card dispatches and polls each,
 * says beforehand how long each will take, and shows how far along it is.
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
  // Row id at dispatch time. The previous export's row is still present while
  // Actions boots, so "starting" only ends once a *different* row shows up.
  const prevIdRef = useRef<{ video: string | null; audio: string | null }>({
    video: null,
    audio: null,
  });

  const videoTooLong = (pageCount ?? 0) > MAX_VIDEO_PAGES;
  const videoEstimate = spokenChars ? videoExportSeconds(spokenChars) : null;
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

  const base = (title || "table-read").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  // Prefer the dedicated MP3 export; fall back to the sibling track of an
  // already-rendered MP4 so short scripts don't wait on a second job.
  const mp3Url = audio?.url ?? render?.audio_url ?? null;

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
          MP4 and MP3 downloads come with the full read — one payment of $19 for this script
          unlocks all of it.
        </p>
      )}

      {unlocked && (
        <div className="mt-4 space-y-4 text-sm">
          {/* MP3 — no page limit */}
          <div>
            <div className="flex flex-wrap items-center gap-2">
              {mp3Url && !audioInFlight ? (
                <a
                  href={mp3Url}
                  download={`${base}.mp3`}
                  className="inline-flex items-center gap-2 rounded-lg bg-brick px-4 py-2 font-medium text-white"
                >
                  ⬇ Download MP3
                </a>
              ) : (
                <button
                  onClick={() => dispatch("audio")}
                  disabled={audioInFlight}
                  className="rounded-lg bg-brick px-4 py-2 font-medium text-white disabled:opacity-60"
                >
                  {audioInFlight ? "Preparing MP3…" : "Prepare MP3"}
                </button>
              )}
              {mp3Url && !audioInFlight && (
                <button
                  onClick={() => dispatch("audio")}
                  className="rounded-lg border border-tan px-3 py-2 text-taupe hover:bg-elevated"
                >
                  Rebuild
                </button>
              )}
              <span className="text-xs text-muted">
                The whole read, any length.
                {audioEstimate && !audioInFlight ? ` Takes ${roughly(audioEstimate)}.` : ""}
              </span>
            </div>
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
                Video export tops out at {MAX_VIDEO_PAGES} pages — at {pageCount} pages, the MP3
                above is the complete read. Want the video anyway? Email{" "}
                <a className="text-brick hover:underline" href="mailto:hello@prelogue.studio">
                  hello@prelogue.studio
                </a>{" "}
                and we&apos;ll render it for you.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {render?.url && !videoInFlight ? (
                    <a
                      href={render.url}
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
                      onClick={() => dispatch("video")}
                      disabled={videoInFlight}
                      className="rounded-lg border border-brick px-4 py-2 font-medium text-brick hover:bg-brick/5 disabled:opacity-60"
                    >
                      {videoInFlight ? "Rendering MP4…" : "Render MP4"}
                    </button>
                  )}
                  {render?.url && !videoInFlight && (
                    <button
                      onClick={() => dispatch("video")}
                      className="rounded-lg border border-tan px-3 py-2 text-taupe hover:bg-elevated"
                    >
                      Re-render
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
