"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildRows, prepareVoiceCues } from "@/lib/shared";
import type { ParsedScript, VoiceCueEntry, VoiceConfig } from "@/lib/shared";
import { getBrowserClient } from "@/lib/supabase/client";
import { VoicePicker } from "@/components/VoicePicker";

// Cap how many times a visitor can re-cast voices per day (cost guard). Voices
// already generated replay free; only a *new* voice config counts.
const MAX_VOICE_CHANGES_PER_DAY = 15;

function voiceChangesToday(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem("prelogue:voiceChanges");
    if (!raw) return 0;
    const o = JSON.parse(raw) as { date?: string; count?: number };
    return o.date === new Date().toISOString().slice(0, 10) ? o.count ?? 0 : 0;
  } catch {
    return 0;
  }
}

function bumpVoiceChanges(): number {
  const next = voiceChangesToday() + 1;
  try {
    window.localStorage.setItem(
      "prelogue:voiceChanges",
      JSON.stringify({ date: new Date().toISOString().slice(0, 10), count: next })
    );
  } catch {
    /* ignore */
  }
  return next;
}

/**
 * Manifest-driven table-read player. Walks the voiced rows (buildRows), plays
 * each line's generated audio through one persistent <audio>, and types the
 * Courier "page" in sync (reveal ∝ currentTime/duration). Generation runs on
 * the first Play press (with progress); autoplay is handled by a tap fallback.
 *
 * AI-audio playback (the Booth Nine demo). Cast actors' video clips are layered
 * in later (Phase C).
 */
export function TableReadPlayer({
  scriptId,
  parsed,
  voiceConfig,
  canChangeVoices = false,
}: {
  scriptId: string;
  parsed: ParsedScript | null;
  voiceConfig?: VoiceConfig | null;
  // Only the writer (or the public demo) may re-cast the AI voices.
  canChangeVoices?: boolean;
}) {
  const rows = useMemo(() => buildRows(parsed), [parsed]);
  const characters = useMemo(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const r of rows) {
      if ((r.kind === "line" || r.kind === "actor" || r.kind === "cue") && r.character) {
        const up = r.character.toUpperCase();
        if (!seen.has(up)) {
          seen.add(up);
          names.push(r.character);
        }
      }
    }
    return names;
  }, [rows]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const manifestRef = useRef<Map<number, VoiceCueEntry>>(new Map());
  const activeRef = useRef(0);
  const playingRef = useRef(false);
  const activeLineRef = useRef<HTMLDivElement | null>(null);
  const overrideRef = useRef<VoiceConfig | null>(null);
  const preparedKeyRef = useRef<string | null>(null);

  const [ready, setReady] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [reveal, setReveal] = useState(0);
  const [needsTap, setNeedsTap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [changesUsed, setChangesUsed] = useState(0);

  useEffect(() => {
    setChangesUsed(voiceChangesToday());
  }, []);
  useEffect(() => {
    activeRef.current = active;
    activeLineRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active]);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  const stop = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    audioRef.current?.pause();
  }, []);

  const playRow = useCallback(
    async (pos: number) => {
      if (pos >= rows.length) {
        stop();
        return;
      }
      activeRef.current = pos;
      setActive(pos);
      setReveal(0);
      setNeedsTap(false);

      const row = rows[pos];
      const audio = audioRef.current;
      const cue = manifestRef.current.get(row.elementIndex);

      // No audio for this line (e.g. preview limit reached): show it, move on.
      if (!audio || !cue?.signedUrl) {
        setReveal(row.text.length);
        window.setTimeout(() => {
          if (playingRef.current) playRow(pos + 1);
        }, 800);
        return;
      }

      audio.src = cue.signedUrl;
      try {
        await audio.play();
      } catch {
        playingRef.current = false;
        setPlaying(false);
        setNeedsTap(true);
      }
    },
    [rows, stop]
  );

  // Audio element events: type the line, advance on end.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      const row = rows[activeRef.current];
      if (row && audio.duration > 0) {
        setReveal(Math.ceil(row.text.length * (audio.currentTime / audio.duration)));
      }
    };
    const onEnded = () => {
      const row = rows[activeRef.current];
      if (row) setReveal(row.text.length);
      if (playingRef.current) playRow(activeRef.current + 1);
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("ended", onEnded);
    };
  }, [rows, playRow]);

  const ensureReady = useCallback(async () => {
    // Re-generate whenever the chosen voices change (keyed on the override).
    const key = overrideRef.current ? JSON.stringify(overrideRef.current) : "default";
    if (preparedKeyRef.current === key) return true;
    setPreparing(true);
    setError(null);
    try {
      const client = getBrowserClient();
      const m = await prepareVoiceCues(client, scriptId, {
        onProgress: setProgress,
        voiceConfig: overrideRef.current ?? undefined,
      });
      manifestRef.current = m;
      preparedKeyRef.current = key;
      setReady(true);
      setPreparing(false);
      return true;
    } catch (e) {
      setPreparing(false);
      setError(e instanceof Error ? e.message : "Couldn't prepare the audio.");
      return false;
    }
  }, [scriptId]);

  const applyVoices = useCallback(
    async (cfg: VoiceConfig) => {
      setShowPicker(false);
      // Only a genuinely new voice config regenerates (and costs); re-applying
      // the same voices replays from cache and doesn't count against the cap.
      const newKey = JSON.stringify(cfg);
      const willRegenerate = preparedKeyRef.current !== newKey;
      if (willRegenerate && voiceChangesToday() >= MAX_VOICE_CHANGES_PER_DAY) {
        setError(
          "You've reached today's voice-change limit. Voices you've already tried still replay free — come back tomorrow to try more."
        );
        return;
      }
      overrideRef.current = cfg;
      stop();
      activeRef.current = 0;
      setActive(0);
      setReveal(0);
      setNeedsTap(false);
      setReady(false);
      if (willRegenerate) setChangesUsed(bumpVoiceChanges());
      await ensureReady(); // regenerates with the new voices (keyed on override)
      playingRef.current = true;
      setPlaying(true);
      playRow(0);
    },
    [ensureReady, playRow, stop]
  );

  const handlePlay = useCallback(async () => {
    if (playing) {
      stop();
      return;
    }
    await ensureReady();
    playingRef.current = true;
    setPlaying(true);

    const audio = audioRef.current;
    if (audio && audio.src && audio.paused && audio.currentTime > 0 && !audio.ended) {
      try {
        await audio.play();
        return;
      } catch {
        playingRef.current = false;
        setPlaying(false);
        setNeedsTap(true);
        return;
      }
    }
    playRow(activeRef.current);
  }, [playing, ensureReady, playRow, stop]);

  const handleTap = useCallback(() => {
    setNeedsTap(false);
    playingRef.current = true;
    setPlaying(true);
    playRow(activeRef.current);
  }, [playRow]);

  const handleRestart = useCallback(() => {
    stop();
    if (audioRef.current) audioRef.current.currentTime = 0;
    activeRef.current = 0;
    setActive(0);
    setReveal(0);
    setNeedsTap(false);
  }, [stop]);

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-tan bg-ivory p-5 font-mono text-sm text-muted">
        This script hasn&rsquo;t been parsed into a readable scene yet.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-tan bg-ivory">
      <audio ref={audioRef} preload="auto" />

      <div className="flex items-center gap-3 border-b border-tan px-4 py-3">
        <button
          onClick={handlePlay}
          disabled={preparing}
          className="inline-flex items-center gap-2 rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {preparing
            ? `Generating ${Math.round(progress * 100)}%`
            : playing
              ? "❚❚ Pause"
              : ready
                ? "▶ Play"
                : "▶ Play with AI voices"}
        </button>
        <button
          onClick={handleRestart}
          className="rounded-lg border border-tan px-3 py-2 text-sm text-taupe hover:bg-elevated"
        >
          ↺ Restart
        </button>
        {canChangeVoices && (
          <button
            onClick={() => setShowPicker(true)}
            className="rounded-lg border border-tan px-3 py-2 text-sm text-taupe hover:bg-elevated"
          >
            🎙 Voices
          </button>
        )}
        <span className="ml-auto font-mono text-xs text-muted">
          {Math.min(active + 1, rows.length)} / {rows.length}
        </span>
      </div>

      {preparing && (
        <div className="h-1 w-full bg-tan/40">
          <div
            className="h-full bg-brick transition-all"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      )}
      {error && <div className="px-4 py-2 text-sm text-brick">{error}</div>}

      {/* The screenplay "page" */}
      <div className="max-h-[60vh] overflow-y-auto bg-[#faf7ef] px-6 py-6 sm:px-10">
        {rows.map((r, i) => {
          const isActive = i === active;
          const typing = isActive && playing && reveal < r.text.length;
          const shown = isActive && playing ? r.text.slice(0, reveal) : r.text;
          const Cursor = typing ? <span className="animate-pulse">▌</span> : null;
          return (
            <div
              key={r.elementIndex}
              ref={isActive ? activeLineRef : undefined}
              className={`mb-4 ${i < active ? "opacity-90" : isActive ? "" : "opacity-40"}`}
            >
              {r.sceneHeading && (
                <div className="mb-3 font-mono text-xs font-bold uppercase tracking-wider text-ink">
                  {r.sceneHeading}
                </div>
              )}
              {r.kind === "narrator" ? (
                <div>
                  <div className="mb-1 font-mono text-sm font-bold uppercase tracking-wide text-muted">
                    Narrator
                  </div>
                  <p className="font-mono text-[15px] leading-relaxed text-taupe">
                    {shown}
                    {Cursor}
                  </p>
                </div>
              ) : (
                <div className="text-center">
                  {r.character && (
                    <div className="font-mono text-sm font-bold uppercase tracking-wide text-ink">
                      {r.character}
                    </div>
                  )}
                  <p className="mx-auto mt-1 max-w-md font-mono text-[15px] leading-relaxed text-ink">
                    {shown}
                    {Cursor}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {needsTap && (
        <button
          onClick={handleTap}
          className="w-full border-t border-tan bg-brick/10 px-4 py-3 text-sm font-medium text-brick"
        >
          ▶ Tap to play the audio
        </button>
      )}

      {showPicker && (
        <VoicePicker
          characters={characters}
          startConfig={overrideRef.current ?? voiceConfig ?? { mode: "per_character" }}
          onApply={applyVoices}
          onClose={() => setShowPicker(false)}
          changesLeft={Math.max(0, MAX_VOICE_CHANGES_PER_DAY - changesUsed)}
        />
      )}
    </div>
  );
}
