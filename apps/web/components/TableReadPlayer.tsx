"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildRows, prepareVoiceCues, DEFAULT_AMBIENCE_VOLUME } from "@/lib/shared";
import type { AmbienceConfig, ParsedScript, VoiceCueEntry, VoiceConfig } from "@/lib/shared";
import { getBrowserClient } from "@/lib/supabase/client";
import { VoicePicker } from "@/components/VoicePicker";
import { CastIcon } from "@/components/icons";

// Cap how many times a visitor can re-cast voices per day (cost guard). Voices
// already generated replay free; only a *new* voice config counts.
const MAX_VOICE_CHANGES_PER_DAY = 15;

// A cast actor's clip + the non-destructive edits applied at playback.
type ClipInfo = { url: string; trimStart: number; trimEnd: number | null; volume: number };

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
  ambience = null,
  canChangeVoices = false,
  isOwner = false,
}: {
  scriptId: string;
  parsed: ParsedScript | null;
  voiceConfig?: VoiceConfig | null;
  // The writer's saved per-scene background beds (scripts.ambience_config).
  ambience?: AmbienceConfig | null;
  // Only the writer (or the public demo) may re-cast the AI voices.
  canChangeVoices?: boolean;
  // The writer: their voice picks persist to scripts.voice_config (survive refresh).
  isOwner?: boolean;
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

  // Role → its spoken lines, for the picker's per-line voice settings.
  // Narrator = the action lines, under the same key the server resolves.
  const linesByRole = useMemo(() => {
    const map: Record<string, { index: number; text: string }[]> = {};
    for (const r of rows) {
      if (r.kind === "narrator") {
        (map["__narrator__"] ??= []).push({ index: r.elementIndex, text: r.text });
      } else if (r.character) {
        (map[r.character.toUpperCase()] ??= []).push({ index: r.elementIndex, text: r.text });
      }
    }
    return map;
  }, [rows]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Scene background bed: a second looping <audio> under the voices. Signed
  // URLs per scene load once; playRow swaps the track on scene changes.
  const ambienceRef = useRef<HTMLAudioElement | null>(null);
  const ambienceSceneRef = useRef<number | null>(null);
  const ambienceUrlsRef = useRef<Map<number, string>>(new Map());
  const ambienceMutedRef = useRef(false);
  const manifestRef = useRef<Map<number, VoiceCueEntry>>(new Map());
  // element_index → cast clip (signed URL + non-destructive trim/volume) — built
  // ONLY from the roles the user explicitly cast to an actor (never automatic).
  const clipMapRef = useRef<Map<number, ClipInfo>>(new Map());
  // Preloaded cast clips: signed URL → in-memory blob object URL, so a cast line
  // plays instantly instead of downloading cold when its turn comes (slow links).
  const clipBlobRef = useRef<Map<string, string>>(new Map());
  const preloadAbortRef = useRef<AbortController | null>(null);
  const clipsBySubRef = useRef<Map<string, Map<number, ClipInfo>>>(new Map()); // submissionId → (element_index → clip)
  const castMapRef = useRef<Map<string, string>>(new Map()); // ROLE → submissionId
  const clipEndRef = useRef<number | null>(null); // active clip's trim-end (seconds), or null
  const activeRef = useRef(0);
  const playingRef = useRef(false);
  const activeLineRef = useRef<HTMLDivElement | null>(null);
  const scriptScrollRef = useRef<HTMLDivElement | null>(null);
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
  const [showVideo, setShowVideo] = useState(false);
  // Preload progress for the cast video clips (0 → total). Transient UI cue.
  const [videosReady, setVideosReady] = useState(0);
  const [videosTotal, setVideosTotal] = useState(0);
  // Ambience: whether any scene bed is loaded (shows the ♪ toggle) + mute.
  const [ambienceLoaded, setAmbienceLoaded] = useState(false);
  const [ambienceMuted, setAmbienceMuted] = useState(false);
  // Actor submissions per role (ROLE → takes) for the picker's "Actors" option.
  const [subsByRole, setSubsByRole] = useState<
    Record<string, { id: string; actor: string; take: number; avatar: string | null; clips: string[] }[]>
  >({});
  // ROLE → the writer's ★ submission id (the default cast + picker badge).
  const [writersCast, setWritersCast] = useState<Record<string, string>>({});

  // Prefetch every currently-cast clip into an in-memory blob (earliest line
  // first, so the first cast line is ready soonest). Idempotent per URL, and
  // silently falls back to on-demand streaming if a fetch fails. Re-run whenever
  // the cast changes; the previous run is aborted so we don't fetch stale clips.
  const preloadClips = useCallback(async () => {
    const urls = [...clipMapRef.current.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, info]) => info.url);
    preloadAbortRef.current?.abort();
    const controller = new AbortController();
    preloadAbortRef.current = controller;
    const pending = urls.filter((u) => !clipBlobRef.current.has(u));
    setVideosTotal(urls.length);
    setVideosReady(urls.length - pending.length);
    for (const url of pending) {
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) continue;
        const blob = await res.blob();
        if (controller.signal.aborted) return;
        clipBlobRef.current.set(url, URL.createObjectURL(blob));
        setVideosReady((n) => n + 1);
      } catch {
        if (controller.signal.aborted) return;
        // network/CORS hiccup — leave this clip to stream on demand
      }
    }
  }, []);

  // Revoke preloaded blobs + cancel in-flight prefetches on unmount.
  useEffect(() => {
    const blobs = clipBlobRef.current;
    return () => {
      preloadAbortRef.current?.abort();
      for (const u of blobs.values()) URL.revokeObjectURL(u);
      blobs.clear();
    };
  }, []);

  useEffect(() => {
    setChangesUsed(voiceChangesToday());
  }, []);

  // Bed volume under the voices (writer-set, clamped like the server would).
  const ambienceVolume = Math.min(0.4, Math.max(0, ambience?.volume ?? DEFAULT_AMBIENCE_VOLUME));

  // Sign the writer's saved scene beds once; playback swaps between them.
  useEffect(() => {
    let alive = true;
    const scenes = ambience?.enabled ? (ambience.scenes ?? {}) : {};
    const entries = Object.entries(scenes).filter(([, s]) => s?.path);
    if (!entries.length) return;
    (async () => {
      const { data: signed } = await getBrowserClient()
        .storage.from("scripts")
        .createSignedUrls(
          entries.map(([, s]) => s.path),
          86400
        );
      if (!alive) return;
      const map = new Map<number, string>();
      entries.forEach(([k], i) => {
        const u = signed?.[i]?.signedUrl;
        if (u) map.set(Number(k), u);
      });
      ambienceUrlsRef.current = map;
      setAmbienceLoaded(map.size > 0);
    })();
    return () => {
      alive = false;
    };
  }, [ambience]);

  // Keep the bed matched to the active row's scene: swap tracks on scene
  // changes, keep looping within a scene, stay silent where no bed exists.
  const syncAmbience = useCallback(
    (sceneIdx: number) => {
      const a = ambienceRef.current;
      if (!a) return;
      const url = ambienceUrlsRef.current.get(sceneIdx);
      if (!url) {
        ambienceSceneRef.current = sceneIdx;
        a.pause();
        return;
      }
      if (ambienceSceneRef.current !== sceneIdx) {
        a.src = url;
        a.currentTime = 0;
        ambienceSceneRef.current = sceneIdx;
      }
      a.loop = true;
      a.volume = ambienceMutedRef.current ? 0 : ambienceVolume;
      a.play().catch(() => {}); // the bed is optional — never block the read on it
    },
    [ambienceVolume]
  );

  const toggleAmbienceMute = useCallback(() => {
    const next = !ambienceMutedRef.current;
    ambienceMutedRef.current = next;
    setAmbienceMuted(next);
    const a = ambienceRef.current;
    if (a) a.volume = next ? 0 : ambienceVolume; // keeps looping — unmute is seamless
  }, [ambienceVolume]);

  // The Cast section's header button (a separate component) opens the picker
  // via a window event — the picker renders as a fixed overlay, so no scroll.
  useEffect(() => {
    const open = () => setShowPicker(true);
    window.addEventListener("prelogue:choose-cast", open);
    return () => window.removeEventListener("prelogue:choose-cast", open);
  }, []);

  // Load actor submissions for the picker's "Actors" option. Sign every clip and
  // index it by submission — but splice NOTHING until a role is explicitly cast
  // to an actor in the picker (clipMapRef stays empty by default).
  useEffect(() => {
    let alive = true;
    (async () => {
      const client = getBrowserClient();
      const { data } = await client
        .from("submissions")
        .select(
          "id, take_number, is_writers_choice, moderation_status, clips, character:characters(name), actor:users!submissions_actor_id_fkey(display_name, avatar_url)"
        )
        .eq("script_id", scriptId);
      const subs =
        (data as unknown as {
          id: string;
          take_number: number | null;
          is_writers_choice: boolean;
          moderation_status: string;
          clips:
            | { element_index: number; clip_url: string; trim_start?: number; trim_end?: number; volume?: number }[]
            | null;
          character: { name: string } | null;
          actor: { display_name: string; avatar_url: string | null } | null;
        }[]) ?? [];
      if (!subs.length) return;

      const paths = new Set<string>();
      for (const s of subs) for (const c of s.clips ?? []) paths.add(c.clip_url);
      const signedByPath = new Map<string, string>();
      if (paths.size) {
        const { data: signed } = await client.storage
          .from("submissions")
          .createSignedUrls([...paths], 86400);
        [...paths].forEach((p, i) => signedByPath.set(p, signed?.[i]?.signedUrl ?? ""));
      }

      const clipsBySub = new Map<string, Map<number, ClipInfo>>();
      const byRole: Record<
        string,
        { id: string; actor: string; take: number; avatar: string | null; clips: string[] }[]
      > = {};
      for (const s of subs) {
        const m = new Map<number, ClipInfo>();
        for (const c of s.clips ?? []) {
          const u = signedByPath.get(c.clip_url);
          if (u)
            m.set(c.element_index, {
              url: u,
              trimStart: c.trim_start ?? 0,
              trimEnd: c.trim_end ?? null,
              volume: c.volume ?? 1,
            });
        }
        clipsBySub.set(s.id, m);
        const role = (s.character?.name ?? "").toUpperCase();
        if (role) {
          const ordered = [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, info]) => info.url);
          (byRole[role] ??= []).push({
            id: s.id,
            actor: s.actor?.display_name ?? "Actor",
            take: s.take_number ?? 1,
            avatar: s.actor?.avatar_url ?? null,
            clips: ordered,
          });
        }
      }
      if (!alive) return;
      clipsBySubRef.current = clipsBySub;
      setSubsByRole(byRole);
      // The writer's ★ choices (approved reads only): the read's default cast,
      // and the "Writer's pick" badge in the picker.
      const defaultCast = new Map<string, string>();
      const defaultClips = new Map<number, ClipInfo>();
      for (const s of subs) {
        if (!s.is_writers_choice || s.moderation_status !== "approved") continue;
        const role = (s.character?.name ?? "").toUpperCase();
        if (!role) continue;
        defaultCast.set(role, s.id);
        const m = clipsBySub.get(s.id);
        if (m) for (const [idx, info] of m) defaultClips.set(idx, info);
      }
      setWritersCast(Object.fromEntries(defaultCast));
      // Default the performance to those choices unless the viewer already
      // overrode the cast in this session.
      if (castMapRef.current.size === 0 && defaultCast.size) {
        castMapRef.current = defaultCast;
        clipMapRef.current = defaultClips;
      }
      // Warm the cast clips now so playback is instant when the viewer hits play.
      preloadClips();
    })();
    return () => {
      alive = false;
    };
  }, [scriptId, preloadClips]);
  useEffect(() => {
    activeRef.current = active;
    // Auto-scroll the script *within its own box* (don't move the page/stage).
    const line = activeLineRef.current;
    const box = scriptScrollRef.current;
    if (line && box) {
      box.scrollTo({
        top: line.offsetTop - box.clientHeight / 2 + line.clientHeight / 2,
        behavior: "smooth",
      });
    }
  }, [active]);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  const stop = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    audioRef.current?.pause();
    videoRef.current?.pause();
    ambienceRef.current?.pause();
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
      syncAmbience(row.sceneIndex);
      const audio = audioRef.current;
      const video = videoRef.current;
      const clip = clipMapRef.current.get(row.elementIndex);

      // An actor recorded this line — play their video clip (it carries its own
      // audio, replacing the AI voice). Honor the clip's trim + volume.
      if (clip && video) {
        audio?.pause();
        setShowVideo(true);
        // Prefer the preloaded in-memory blob (instant); fall back to streaming.
        video.src = clipBlobRef.current.get(clip.url) ?? clip.url;
        video.volume = clip.volume;
        clipEndRef.current = clip.trimEnd;
        video.currentTime = clip.trimStart;
        try {
          await video.play();
        } catch {
          playingRef.current = false;
          setPlaying(false);
          setNeedsTap(true);
        }
        return;
      }

      clipEndRef.current = null;
      setShowVideo(false);
      video?.pause();
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
    [rows, stop, syncAmbience]
  );

  // Media events (AI audio AND the actor clip video): type the line ∝ playback,
  // advance on end. Whichever element is playing fires these.
  useEffect(() => {
    const audio = audioRef.current;
    const video = videoRef.current;
    const onTime = (e: Event) => {
      const m = e.currentTarget as HTMLMediaElement;
      // Honor a cast clip's trim-end: stop early and advance to the next line.
      if (clipEndRef.current != null && m.currentTime >= clipEndRef.current) {
        clipEndRef.current = null;
        m.pause();
        if (playingRef.current) playRow(activeRef.current + 1);
        return;
      }
      const row = rows[activeRef.current];
      if (row && m.duration > 0) {
        setReveal(Math.ceil(row.text.length * (m.currentTime / m.duration)));
      }
    };
    const onEnded = () => {
      const row = rows[activeRef.current];
      if (row) setReveal(row.text.length);
      if (playingRef.current) playRow(activeRef.current + 1);
    };
    for (const m of [audio, video]) {
      m?.addEventListener("timeupdate", onTime);
      m?.addEventListener("ended", onEnded);
    }
    return () => {
      for (const m of [audio, video]) {
        m?.removeEventListener("timeupdate", onTime);
        m?.removeEventListener("ended", onEnded);
      }
    };
  }, [rows, playRow]);

  const ensureReady = useCallback(async () => {
    // Re-generate whenever the chosen voices change (keyed on the override).
    const key = overrideRef.current ? JSON.stringify(overrideRef.current) : "default";
    if (preparedKeyRef.current === key) {
      setReady(true); // already prepared (e.g. a cast-only re-apply)
      return true;
    }
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
    async (cfg: VoiceConfig, cast: Record<string, string> = {}) => {
      setShowPicker(false);
      // Actor-clip map = only the roles explicitly cast to an actor in the picker.
      const castMap = new Map(Object.entries(cast));
      castMapRef.current = castMap;
      const clipMap = new Map<number, ClipInfo>();
      for (const subId of castMap.values()) {
        const clips = clipsBySubRef.current.get(subId);
        if (clips) for (const [idx, info] of clips) clipMap.set(idx, info);
      }
      clipMapRef.current = clipMap;
      preloadClips(); // warm the newly-cast clips so playback stays instant
      // AI-voice changes are writer-or-demo only (the server enforces the same);
      // for everyone else the picker is actor casting, which regenerates nothing
      // and never counts against the daily voice-change cap.
      if (canChangeVoices) {
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
        // The writer's picks ARE the script's real config — persist them so they
        // survive a refresh (RLS also restricts this to the owner). Visitors on the
        // public demo keep a temporary in-memory override only.
        if (isOwner) {
          getBrowserClient()
            .from("scripts")
            .update({ voice_config: cfg })
            .eq("id", scriptId)
            .then(
              () => {},
              () => {}
            );
        }
        if (willRegenerate) {
          setReady(false);
          setChangesUsed(bumpVoiceChanges());
        }
      }
      stop();
      activeRef.current = 0;
      setActive(0);
      setReveal(0);
      setNeedsTap(false);
      await ensureReady(); // regenerates with the new voices (keyed on override)
      playingRef.current = true;
      setPlaying(true);
      playRow(0);
    },
    [ensureReady, playRow, stop, isOwner, scriptId, preloadClips, canChangeVoices]
  );

  // The picker's Save: persist role/line voice settings NOW without regenerating.
  // The override becomes the picker's start config on reopen, and the next
  // Play/Apply prepares with it (keyed on the override JSON).
  const persistConfig = useCallback(
    (cfg: VoiceConfig) => {
      overrideRef.current = cfg;
      if (isOwner) {
        getBrowserClient()
          .from("scripts")
          .update({ voice_config: cfg })
          .eq("id", scriptId)
          .then(
            () => {},
            () => {}
          );
      }
    },
    [isOwner, scriptId]
  );

  const handlePlay = useCallback(async () => {
    if (playing) {
      stop();
      return;
    }
    await ensureReady();
    playingRef.current = true;
    setPlaying(true);
    playRow(activeRef.current);
  }, [playing, ensureReady, playRow, stop]);

  const handleTap = useCallback(() => {
    setNeedsTap(false);
    playingRef.current = true;
    setPlaying(true);
    playRow(activeRef.current);
  }, [playRow]);

  // Click a line in the script to jump there (forward or back).
  const jumpTo = useCallback(
    (i: number) => {
      activeRef.current = i;
      setActive(i);
      setReveal(0);
      if (!ready) return; // not generated yet — just move the cursor; Play starts here
      playingRef.current = true;
      setPlaying(true);
      playRow(i);
    },
    [ready, playRow]
  );

  const handleRestart = useCallback(() => {
    stop();
    if (audioRef.current) audioRef.current.currentTime = 0;
    const amb = ambienceRef.current;
    if (amb) {
      try {
        amb.currentTime = 0;
      } catch {
        /* no src yet */
      }
    }
    ambienceSceneRef.current = null; // restart re-enters scene 0's bed fresh
    setShowVideo(false);
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

  // Stage = the current line typing out (AI/narrator) or, for a cast role, video.
  const activeRow = rows[active];
  const stageText = playing && activeRow ? activeRow.text.slice(0, reveal) : activeRow?.text ?? "";
  const stageCursor = !!(playing && activeRow && reveal < activeRow.text.length);

  return (
    <div className="overflow-hidden rounded-xl border border-tan bg-ivory">
      <audio ref={audioRef} preload="auto" />
      <audio ref={ambienceRef} loop preload="auto" />

      {/* STAGE — actor video, or the current line typing out on a "page" */}
      <div className="relative aspect-video w-full bg-black">
        <video
          ref={videoRef}
          playsInline
          preload="auto"
          className={`absolute inset-0 h-full w-full object-contain ${showVideo ? "block" : "hidden"}`}
        />
        {!showVideo && (
          <div className="absolute inset-0 flex flex-col items-center justify-center overflow-y-auto bg-[#faf7ef] px-6 py-8 text-center">
            {activeRow ? (
              <>
                <div className="mb-2 font-mono text-xs font-bold uppercase tracking-wider text-muted">
                  {activeRow.kind === "narrator" ? "Narrator" : activeRow.character}
                </div>
                <p className="max-w-xl font-mono text-lg leading-relaxed text-ink sm:text-xl">
                  {stageText}
                  {stageCursor && <span className="animate-pulse">▌</span>}
                </p>
              </>
            ) : (
              <p className="font-mono text-sm text-muted">Press play to begin the read.</p>
            )}
          </div>
        )}
      </div>

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
              : "▶ Play"}
        </button>
        <button
          onClick={handleRestart}
          className="rounded-lg border border-tan px-3 py-2 text-sm text-taupe hover:bg-elevated"
        >
          ↺ Restart
        </button>
        {/* Everyone can open the picker: writers (and the demo) re-cast AI voices;
            on real scripts visitors cast actors into the roles instead. */}
        <button
          onClick={() => setShowPicker(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-tan px-3 py-2 text-sm text-taupe hover:bg-elevated"
        >
          <CastIcon className="h-4 w-4" />
          Choose Cast
        </button>
        <div className="ml-auto flex items-center gap-3 font-mono text-xs text-muted">
          {videosTotal > 0 && videosReady < videosTotal && (
            <span title="Caching cast videos for instant playback">
              Caching video {videosReady}/{videosTotal}…
            </span>
          )}
          {ambienceLoaded && (
            <button
              onClick={toggleAmbienceMute}
              title={ambienceMuted ? "Unmute scene music" : "Mute scene music"}
              aria-pressed={!ambienceMuted}
              className={`rounded-lg border px-2.5 py-1.5 text-sm ${
                ambienceMuted
                  ? "border-tan text-muted opacity-60"
                  : "border-tan text-taupe hover:bg-elevated"
              }`}
            >
              <span className={ambienceMuted ? "line-through" : ""}>♪</span>
            </button>
          )}
          <span>
            {Math.min(active + 1, rows.length)} / {rows.length}
          </span>
        </div>
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

      {/* SCRIPT — full text; the active line is highlighted and auto-scrolls. */}
      <div
        ref={scriptScrollRef}
        className="relative max-h-[50vh] overflow-y-auto bg-[#faf7ef] px-4 py-6 sm:px-8"
      >
        {rows.map((r, i) => {
          const isActive = i === active;
          return (
            <div
              key={r.elementIndex}
              ref={isActive ? activeLineRef : undefined}
              onClick={() => jumpTo(i)}
              role="button"
              title="Jump to this line"
              className={`mb-2 cursor-pointer rounded-lg px-3 py-2 transition-colors hover:bg-tan/20 ${
                isActive
                  ? "bg-brick/10 ring-1 ring-brick/25"
                  : i < active
                    ? "opacity-70 hover:opacity-100"
                    : "opacity-45 hover:opacity-100"
              }`}
            >
              {r.sceneHeading && (
                <div className="mb-2 font-mono text-xs font-bold uppercase tracking-wider text-ink">
                  {r.sceneHeading}
                </div>
              )}
              {r.kind === "narrator" ? (
                <div>
                  <div className="mb-1 font-mono text-xs font-bold uppercase tracking-wide text-muted">
                    Narrator
                  </div>
                  <p className="font-mono text-[15px] leading-relaxed text-taupe">{r.text}</p>
                </div>
              ) : (
                <div className="text-center">
                  {r.character && (
                    <div className="font-mono text-sm font-bold uppercase tracking-wide text-ink">
                      {r.character}
                    </div>
                  )}
                  <p className="mx-auto mt-1 max-w-md font-mono text-[15px] leading-relaxed text-ink">
                    {r.text}
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
          scriptId={scriptId}
          characters={characters}
          startConfig={overrideRef.current ?? voiceConfig ?? { mode: "per_character" }}
          submissionsByRole={subsByRole}
          linesByRole={linesByRole}
          startCast={Object.fromEntries(castMapRef.current)}
          writersCast={writersCast}
          canChangeVoices={canChangeVoices}
          canPersist={isOwner}
          onSaveConfig={persistConfig}
          onApply={applyVoices}
          onClose={() => setShowPicker(false)}
          changesLeft={
            canChangeVoices ? Math.max(0, MAX_VOICE_CHANGES_PER_DAY - changesUsed) : undefined
          }
        />
      )}
    </div>
  );
}
