"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { VoiceCatalogItem, VoiceConfig } from "@/lib/shared";
import { getBrowserClient } from "@/lib/supabase/client";

const NARRATOR = "__narrator__";
// Label keys offered as dropdown filters (in catalog order of usefulness).
const FILTER_KEYS: { key: string; label: string }[] = [
  { key: "gender", label: "Gender" },
  { key: "accent", label: "Accent" },
  { key: "language", label: "Language" },
  { key: "age", label: "Age" },
];
// Label keys shown as the meta line under each voice.
const META_KEYS = ["gender", "accent", "language", "age", "descriptive", "use_case"];

/**
 * Re-cast the AI voices for playback: pick a voice per character + narrator from
 * the full ElevenLabs catalog (account voices + shared library, all usable
 * directly in TTS), filter by gender/accent/language/age, preview, then Apply.
 * `changesLeft` caps how many times a visitor can regenerate (cost guard).
 */
export function VoicePicker({
  characters,
  startConfig,
  onApply,
  onClose,
  changesLeft,
}: {
  characters: string[];
  startConfig: VoiceConfig;
  onApply: (cfg: VoiceConfig) => void;
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
  const [editing, setEditing] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [previewing, setPreviewing] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await getBrowserClient().functions.invoke("list-voices", { body: {} });
      if (!alive) return;
      // Whole catalog — account voices AND the shared library.
      setCatalog((data?.voices as VoiceCatalogItem[]) ?? []);
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

  const openRole = (role: string) => {
    setEditing(role);
    setSearch("");
    setFilters({});
  };

  const setRoleVoice = (role: string, vid: string) => {
    setConfig((c) =>
      role === NARRATOR
        ? { ...c, narrator_voice_id: vid }
        : { ...c, characters: { ...(c.characters ?? {}), [role]: vid } }
    );
    setEditing(null);
    setSearch("");
    setFilters({});
    audioRef.current?.pause();
    setPreviewing(null);
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

  // Distinct values per filter key, for the dropdowns.
  const filterOptions = useMemo(() => {
    const opts: Record<string, string[]> = {};
    for (const { key } of FILTER_KEYS) {
      const set = new Set<string>();
      for (const v of catalog) {
        const val = v.labels?.[key];
        if (val) set.add(String(val));
      }
      opts[key] = [...set].sort();
    }
    return opts;
  }, [catalog]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalog.filter((v) => {
      for (const { key } of FILTER_KEYS) {
        if (filters[key] && String(v.labels?.[key] ?? "") !== filters[key]) return false;
      }
      if (!q) return true;
      return (
        v.name.toLowerCase().includes(q) ||
        Object.values(v.labels || {}).some((l) => String(l).toLowerCase().includes(q))
      );
    });
  }, [catalog, search, filters]);

  const outOfChanges = typeof changesLeft === "number" && changesLeft <= 0;

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
            {editing ? `Voice for ${roleLabel(editing)}` : "Choose voices"}
          </h3>
          <button
            onClick={editing ? () => setEditing(null) : onClose}
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
                    {loading ? "…" : nameOf(currentVoiceFor(r))} ›
                  </span>
                </button>
              ))}
            </div>
            <div className="border-t border-tan p-4">
              <button
                onClick={() => onApply(config)}
                disabled={outOfChanges}
                className="w-full rounded-lg bg-brick px-4 py-3 font-medium text-white disabled:opacity-50"
              >
                Apply &amp; play
              </button>
              {typeof changesLeft === "number" && (
                <p className="mt-2 text-center text-xs text-muted">
                  {outOfChanges
                    ? "You've reached today's voice-change limit."
                    : `${changesLeft} voice ${changesLeft === 1 ? "change" : "changes"} left today`}
                </p>
              )}
            </div>
          </>
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
                      onChange={(e) =>
                        setFilters((f) => ({ ...f, [key]: e.target.value }))
                      }
                      className="rounded-lg border border-tan bg-elevated px-2 py-1.5 text-sm capitalize outline-none focus:border-brick"
                    >
                      <option value="">{label}</option>
                      {filterOptions[key].map((o) => (
                        <option key={o} value={o}>
                          {o}
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
                            .map(([, val]) => val)
                            .join(" · ")}
                        </div>
                      </div>
                      <button
                        onClick={() => setRoleVoice(editing, v.voice_id)}
                        className="shrink-0 rounded-lg border border-tan px-3 py-1.5 text-xs font-medium hover:bg-elevated"
                      >
                        {currentVoiceFor(editing) === v.voice_id ? "Selected" : "Use"}
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
      </div>
    </div>
  );
}
