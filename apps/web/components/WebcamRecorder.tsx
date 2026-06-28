"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { buildRows, prepareVoiceCues, clipPath } from "@/lib/shared";
import type { ParsedScript, VoiceCueEntry } from "@/lib/shared";
import { getBrowserClient } from "@/lib/supabase/client";
import { uploadClipResumable } from "@/lib/upload";

type Mode = "setup" | "recording" | "review" | "uploading" | "done";
interface Clip {
  elementIndex: number;
  blob: Blob;
  text: string;
}

const MIME =
  typeof MediaRecorder !== "undefined"
    ? MediaRecorder.isTypeSupported("video/mp4")
      ? "video/mp4"
      : MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus"
        : "video/webm"
    : "video/webm";
const EXT = MIME.startsWith("video/mp4") ? "mp4" : "webm";

export function WebcamRecorder({
  characterId,
  characterName,
  scriptId,
  parsed,
  userId,
}: {
  characterId: string;
  characterName: string;
  scriptId: string;
  parsed: ParsedScript | null;
  userId: string;
}) {
  const rows = useMemo(() => buildRows(parsed, { actorName: characterName }), [parsed, characterName]);
  const actorRows = useMemo(() => rows.filter((r) => r.kind === "actor"), [rows]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const clipsRef = useRef<Map<number, Clip>>(new Map());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const manifestRef = useRef<Map<number, VoiceCueEntry>>(new Map());
  const posRef = useRef(0);

  const [mode, setMode] = useState<Mode>("setup");
  const [camReady, setCamReady] = useState(false);
  const [aiOn, setAiOn] = useState(true);
  const [pos, setPos] = useState(0);
  const [recording, setRecording] = useState(false);
  const [clipCount, setClipCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);

  const startCamera = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: true,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setCamReady(true);
    } catch {
      setError("Camera + microphone access is required. Allow it and try again.");
    }
  }, []);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      audioRef.current?.pause();
    },
    []
  );

  const goTo = useCallback(
    async (p: number) => {
      if (p >= rows.length) {
        setRecording(false);
        setMode("review");
        return;
      }
      posRef.current = p;
      setPos(p);
      const row = rows[p];
      if (row.kind === "actor") {
        chunksRef.current = [];
        const rec = new MediaRecorder(streamRef.current!, { mimeType: MIME });
        rec.ondataavailable = (e) => {
          if (e.data.size) chunksRef.current.push(e.data);
        };
        recorderRef.current = rec;
        rec.start();
        setRecording(true);
      } else {
        setRecording(false);
        const cue = manifestRef.current.get(row.elementIndex);
        if (aiOn && cue?.signedUrl && audioRef.current) {
          audioRef.current.src = cue.signedUrl;
          audioRef.current.onended = () => goTo(p + 1);
          audioRef.current.play().catch(() => {});
        }
      }
    },
    [rows, aiOn]
  );

  const finishLine = useCallback(() => {
    const rec = recorderRef.current;
    const row = rows[posRef.current];
    if (rec && rec.state !== "inactive") {
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: MIME });
        clipsRef.current.set(row.elementIndex, {
          elementIndex: row.elementIndex,
          blob,
          text: row.text,
        });
        setClipCount(clipsRef.current.size);
        goTo(posRef.current + 1);
      };
      rec.stop();
    } else {
      goTo(posRef.current + 1);
    }
  }, [rows, goTo]);

  const startSession = useCallback(async () => {
    setError(null);
    if (aiOn) {
      setStatus("Loading scene-partner voices…");
      try {
        manifestRef.current = await prepareVoiceCues(getBrowserClient(), scriptId, {
          onProgress: setProgress,
        });
      } catch {
        /* AI optional — proceed without */
      }
      setStatus("");
    }
    clipsRef.current = new Map();
    setClipCount(0);
    setMode("recording");
    goTo(0);
  }, [aiOn, scriptId, goTo]);

  const submit = useCallback(async () => {
    setMode("uploading");
    setError(null);
    const supabase = getBrowserClient();
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error("Please sign in again.");

      const { count } = await supabase
        .from("submissions")
        .select("*", { count: "exact", head: true })
        .eq("actor_id", userId)
        .eq("character_id", characterId);
      const takeNumber = (count ?? 0) + 1;

      const takes = [...clipsRef.current.values()].sort((a, b) => a.elementIndex - b.elementIndex);
      const clips: { element_index: number; clip_url: string }[] = [];
      for (let i = 0; i < takes.length; i++) {
        const t = takes[i];
        setStatus(`Uploading clip ${i + 1} of ${takes.length}…`);
        setProgress(0);
        const path = clipPath(userId, scriptId, characterId, takeNumber, t.elementIndex, EXT);
        await uploadClipResumable(t.blob, path, token, MIME, setProgress);
        clips.push({ element_index: t.elementIndex, clip_url: path });
      }

      setStatus("Saving your read…");
      const { data: inserted, error: insErr } = await supabase
        .from("submissions")
        .insert({
          actor_id: userId,
          character_id: characterId,
          script_id: scriptId,
          video_url: null,
          clips,
          take_number: takeNumber,
        })
        .select("id")
        .single();
      if (insErr) throw insErr;
      await supabase
        .from("submissions")
        .update({ is_preferred_take: false })
        .eq("actor_id", userId)
        .eq("character_id", characterId);
      await supabase.from("submissions").update({ is_preferred_take: true }).eq("id", inserted.id);

      // Automated video moderation — the read stays hidden until it passes.
      setStatus("Reviewing your read…");
      const { data: mod } = await supabase.functions.invoke("moderate-submission", {
        body: { submission_id: inserted.id },
      });
      if (mod?.status === "rejected") {
        setError(
          "This read couldn't be published — our automated check flagged it. Please re-record."
        );
        setMode("review");
        return;
      }
      setMode("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
      setMode("review");
    }
  }, [characterId, scriptId, userId]);

  const row = rows[pos];

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-8">
      <audio ref={audioRef} />
      <div className="mb-4 flex items-center justify-between">
        <Link href={`/script/${scriptId}`} className="text-sm text-taupe hover:text-ink">
          ← Back
        </Link>
        <span className="font-mono text-xs text-muted">
          Reading for <span className="text-ink">{characterName}</span>
        </span>
      </div>

      {error && <p className="mb-4 rounded-lg bg-brick/10 px-3 py-2 text-sm text-brick">{error}</p>}

      {/* camera preview (kept mounted so the stream stays attached) */}
      <div className={mode === "setup" || mode === "recording" ? "block" : "hidden"}>
        <video
          ref={videoRef}
          muted
          autoPlay
          playsInline
          className="aspect-video w-full rounded-xl border border-tan bg-black object-cover"
        />
      </div>

      {mode === "setup" && (
        <div className="mt-5">
          <h1 className="font-slab text-2xl">Read for {characterName}</h1>
          <p className="mt-2 text-taupe">
            You&rsquo;ll record your {actorRows.length} line{actorRows.length === 1 ? "" : "s"} one
            at a time. Other characters can be played by AI as your scene partner.
          </p>
          {!camReady ? (
            <button
              onClick={startCamera}
              className="mt-4 rounded-lg border border-tan px-4 py-2.5 font-medium hover:bg-ivory"
            >
              Enable camera &amp; mic
            </button>
          ) : (
            <>
              <label className="mt-4 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={aiOn} onChange={(e) => setAiOn(e.target.checked)} />
                Play other characters with AI voices
              </label>
              <button
                onClick={startSession}
                className="mt-4 rounded-lg bg-brick px-5 py-2.5 font-medium text-white"
              >
                {status || "Start recording"}
              </button>
            </>
          )}
        </div>
      )}

      {mode === "recording" && row && (
        <div className="mt-5">
          <div className="rounded-xl border border-tan bg-[#faf7ef] px-6 py-6">
            {row.sceneHeading && (
              <div className="mb-3 font-mono text-xs font-bold uppercase tracking-wider text-ink">
                {row.sceneHeading}
              </div>
            )}
            {row.kind === "narrator" ? (
              <p className="font-mono text-base leading-relaxed text-taupe">{row.text}</p>
            ) : (
              <div className="text-center">
                {row.character && (
                  <div className="font-mono text-sm font-bold uppercase tracking-wide text-ink">
                    {row.character}
                  </div>
                )}
                <p className="mx-auto mt-1 max-w-md font-mono text-base leading-relaxed text-ink">
                  {row.text}
                </p>
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center gap-3">
            {row.kind === "actor" ? (
              <button
                onClick={finishLine}
                className="inline-flex items-center gap-2 rounded-lg bg-brick px-5 py-2.5 font-medium text-white"
              >
                <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-white" />
                {recording ? "Done — next line" : "Next"}
              </button>
            ) : (
              <button
                onClick={() => goTo(pos + 1)}
                className="rounded-lg border border-tan px-5 py-2.5 font-medium hover:bg-ivory"
              >
                Next ›
              </button>
            )}
            <span className="ml-auto font-mono text-xs text-muted">
              {clipCount} / {actorRows.length} recorded
            </span>
          </div>
        </div>
      )}

      {mode === "review" && (
        <div className="mt-2">
          <h1 className="font-slab text-2xl">Review your read</h1>
          <p className="mt-1 text-taupe">
            {clipCount} of {actorRows.length} lines recorded.
          </p>
          <div className="mt-4 divide-y divide-tan">
            {actorRows.map((r) => {
              const clip = clipsRef.current.get(r.elementIndex);
              return (
                <div key={r.elementIndex} className="flex items-center gap-3 py-3">
                  <span className={clip ? "text-forest" : "text-muted"}>{clip ? "✓" : "○"}</span>
                  <p className="min-w-0 flex-1 truncate font-mono text-sm">{r.text}</p>
                </div>
              );
            })}
          </div>
          <div className="mt-6 flex gap-3">
            <button
              onClick={startSession}
              className="rounded-lg border border-tan px-4 py-2.5 font-medium hover:bg-ivory"
            >
              Record again
            </button>
            <button
              onClick={submit}
              disabled={clipCount === 0}
              className="rounded-lg bg-brick px-5 py-2.5 font-medium text-white disabled:opacity-60"
            >
              Submit read
            </button>
          </div>
        </div>
      )}

      {mode === "uploading" && (
        <div className="mt-8 text-center">
          <p className="font-slab text-xl">{status || "Uploading…"}</p>
          <div className="mx-auto mt-4 h-2 w-64 overflow-hidden rounded-full bg-tan/40">
            <div className="h-full bg-brick transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        </div>
      )}

      {mode === "done" && (
        <div className="mt-8 text-center">
          <p className="font-slab text-2xl">Your read is in 🎬</p>
          <p className="mt-2 text-taupe">
            It&rsquo;ll show up for {characterName} as soon as it clears our automated
            review (usually instant).
          </p>
          <Link
            href={`/script/${scriptId}`}
            className="mt-5 inline-block rounded-lg bg-brick px-5 py-2.5 font-medium text-white"
          >
            Back to the script
          </Link>
        </div>
      )}
    </main>
  );
}
