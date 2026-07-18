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
};

const MAX_PAGES = 15;

/**
 * Writer MP4 export — renders the table read as a video via the same pipeline
 * as the daily renders, then serves a signed download. Renders run on the
 * worker (minutes); this card dispatches and polls.
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
  const [waiting, setWaiting] = useState(false); // dispatched, new row not seen yet
  const [error, setError] = useState<string | null>(null);
  const prevIdRef = useRef<string | null>(null);

  const tooLong = (pageCount ?? 0) > MAX_PAGES;

  const refresh = useCallback(async () => {
    const { data } = await supabase.functions.invoke("export-read", {
      body: { script_id: scriptId, action: "status" },
    });
    const r = (data as { render?: RenderRow | null } | null)?.render ?? null;
    setRender(r);
    if (r && r.id !== prevIdRef.current) {
      // The dispatched run has materialized as a row — stop the "starting" state.
      if (waiting && r.status === "processing") setWaiting(false);
      if (r.status !== "processing") setWaiting(false);
    }
    return r;
  }, [supabase, scriptId, waiting]);

  useEffect(() => {
    // Initial fetch (async boundary), then poll while a render is in flight.
    const first = window.setTimeout(refresh, 0);
    const t = window.setInterval(() => {
      if (waiting || render?.status === "processing") refresh();
    }, 20_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [refresh, waiting, render?.status]);

  const dispatch = async () => {
    setError(null);
    prevIdRef.current = render?.id ?? null;
    const { data, error: fnErr } = await supabase.functions.invoke("export-read", {
      body: { script_id: scriptId, action: "dispatch" },
    });
    const err = (data as { error?: string } | null)?.error ?? (fnErr as Error | null)?.message;
    if (!(data as { dispatched?: boolean } | null)?.dispatched) {
      setError(err ?? "Couldn't start the render.");
      return;
    }
    setWaiting(true);
  };

  const inFlight = waiting || render?.status === "processing";
  const downloadName = `${(title || "table-read").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.mp4`;

  return (
    <section className="mt-8 rounded-xl border border-tan bg-ivory p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-slab text-lg">Export MP4</h2>
          <p className="mt-1 text-sm text-taupe">
            Render the table read as a video — the typed pages with your cast — to keep, send, or
            post anywhere.
          </p>
        </div>
        {unlocked && !tooLong && (
          <button
            onClick={dispatch}
            disabled={inFlight}
            className="shrink-0 rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {inFlight ? "Rendering…" : render?.url ? "Re-render" : "Render MP4"}
          </button>
        )}
      </div>

      {!unlocked && (
        <p className="mt-3 text-sm text-muted">
          MP4 export comes with the full read — one payment of $19 for this script unlocks both.
        </p>
      )}
      {unlocked && tooLong && (
        <p className="mt-3 text-sm text-muted">
          Export currently supports scripts up to {MAX_PAGES} pages — longer scripts are coming.
        </p>
      )}

      {unlocked && !tooLong && (
        <div className="mt-3 text-sm">
          {inFlight && (
            <p className="text-taupe">
              Rendering — usually a few minutes. This updates on its own; you can leave the page.
            </p>
          )}
          {!inFlight && render?.status === "failed" && (
            <p className="text-brick">Render failed{render.error ? ` — ${render.error}` : ""}. Try again.</p>
          )}
          {!inFlight && render?.url && (
            <a
              href={render.url}
              download={downloadName}
              className="inline-flex items-center gap-2 rounded-lg border border-brick px-4 py-2 font-medium text-brick hover:bg-brick/5"
            >
              ⬇ Download MP4
              {render.rendered_at && (
                <span className="text-xs font-normal text-muted">
                  {new Date(render.rendered_at).toLocaleDateString()}
                </span>
              )}
            </a>
          )}
          {error && <p className="mt-2 text-brick">{error}</p>}
        </div>
      )}
    </section>
  );
}
