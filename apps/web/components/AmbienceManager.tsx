"use client";

import { useRef, useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";
import { DEFAULT_AMBIENCE_VOLUME } from "@/lib/shared";
import type { AmbienceConfig, AmbienceScene, ParsedScript } from "@/lib/shared";

// Generation prices (ElevenLabs credits) — shown next to Generate so the
// writer always knows what a click costs. Music ≈ 900/min, SFX = 40/sec.
const MUSIC_CREDITS_PER_MIN = 900;
const SFX_CREDITS_PER_SEC = 40;
const MUSIC_LENGTHS = [60_000, 90_000, 120_000];
const SFX_LENGTHS = [15_000, 20_000, 30_000];

type Draft = { kind: "music" | "sfx"; prompt: string; lengthMs: number };

const creditsFor = (kind: "music" | "sfx", ms: number) =>
  kind === "music"
    ? Math.round((MUSIC_CREDITS_PER_MIN * ms) / 60_000)
    : Math.round((SFX_CREDITS_PER_SEC * ms) / 1000);

// Prefill an editable prompt from the scene's own text.
function templatePrompt(
  kind: "music" | "sfx",
  heading: string | undefined,
  firstAction: string | undefined,
  genre: string | undefined
): string {
  const h = (heading ?? "").trim();
  const place = h
    .replace(/^(INT\.\/EXT\.|INT\.|EXT\.)\s*/i, "")
    .replace(/\s*[-–—].*$/, "")
    .toLowerCase();
  const time = h.match(/[-–—]\s*(.+)$/)?.[1]?.toLowerCase() ?? "";
  const setting = [place || "the scene", time].filter(Boolean).join(", ");
  const action = (firstAction ?? "").trim();
  const text =
    kind === "music"
      ? `Low-volume instrumental background score for a ${(genre || "drama").toLowerCase()} scene: ${setting}. ${action} Sparse, moody, cinematic underscore, no vocals.`
      : `Ambient sound bed, seamless loop, no music: ${setting}. ${action}`;
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

/**
 * Writer-only manager for per-scene background beds. Generation is billed to
 * the account's ElevenLabs credits (estimate shown per click) and cached
 * content-addressed, so regenerating an unchanged prompt is free. Playback of
 * whatever's saved here is what every viewer hears under the table read.
 */
export function AmbienceManager({
  scriptId,
  parsed,
  genre,
  initial,
}: {
  scriptId: string;
  parsed: ParsedScript | null;
  genre?: string | null;
  initial: AmbienceConfig | null;
}) {
  const supabase = getBrowserClient();
  const scenes = (parsed?.scenes ?? []).map((s, i) => ({
    index: i,
    heading: s.heading?.trim() || `Scene ${i + 1}`,
    firstAction: (s.elements ?? []).find((e) => e.type === "action")?.text ?? "",
  }));

  const [cfg, setCfg] = useState<AmbienceConfig>(() => ({
    enabled: initial?.enabled ?? true,
    volume: initial?.volume ?? DEFAULT_AMBIENCE_VOLUME,
    scenes: { ...(initial?.scenes ?? {}) },
  }));
  const [drafts, setDrafts] = useState<Record<number, Draft>>(() => {
    const d: Record<number, Draft> = {};
    for (const s of scenes) {
      const saved = initial?.scenes?.[String(s.index)];
      d[s.index] = saved
        ? { kind: saved.kind, prompt: saved.prompt, lengthMs: saved.length_ms }
        : { kind: "music", prompt: templatePrompt("music", s.heading, s.firstAction, genre ?? undefined), lengthMs: 60_000 };
    }
    return d;
  });
  const [busyScene, setBusyScene] = useState<number | null>(null);
  const [errorByScene, setErrorByScene] = useState<Record<number, string>>({});
  const [previewingScene, setPreviewingScene] = useState<number | null>(null);
  const previewRef = useRef<HTMLAudioElement | null>(null);

  if (!scenes.length) return null;

  const persist = async (next: AmbienceConfig) => {
    setCfg(next);
    const { error } = await supabase
      .from("scripts")
      .update({ ambience_config: next })
      .eq("id", scriptId);
    if (error) alert(`Couldn't save music settings: ${error.message}`);
  };

  const setDraft = (idx: number, patch: Partial<Draft>) =>
    setDrafts((d) => {
      const cur = d[idx];
      const next = { ...cur, ...patch };
      // Kind switch: re-template the prompt only if the writer hasn't edited it
      // away from the other kind's template, and snap the length to a valid one.
      if (patch.kind && patch.kind !== cur.kind) {
        const scene = scenes.find((s) => s.index === idx)!;
        const untouched =
          cur.prompt === templatePrompt(cur.kind, scene.heading, scene.firstAction, genre ?? undefined);
        if (untouched) {
          next.prompt = templatePrompt(patch.kind, scene.heading, scene.firstAction, genre ?? undefined);
        }
        next.lengthMs = patch.kind === "music" ? 60_000 : 20_000;
      }
      return { ...d, [idx]: next };
    });

  const generate = async (idx: number) => {
    const draft = drafts[idx];
    if (!draft?.prompt.trim() || busyScene !== null) return;
    setBusyScene(idx);
    setErrorByScene((e) => ({ ...e, [idx]: "" }));
    try {
      const { data, error } = await supabase.functions.invoke("generate-scene-ambience", {
        body: {
          script_id: scriptId,
          kind: draft.kind,
          prompt: draft.prompt.trim(),
          length_ms: draft.lengthMs,
        },
      });
      const path = (data as { path?: string; url?: string; error?: string } | null)?.path;
      if (!path) {
        throw new Error(
          (data as { error?: string } | null)?.error ??
            (error as Error | null)?.message ??
            "Generation failed"
        );
      }
      const sceneEntry: AmbienceScene = {
        kind: draft.kind,
        prompt: draft.prompt.trim(),
        path,
        length_ms: (data as { length_ms?: number }).length_ms ?? draft.lengthMs,
      };
      await persist({ ...cfg, scenes: { ...cfg.scenes, [String(idx)]: sceneEntry } });
      // Auto-preview the fresh take so the writer hears what they just bought.
      const url = (data as { url?: string }).url;
      if (url && previewRef.current) {
        previewRef.current.src = url;
        previewRef.current.volume = 0.5;
        previewRef.current.play().catch(() => {});
        setPreviewingScene(idx);
      }
    } catch (e) {
      setErrorByScene((er) => ({
        ...er,
        [idx]: e instanceof Error ? e.message : "Generation failed",
      }));
    } finally {
      setBusyScene(null);
    }
  };

  const preview = async (idx: number) => {
    const audio = previewRef.current;
    if (!audio) return;
    if (previewingScene === idx) {
      audio.pause();
      setPreviewingScene(null);
      return;
    }
    const saved = cfg.scenes[String(idx)];
    if (!saved?.path) return;
    const { data } = await supabase.storage.from("scripts").createSignedUrl(saved.path, 3600);
    if (!data?.signedUrl) return;
    audio.src = data.signedUrl;
    audio.volume = 0.5;
    audio.play().catch(() => {});
    setPreviewingScene(idx);
  };

  const removeScene = (idx: number) => {
    const next = { ...cfg.scenes };
    delete next[String(idx)];
    persist({ ...cfg, scenes: next });
    if (previewingScene === idx) {
      previewRef.current?.pause();
      setPreviewingScene(null);
    }
  };

  return (
    <section className="mt-8 rounded-xl border border-tan bg-ivory p-5">
      <audio ref={previewRef} onEnded={() => setPreviewingScene(null)} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-slab text-lg">Music &amp; ambience</h2>
        <label className="flex items-center gap-2 text-sm text-taupe">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => persist({ ...cfg, enabled: e.target.checked })}
            className="accent-brick"
          />
          Play under the read
        </label>
      </div>
      <p className="mt-1 text-sm text-taupe">
        Generate a background bed per scene — an instrumental score (Eleven Music) or a looping
        ambience (sound effects). Listeners get a mute button; you set the volume.
      </p>

      <label className="mt-3 block max-w-xs">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">Volume under voices</span>
          <span className="font-mono text-xs text-taupe">{Math.round(cfg.volume * 100)}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={0.4}
          step={0.05}
          value={cfg.volume}
          onChange={(e) => setCfg((c) => ({ ...c, volume: Number(e.target.value) }))}
          onMouseUp={() => persist(cfg)}
          onTouchEnd={() => persist(cfg)}
          className="mt-1 w-full accent-brick"
        />
      </label>

      <div className="mt-4 space-y-4">
        {scenes.map((s) => {
          const draft = drafts[s.index];
          const saved = cfg.scenes[String(s.index)];
          const busy = busyScene === s.index;
          return (
            <div key={s.index} className="rounded-lg border border-tan bg-elevated p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-mono text-xs font-bold uppercase tracking-wide text-ink">
                  {s.heading}
                </div>
                {saved && (
                  <span className="rounded-full border border-forest/40 bg-forest/5 px-2 py-0.5 text-[11px] font-medium text-forest">
                    ✓ {saved.kind === "music" ? "Score" : "Ambience"} · {Math.round(saved.length_ms / 1000)}s
                  </span>
                )}
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <select
                  value={draft.kind}
                  onChange={(e) => setDraft(s.index, { kind: e.target.value as Draft["kind"] })}
                  className="rounded-lg border border-tan bg-ivory px-2 py-1.5 text-sm outline-none focus:border-brick"
                >
                  <option value="music">Music (score)</option>
                  <option value="sfx">Ambience (loop)</option>
                </select>
                <select
                  value={draft.lengthMs}
                  onChange={(e) => setDraft(s.index, { lengthMs: Number(e.target.value) })}
                  className="rounded-lg border border-tan bg-ivory px-2 py-1.5 text-sm outline-none focus:border-brick"
                >
                  {(draft.kind === "music" ? MUSIC_LENGTHS : SFX_LENGTHS).map((ms) => (
                    <option key={ms} value={ms}>
                      {ms / 1000}s
                    </option>
                  ))}
                </select>
              </div>

              <textarea
                value={draft.prompt}
                onChange={(e) => setDraft(s.index, { prompt: e.target.value })}
                rows={3}
                maxLength={500}
                placeholder="Describe the mood — instruments, tempo, setting sounds…"
                className="mt-2 w-full resize-y rounded-lg border border-tan bg-ivory px-3 py-2 text-sm outline-none focus:border-brick"
              />

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => generate(s.index)}
                  disabled={busy || busyScene !== null || !draft.prompt.trim()}
                  className="rounded-lg bg-brick px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  {busy
                    ? "Generating…"
                    : `${saved ? "Regenerate" : "Generate"} · ~${creditsFor(draft.kind, draft.lengthMs)} credits`}
                </button>
                {saved && (
                  <button
                    onClick={() => preview(s.index)}
                    className="rounded-lg border border-tan px-3 py-1.5 text-sm text-taupe hover:bg-ivory"
                  >
                    {previewingScene === s.index ? "❚❚ Stop" : "▶ Preview"}
                  </button>
                )}
                {saved && (
                  <button
                    onClick={() => removeScene(s.index)}
                    className="ml-auto text-xs text-taupe underline hover:text-ink"
                  >
                    Remove
                  </button>
                )}
              </div>
              {errorByScene[s.index] && (
                <p className="mt-2 text-xs text-brick">{errorByScene[s.index]}</p>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-muted">
        Same prompt + length re-uses the cached track for free. New prompts spend credits (music
        ≈900/min, ambience 40/sec).
      </p>
    </section>
  );
}
