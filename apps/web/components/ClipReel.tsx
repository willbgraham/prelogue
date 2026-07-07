"use client";

import { useEffect, useRef, useState } from "react";

/** Plays a submission's per-line clips in sequence, with manual prev/next/restart. */
export function ClipReel({ urls }: { urls: string[] }) {
  const [i, setI] = useState(0);
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    setI(0);
  }, [urls]);
  if (!urls.length) return <p className="text-sm text-muted">No clips to play.</p>;
  return (
    <div>
      <video
        ref={ref}
        src={urls[i]}
        controls
        autoPlay
        onEnded={() => i < urls.length - 1 && setI(i + 1)}
        className="aspect-video w-full max-w-md rounded-lg border border-tan bg-black object-contain"
      />
      <div className="mt-1 flex items-center gap-3 text-xs text-muted">
        <span>
          Clip {i + 1} / {urls.length}
        </span>
        {i > 0 && (
          <button onClick={() => setI(i - 1)} className="hover:text-brick">
            ◀ prev
          </button>
        )}
        {i < urls.length - 1 && (
          <button onClick={() => setI(i + 1)} className="hover:text-brick">
            next ▶
          </button>
        )}
        <button onClick={() => setI(0)} className="hover:text-brick">
          ↺ restart
        </button>
      </div>
    </div>
  );
}
