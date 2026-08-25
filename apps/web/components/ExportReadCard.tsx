"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";

type RenderRow = {
  id: string;
  status: "processing" | "ready" | "failed" | "posted";
  error: string | null;
  created_at: string;
  rendered_at: string | null;
  url: string | null;
  audio_url?: string | null;
};

// Video only — Remotion renders about 1:1 with the video's runtime, so the
// ceiling is the Actions job timeout (330 min). MP3 export is an ffmpeg concat
// of clips that already exist, so it has no length limit at all.
const MAX_VIDEO_PAGES = 250;

/**
 * Writer export — MP4 (page-capped) and MP3 (uncapped) run as two independent
 * jobs through the daily-render pipeline. This card dispatches and polls each.
 */
export function ExportReadCard({
  scriptId,
  title,
  unlocked,
  pageCount,
}: {
  scriptId: string;
  title: string;
  unlocked: boolean;
  pageCount: number | null;
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

  useEffect(() => {
    // Initial fetch (async boundary), then poll while a render is in flight.
    const first = window.setTimeout(refresh, 0);
    const t = window.setInterval(() => {
      if (
        waiting.video ||
        waiting.audio ||
        render?.status === "processing" ||
        audio?.status === "processing"
      ) {
        refresh();
      }
    }, 20_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
    // Primitive deps only — an object here is what caused the polling loop.
  }, [refresh, waiting.video, waiting.audio, render?.status, audio?.status]);

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

  const videoInFlight = waiting.video || render?.status === "processing";
  const audioInFlight = waiting.audio || audio?.status === "processing";
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
            <span className="text-xs text-muted">The whole read, any length.</span>
          </div>
          {audioInFlight && (
            <p className="-mt-2 text-taupe">
              Building your MP3 — a few minutes, longer for a feature. This updates on its own;
              you can leave the page.
            </p>
          )}
          {!audioInFlight && audio?.status === "failed" && (
            <p className="-mt-2 text-brick">
              MP3 export failed{audio.error ? ` — ${audio.error}` : ""}. Try again.
            </p>
          )}

          {/* MP4 — capped, because rendering video scales with runtime */}
          <div className="border-t border-tan pt-4">
            {videoTooLong ? (
              <p className="text-muted">
                Video export is limited to {MAX_VIDEO_PAGES} pages — at {pageCount} pages, the MP3
                above is the full read.
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
                </div>
                {videoInFlight && (
                  <p className="mt-2 text-taupe">
                    Rendering — usually a few minutes. This updates on its own; you can leave the
                    page.
                  </p>
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
