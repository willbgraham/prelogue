"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { VoiceCatalogItem, VoiceConfig } from "@prelogue/shared";
import { getBrowserClient } from "@/lib/supabase/client";

const NARRATOR = "__narrator__";
const LABELS = ["gender", "accent", "age", "descriptive", "use_case"];

/**
 * Lets anyone re-cast the AI voices for playback: pick a voice per character +
 * narrator from the ElevenLabs catalog (list-voices), preview each, then Apply.
 * Defaults to account-ready voices (no public_owner_id) to avoid the add-voice
 * slot limit on anonymous picks.
 */
export function VoicePicker({
  characters,
  startConfig,
  onApply,
  onClose,
}: {
  characters: string[];
  startConfig: VoiceConfig;
  onApply: (cfg: VoiceConfig) => void;
  onClose: () => void;
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
  const [previewing, setPreviewing] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await getBrowserClient().functions.invoke("list-voices", { body: {} });
      if (!alive) return;
      const voices = ((data?.voices as VoiceCatalogItem[]) ?? []).filter((v) => !v.public_owner_id);
      setCatalog(voices);
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

  const setRoleVoice = (role: string, vid: string) => {
    setConfig((c) =>
      role === NARRATOR
        ? { ...c, narrator_voice_id: vid }
        : { ...c, characters: { ...(c.characters ?? {}), [role]: vid } }
    );
    setEditing(null);
    setSearch("");
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter(
      (v) =>
        v.name.toLowerCase().includes(q) ||
        Object.values(v.labels || {}).some((l) => String(l).toLowerCase().includes(q))
    );
  }, [catalog, search]);

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
                  onClick={() => setEditing(r)}
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
                className="w-full rounded-lg bg-brick px-4 py-3 font-medium text-white"
              >
                Apply &amp; play
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="px-5 py-3">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, accent, gender…"
                className="w-full rounded-lg border border-tan bg-elevated px-4 py-2 outline-none focus:border-brick"
              />
            </div>
            <div className="flex-1 overflow-y-auto px-5 pb-4">
              {loading ? (
                <p className="py-6 text-center text-taupe">Loading voices…</p>
              ) : (
                filtered.map((v) => (
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
                      <div className="truncate text-xs text-muted">
                        {Object.entries(v.labels || {})
                          .filter(([k]) => LABELS.includes(k))
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
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
