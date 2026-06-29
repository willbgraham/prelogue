"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type ClipEdit = { trimStart: number; trimEnd: number; volume: number; duration: number };

/**
 * Non-destructive per-clip review editor: preview the recorded take, trim the
 * start/end, and set volume. The values are stored as metadata on the clip and
 * applied at playback (the file itself isn't re-encoded).
 */
export function ClipEditor({
  blob,
  edit,
  onChange,
}: {
  blob: Blob;
  edit: ClipEdit;
  onChange: (patch: Partial<ClipEdit>) => void;
}) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  const end = edit.trimEnd || edit.duration;

  function onMeta() {
    const d = videoRef.current?.duration;
    if (d && Number.isFinite(d) && (!edit.duration || !edit.trimEnd)) {
      onChange({ duration: d, trimEnd: d });
    }
  }
  function togglePreview() {
    const v = videoRef.current;
    if (!v) return;
    if (playing) {
      v.pause();
      setPlaying(false);
      return;
    }
    v.volume = Math.min(1, Math.max(0, edit.volume));
    v.currentTime = edit.trimStart;
    v.play().catch(() => {});
    setPlaying(true);
  }
  function onTime() {
    const v = videoRef.current;
    if (v && end && v.currentTime >= end) {
      v.pause();
      setPlaying(false);
    }
  }

  const range = "w-full accent-brick";
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="relative w-full shrink-0 sm:w-44">
        <video
          ref={videoRef}
          src={url}
          playsInline
          onLoadedMetadata={onMeta}
          onTimeUpdate={onTime}
          onEnded={() => setPlaying(false)}
          className="aspect-video w-full rounded-lg bg-black object-cover"
        />
        <button
          type="button"
          onClick={togglePreview}
          className="absolute bottom-1.5 left-1.5 rounded bg-black/65 px-2 py-0.5 text-xs font-medium text-white"
        >
          {playing ? "❚❚ Stop" : "▶ Preview"}
        </button>
      </div>
      <div className="flex-1 space-y-2.5">
        <label className="block text-xs text-muted">
          Trim start · {edit.trimStart.toFixed(1)}s
          <input
            type="range"
            min={0}
            max={edit.duration || 0}
            step={0.1}
            value={edit.trimStart}
            onChange={(e) => onChange({ trimStart: Math.min(parseFloat(e.target.value), end) })}
            className={range}
          />
        </label>
        <label className="block text-xs text-muted">
          Trim end · {end.toFixed(1)}s
          <input
            type="range"
            min={0}
            max={edit.duration || 0}
            step={0.1}
            value={end}
            onChange={(e) => onChange({ trimEnd: Math.max(parseFloat(e.target.value), edit.trimStart) })}
            className={range}
          />
        </label>
        <label className="block text-xs text-muted">
          Volume · {Math.round(edit.volume * 100)}%
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={edit.volume}
            onChange={(e) => onChange({ volume: parseFloat(e.target.value) })}
            className={range}
          />
        </label>
        <p className="text-xs text-muted">Keeps {Math.max(0, end - edit.trimStart).toFixed(1)}s of footage.</p>
      </div>
    </div>
  );
}
