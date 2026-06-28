"use client";

import { useRef, useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";

const NARRATOR = "__narrator__";
type Preview = { generated_voice_id: string; audio_base_64: string; media_type: string };

/**
 * ElevenLabs Voice Design — a writer describes a voice for a character in plain
 * language, hears a few AI-generated takes, and saves the one they like. The new
 * voice is assigned to that role's AI casting.
 */
export function VoiceDesigner({
  characters,
  onAssign,
  onClose,
}: {
  characters: string[];
  onAssign: (target: string, voiceId: string, voiceName: string) => void;
  onClose: () => void;
}) {
  const supabase = getBrowserClient();
  const [target, setTarget] = useState<string>(
    characters[0] ? characters[0].toUpperCase() : NARRATOR
  );
  const [desc, setDesc] = useState("");
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const targetLabel = target === NARRATOR ? "Narrator" : target;

  async function generate() {
    if (desc.trim().length < 20) {
      setError("Describe the voice in a bit more detail (at least 20 characters).");
      return;
    }
    setError(null);
    setLoading(true);
    setPreviews([]);
    setSelected(null);
    const { data, error: err } = await supabase.functions.invoke("design-voice", {
      body: { action: "preview", description: desc.trim() },
    });
    setLoading(false);
    if (err || data?.error) {
      setError(data?.error ?? "Couldn't generate previews. Try again.");
      return;
    }
    setPreviews((data?.previews as Preview[]) ?? []);
    if (!name) setName(`${targetLabel} voice`);
  }

  function play(p: Preview) {
    const audio = audioRef.current;
    if (!audio) return;
    if (playingId === p.generated_voice_id) {
      audio.pause();
      setPlayingId(null);
      return;
    }
    audio.src = `data:${p.media_type};base64,${p.audio_base_64}`;
    audio.play().catch(() => {});
    setPlayingId(p.generated_voice_id);
  }

  async function save() {
    if (!selected) {
      setError("Pick one of the previews first.");
      return;
    }
    if (!name.trim()) {
      setError("Give the voice a name.");
      return;
    }
    setError(null);
    setSaving(true);
    const { data, error: err } = await supabase.functions.invoke("design-voice", {
      body: { action: "create", name: name.trim(), description: desc.trim(), generated_voice_id: selected },
    });
    setSaving(false);
    if (err || data?.error || !data?.voice_id) {
      setError(data?.error ?? "Couldn't save the voice. Try again.");
      return;
    }
    audioRef.current?.pause();
    onAssign(target, data.voice_id, data.name ?? name.trim());
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-tan bg-ivory"
        onClick={(e) => e.stopPropagation()}
      >
        <audio ref={audioRef} onEnded={() => setPlayingId(null)} />
        <div className="flex items-center justify-between border-b border-tan px-5 py-4">
          <h3 className="font-slab text-lg">✨ Design a voice</h3>
          <button onClick={onClose} className="text-sm text-taupe hover:text-ink">
            Close
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {error && <p className="rounded-lg bg-brick/10 px-3 py-2 text-sm text-brick">{error}</p>}

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">For</span>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="rounded-lg border border-tan bg-elevated px-3 py-2 outline-none focus:border-brick"
            >
              <option value={NARRATOR}>Narrator</option>
              {characters.map((c) => (
                <option key={c} value={c.toUpperCase()}>
                  {c}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Describe the voice</span>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={3}
              placeholder="e.g. A gravelly, world-weary detective in his 60s — slow, deliberate, a faint New York accent."
              className="rounded-lg border border-tan bg-elevated px-3 py-2 outline-none focus:border-brick"
            />
            <span className="text-xs text-muted">{desc.trim().length}/20+ characters</span>
          </label>

          <button
            onClick={generate}
            disabled={loading}
            className="w-full rounded-lg border border-brick px-4 py-2.5 text-sm font-medium text-brick hover:bg-brick/5 disabled:opacity-50"
          >
            {loading ? "Generating…" : previews.length ? "Regenerate" : "Generate previews"}
          </button>

          {previews.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Pick a take</p>
              {previews.map((p, i) => {
                const on = selected === p.generated_voice_id;
                return (
                  <div
                    key={p.generated_voice_id}
                    className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
                      on ? "border-brick bg-brick/5" : "border-tan"
                    }`}
                  >
                    <button
                      onClick={() => play(p)}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-tan text-brick"
                      aria-label="Play preview"
                    >
                      {playingId === p.generated_voice_id ? "❚❚" : "▶"}
                    </button>
                    <span className="flex-1 text-sm">Take {i + 1}</span>
                    <button
                      onClick={() => setSelected(p.generated_voice_id)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                        on ? "bg-brick text-white" : "border border-tan text-taupe hover:bg-elevated"
                      }`}
                    >
                      {on ? "Selected" : "Select"}
                    </button>
                  </div>
                );
              })}

              <label className="flex flex-col gap-1 pt-1">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">Voice name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Gruff Detective"
                  className="rounded-lg border border-tan bg-elevated px-3 py-2 outline-none focus:border-brick"
                />
              </label>
            </div>
          )}
        </div>

        <div className="border-t border-tan p-4">
          <button
            onClick={save}
            disabled={saving || !selected}
            className="w-full rounded-lg bg-brick px-4 py-3 font-medium text-white disabled:opacity-50"
          >
            {saving ? "Saving…" : `Save & use for ${targetLabel}`}
          </button>
        </div>
      </div>
    </div>
  );
}
