"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import type { VoiceCatalogItem, VoiceConfig, VoiceSettings } from "@/lib/shared";
import { DEFAULT_VOICE_SETTINGS } from "@/lib/shared";
import { getBrowserClient } from "@/lib/supabase/client";

// The four ElevenLabs generation controls, exposed as sliders. Applied to every
// AI voice in the read (actor clips are real recordings, so they're unaffected).
const SETTING_SLIDERS: {
  key: keyof VoiceSettings;
  label: string;
  min: number;
  max: number;
  step: number;
  lo: string;
  hi: string;
}[] = [
  { key: "speed", label: "Speed", min: 0.7, max: 1.2, step: 0.05, lo: "Slower", hi: "Faster" },
  { key: "stability", label: "Stability", min: 0, max: 1, step: 0.05, lo: "Variable", hi: "Stable" },
  { key: "similarity_boost", label: "Similarity", min: 0, max: 1, step: 0.05, lo: "Low", hi: "High" },
  { key: "style", label: "Style", min: 0, max: 1, step: 0.05, lo: "None", hi: "Exaggerated" },
];

const NARRATOR = "__narrator__";
const FILTER_KEYS: { key: string; label: string }[] = [
  { key: "gender", label: "Gender" },
  { key: "accent", label: "Accent" },
  { key: "language", label: "Language" },
  { key: "age", label: "Age" },
];
const META_KEYS = ["gender", "accent", "language", "age", "descriptive", "use_case"];
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian",
  pt: "Portuguese", pl: "Polish", hi: "Hindi", ja: "Japanese", ko: "Korean",
  zh: "Chinese", nl: "Dutch", tr: "Turkish", sv: "Swedish", id: "Indonesian",
  fil: "Filipino", uk: "Ukrainian", el: "Greek", cs: "Czech", fi: "Finnish",
  ro: "Romanian", ru: "Russian", da: "Danish", bg: "Bulgarian", ms: "Malay",
  sk: "Slovak", hr: "Croatian", ar: "Arabic", ta: "Tamil", vi: "Vietnamese",
  no: "Norwegian", hu: "Hungarian",
};
// Language labels are 2-letter codes — show the full word. Others render as-is
// (the UI capitalizes them via CSS).
const displayValue = (key: string, val: string) =>
  key === "language" ? LANGUAGE_NAMES[val.toLowerCase()] ?? val.toUpperCase() : val;
const norm = (s: string) => s.trim().toLowerCase();

type RoleSub = { id: string; actor: string; take: number; avatar: string | null; clips: string[] };

/**
 * Per role, choose an AI voice OR an actor's recorded read. Default is AI;
 * actor clips only play for roles explicitly cast here. Narrator is AI-only.
 */
export function VoicePicker({
  characters,
  startConfig,
  submissionsByRole = {},
  startCast = {},
  onApply,
  onClose,
  changesLeft,
}: {
  characters: string[];
  startConfig: VoiceConfig;
  submissionsByRole?: Record<string, RoleSub[]>;
  startCast?: Record<string, string>;
  onApply: (cfg: VoiceConfig, cast: Record<string, string>) => void;
  onClose: () => void;
  changesLeft?: number;
}) {
  const [catalog, setCatalog] = useState<VoiceCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<VoiceConfig>(() => ({
    mode: "per_character",
    single_voice_id: null,
    narrator_voice_id: startConfig.narrator_voice_id ?? null,
    characters: { ...(startConfig.characters ?? {}) },
  }));
  const [cast, setCast] = useState<Record<string, string>>({ ...startCast });
  const [settings, setSettings] = useState<VoiceSettings>(() => ({
    ...DEFAULT_VOICE_SETTINGS,
    ...(startConfig.settings ?? {}),
  }));
  const [showSettings, setShowSettings] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [mode, setMode] = useState<"ai" | "actors">("ai");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [previewing, setPreviewing] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Actor read preview (plays the actor's clips in sequence).
  const [previewSub, setPreviewSub] = useState<string | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewClipsRef = useRef<string[]>([]);
  const previewIdxRef = useRef(0);

  const previewRead = (sub: RoleSub) => {
    const video = previewVideoRef.current;
    if (!video || !sub.clips.length) return;
    if (previewSub === sub.id) {
      video.pause();
      setPreviewSub(null);
      return;
    }
    audioRef.current?.pause();
    setPreviewing(null);
    previewClipsRef.current = sub.clips;
    previewIdxRef.current = 0;
    setPreviewSub(sub.id);
    video.src = sub.clips[0];
    video.play().catch(() => {});
  };

  const onPreviewEnded = () => {
    const video = previewVideoRef.current;
    const clips = previewClipsRef.current;
    const next = previewIdxRef.current + 1;
    if (video && next < clips.length) {
      previewIdxRef.current = next;
      video.src = clips[next];
      video.play().catch(() => {});
    } else {
      setPreviewSub(null);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await getBrowserClient().functions.invoke("list-voices", { body: {} });
      if (!alive) return;
      // Dedupe by voice_id: the same voice can appear as both an account voice
      // and a library voice under slightly different names, and duplicate keys
      // corrupt the filtered/searched list render. Keep the first (account wins).
      const raw = (data?.voices as VoiceCatalogItem[]) ?? [];
      const seenIds = new Set<string>();
      const deduped = raw.filter((v) => {
        if (seenIds.has(v.voice_id)) return false;
        seenIds.add(v.voice_id);
        return true;
      });
      setCatalog(deduped);
      setLoading(false);
    })();
    return () => {
      alive = false;
      audioRef.current?.pause();
    };
  }, []);

  const roles = useMemo(() => [NARRATOR, ...characters.map((c) => c.toUpperCase())], [characters]);
  const roleLabel = (r: string) => (r === NARRATOR ? "Narrator" : r);
  const nameOf = (vid?: string | null) =>
    catalog.find((v) => v.voice_id === vid)?.name ?? (vid ? "Custom voice" : "Default");
  const currentVoiceFor = (role: string) =>
    role === NARRATOR ? config.narrator_voice_id : config.characters?.[role];
  const actorsFor = (role: string) => submissionsByRole[role] ?? [];

  const choiceLabel = (role: string) => {
    if (cast[role]) {
      const sub = actorsFor(role).find((s) => s.id === cast[role]);
      return `🎥 ${sub?.actor ?? "Actor"}`;
    }
    return nameOf(currentVoiceFor(role));
  };

  const openRole = (role: string) => {
    setEditing(role);
    setSearch("");
    setFilters({});
    // Default to Actors whenever any have recorded a read for this role.
    setMode(actorsFor(role).length ? "actors" : "ai");
  };

  const closeRole = () => {
    setEditing(null);
    setSearch("");
    setFilters({});
    audioRef.current?.pause();
    setPreviewing(null);
    previewVideoRef.current?.pause();
    setPreviewSub(null);
  };

  const setRoleVoice = (role: string, vid: string) => {
    setConfig((c) =>
      role === NARRATOR
        ? { ...c, narrator_voice_id: vid }
        : { ...c, characters: { ...(c.characters ?? {}), [role]: vid } }
    );
    // Choosing an AI voice clears any actor cast for this role.
    setCast((c) => {
      if (!c[role]) return c;
      const n = { ...c };
      delete n[role];
      return n;
    });
    closeRole();
  };

  const setRoleActor = (role: string, subId: string) => {
    setCast((c) => ({ ...c, [role]: subId }));
    closeRole();
  };

  const preview = (v: VoiceCatalogItem) => {
    const audio = audioRef.current;
    if (!v.preview_url || !audio) return;
    if (previewing === v.voice_id) {
      audio.pause();
      setPreviewing(null);
      return;
    }
    audio.src = v.preview_url;
    audio.play().catch(() => {});
    setPreviewing(v.voice_id);
  };

  const filterOptions = useMemo(() => {
    const opts: Record<string, string[]> = {};
    for (const { key } of FILTER_KEYS) {
      const set = new Set<string>();
      for (const v of catalog) {
        const val = v.labels?.[key];
        if (val) set.add(String(val));
      }
      opts[key] = [...set].sort((a, b) => displayValue(key, a).localeCompare(displayValue(key, b)));
    }
    return opts;
  }, [catalog]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalog.filter((v) => {
      for (const { key } of FILTER_KEYS) {
        const want = filters[key];
        if (want && norm(String(v.labels?.[key] ?? "")) !== norm(want)) return false;
      }
      if (!q) return true;
      return (
        v.name.toLowerCase().includes(q) ||
        Object.values(v.labels || {}).some((l) => String(l).toLowerCase().includes(q))
      );
    });
  }, [catalog, search, filters]);

  const outOfChanges = typeof changesLeft === "number" && changesLeft <= 0;
  const editingActors = editing && editing !== NARRATOR ? actorsFor(editing) : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-tan bg-ivory"
        onClick={(e) => e.stopPropagation()}
      >
        <audio ref={audioRef} onEnded={() => setPreviewing(null)} />
        <div className="flex items-center justify-between border-b border-tan px-5 py-4">
          <h3 className="font-slab text-lg">
            {editing ? roleLabel(editing) : "Cast the read"}
          </h3>
          <button
            onClick={editing ? closeRole : onClose}
            className="text-sm text-taupe hover:text-ink"
          >
            {editing ? "‹ Back" : "Close"}
          </button>
        </div>

        {!editing ? (
          <>
            <div className="flex-1 overflow-y-auto px-5 py-1">
              {roles.map((r) => (
                <button
                  key={r}
                  onClick={() => openRole(r)}
                  className="flex w-full items-center justify-between border-b border-tan/60 py-3 text-left last:border-0"
                >
                  <span className="font-medium">{roleLabel(r)}</span>
                  <span className="text-sm text-taupe">
                    {loading ? "…" : choiceLabel(r)} ›
                  </span>
                </button>
              ))}

              {/* Global AI voice settings (ElevenLabs generation controls). */}
              <div className="mt-1 py-3">
                <button
                  onClick={() => setShowSettings((s) => !s)}
                  className="flex w-full items-center justify-between text-left"
                >
                  <span className="font-medium">Voice settings</span>
                  <span className="text-sm text-taupe">{showSettings ? "Hide ▲" : "Adjust ▼"}</span>
                </button>
                {showSettings && (
                  <div className="mt-3 space-y-4">
                    <p className="text-xs text-muted">Applied to all AI voices in the read.</p>
                    {SETTING_SLIDERS.map((s) => (
                      <label key={s.key} className="block">
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-medium">{s.label}</span>
                          <span className="font-mono text-xs text-taupe">
                            {settings[s.key].toFixed(2)}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={s.min}
                          max={s.max}
                          step={s.step}
                          value={settings[s.key]}
                          onChange={(e) =>
                            setSettings((prev) => ({ ...prev, [s.key]: Number(e.target.value) }))
                          }
                          className="mt-1 w-full accent-brick"
                        />
                        <div className="flex justify-between text-[10px] uppercase tracking-wide text-muted">
                          <span>{s.lo}</span>
                          <span>{s.hi}</span>
                        </div>
                      </label>
                    ))}
                    <button
                      onClick={() => setSettings({ ...DEFAULT_VOICE_SETTINGS })}
                      className="text-xs text-taupe underline hover:text-ink"
                    >
                      Reset to default
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="border-t border-tan p-4">
              <button
                onClick={() => onApply({ ...config, settings }, cast)}
                disabled={outOfChanges}
                className="w-full rounded-lg bg-brick px-4 py-3 font-medium text-white disabled:opacity-50"
              >
                Apply &amp; play
              </button>
              {typeof changesLeft === "number" && (
                <p className="mt-2 text-center text-xs text-muted">
                  {outOfChanges
                    ? "You've reached today's voice-change limit."
                    : `${changesLeft} AI voice ${changesLeft === 1 ? "change" : "changes"} left today`}
                </p>
              )}
            </div>
          </>
        ) : (
          <>
            {/* AI / Actors toggle — only when the role has recorded reads. */}
            {editingActors.length > 0 && (
              <div className="flex gap-2 px-5 pt-3">
                <button
                  onClick={() => setMode("ai")}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
                    mode === "ai" ? "border-brick bg-brick text-white" : "border-tan text-taupe"
                  }`}
                >
                  AI Voices
                </button>
                <button
                  onClick={() => setMode("actors")}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
                    mode === "actors" ? "border-brick bg-brick text-white" : "border-tan text-taupe"
                  }`}
                >
                  Actors ({editingActors.length})
                </button>
              </div>
            )}

            {mode === "actors" && editingActors.length > 0 ? (
              <div className="flex-1 overflow-y-auto px-5 py-3">
                <video
                  ref={previewVideoRef}
                  playsInline
                  onEnded={onPreviewEnded}
                  className={`mb-3 w-full rounded-lg bg-black ${previewSub ? "block" : "hidden"}`}
                  style={{ maxHeight: "40vh" }}
                />
                {editingActors.map((sub) => (
                  <div
                    key={sub.id}
                    className="flex items-center gap-3 border-b border-tan/60 py-2 last:border-0"
                  >
                    <span className="h-12 w-12 shrink-0 overflow-hidden rounded-full border border-tan bg-elevated">
                      {sub.avatar ? (
                        <Image
                          src={sub.avatar}
                          alt={sub.actor}
                          width={48}
                          height={48}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center text-sm text-taupe">
                          {sub.actor.charAt(0).toUpperCase()}
                        </span>
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{sub.actor}</div>
                      <div className="text-xs text-muted">Take #{sub.take}</div>
                    </div>
                    <button
                      onClick={() => previewRead(sub)}
                      disabled={!sub.clips.length}
                      className="shrink-0 rounded-lg border border-tan px-2.5 py-1.5 text-xs font-medium text-taupe hover:bg-elevated disabled:opacity-40"
                    >
                      {previewSub === sub.id ? "❚❚ Stop" : "▶ Preview"}
                    </button>
                    <button
                      onClick={() => setRoleActor(editing!, sub.id)}
                      className="shrink-0 rounded-lg bg-brick px-3 py-1.5 text-xs font-medium text-white"
                    >
                      {cast[editing!] === sub.id ? "Cast ✓" : "Use"}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <>
                <div className="space-y-2 px-5 py-3">
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by name, accent, gender…"
                    className="w-full rounded-lg border border-tan bg-elevated px-4 py-2 outline-none focus:border-brick"
                  />
                  <div className="flex flex-wrap gap-2">
                    {FILTER_KEYS.map(({ key, label }) =>
                      (filterOptions[key]?.length ?? 0) > 1 ? (
                        <select
                          key={key}
                          value={filters[key] ?? ""}
                          onChange={(e) => setFilters((f) => ({ ...f, [key]: e.target.value }))}
                          className="rounded-lg border border-tan bg-elevated px-2 py-1.5 text-sm capitalize outline-none focus:border-brick"
                        >
                          <option value="">{label}</option>
                          {filterOptions[key].map((o) => (
                            <option key={o} value={o}>
                              {displayValue(key, o)}
                            </option>
                          ))}
                        </select>
                      ) : null
                    )}
                    {Object.values(filters).some(Boolean) && (
                      <button
                        onClick={() => setFilters({})}
                        className="rounded-lg px-2 py-1.5 text-sm text-taupe hover:text-ink"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto px-5 pb-4">
                  {loading ? (
                    <p className="py-6 text-center text-taupe">Loading voices…</p>
                  ) : (
                    <>
                      <p className="pb-2 text-xs text-muted">{filtered.length} voices</p>
                      {filtered.map((v) => (
                        <div
                          key={v.voice_id}
                          className="flex items-center gap-3 border-b border-tan/60 py-2 last:border-0"
                        >
                          <button
                            onClick={() => preview(v)}
                            disabled={!v.preview_url}
                            aria-label="Preview voice"
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-tan text-brick disabled:opacity-40"
                          >
                            {previewing === v.voice_id ? "❚❚" : "▶"}
                          </button>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{v.name}</div>
                            <div className="truncate text-xs capitalize text-muted">
                              {Object.entries(v.labels || {})
                                .filter(([k]) => META_KEYS.includes(k))
                                .map(([k, val]) => displayValue(k, val))
                                .join(" · ")}
                            </div>
                          </div>
                          <button
                            onClick={() => setRoleVoice(editing!, v.voice_id)}
                            className="shrink-0 rounded-lg border border-tan px-3 py-1.5 text-xs font-medium hover:bg-elevated"
                          >
                            {!cast[editing!] && currentVoiceFor(editing!) === v.voice_id ? "Selected" : "Use"}
                          </button>
                        </div>
                      ))}
                      {filtered.length === 0 && (
                        <p className="py-6 text-center text-sm text-muted">
                          No voices match these filters.
                        </p>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
