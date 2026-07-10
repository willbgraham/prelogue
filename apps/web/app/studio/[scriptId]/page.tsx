"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { getBrowserClient } from "@/lib/supabase/client";
import { VoicePicker } from "@/components/VoicePicker";
import { VoiceDesigner } from "@/components/VoiceDesigner";
import { ClipReel } from "@/components/ClipReel";
import type { VoiceConfig } from "@/lib/shared";

type Sub = {
  id: string;
  take_number: number;
  is_writers_choice: boolean;
  moderation_status: string;
  clips: { element_index: number; clip_url: string }[] | null;
  video_url: string | null;
  actor: { display_name: string; avatar_url: string | null } | null;
};
type Char = { id: string; name: string; description: string | null; submissions: Sub[] };

export default function CastingPage() {
  const { scriptId } = useParams<{ scriptId: string }>();
  const router = useRouter();
  const supabase = getBrowserClient();
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [characters, setCharacters] = useState<Char[]>([]);
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig | null>(null);
  const [voiceNames, setVoiceNames] = useState<Record<string, string>>({});
  const [showPicker, setShowPicker] = useState(false);
  const [showDesigner, setShowDesigner] = useState(false);
  const [readId, setReadId] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.push(`/sign-in?next=/studio/${scriptId}`);
      return;
    }
    const { data: script } = await supabase
      .from("scripts")
      .select("title, writer_id, voice_config")
      .eq("id", scriptId)
      .single();
    if (!script || script.writer_id !== user.id) {
      router.push("/studio"); // not found or not the owner
      return;
    }
    setTitle(script.title);
    setVoiceConfig((script.voice_config as VoiceConfig) ?? { mode: "per_character" });
    const { data: chars } = await supabase
      .from("characters")
      .select(
        "id, name, description, submissions(id, take_number, is_writers_choice, moderation_status, clips, video_url, actor:users!submissions_actor_id_fkey(display_name, avatar_url))"
      )
      .eq("script_id", scriptId)
      .order("name");
    // Only approved reads are castable here — pending ones go through /admin/moderation
    // first (an admin would otherwise see unmoderated reads mixed into casting).
    setCharacters(
      ((chars as unknown as Char[]) ?? []).map((c) => ({
        ...c,
        submissions: (c.submissions ?? []).filter((s) => s.moderation_status === "approved"),
      }))
    );
    const { data: read } = await supabase
      .from("assembled_reads")
      .select("id")
      .eq("script_id", scriptId)
      .maybeSingle();
    setReadId(read?.id ?? null);
    setLoading(false);
  }, [scriptId, router, supabase]);

  async function publishRead() {
    setPublishing(true);
    const { data } = await supabase
      .from("assembled_reads")
      .upsert({ script_id: scriptId, status: "ready" }, { onConflict: "script_id" })
      .select("id")
      .single();
    if (data?.id) setReadId(data.id);
    setPublishing(false);
  }

  useEffect(() => {
    load();
  }, [load]);

  // Voice id → name, for the summary.
  useEffect(() => {
    (async () => {
      const { data } = await supabase.functions.invoke("list-voices", { body: {} });
      const map: Record<string, string> = {};
      for (const v of (data?.voices ?? []) as { voice_id: string; name: string }[]) {
        map[v.voice_id] = v.name;
      }
      setVoiceNames(map);
    })();
  }, [supabase]);

  async function applyVoices(cfg: VoiceConfig) {
    setShowPicker(false);
    setVoiceConfig(cfg);
    await supabase.from("scripts").update({ voice_config: cfg }).eq("id", scriptId);
  }

  async function assignDesignedVoice(target: string, voiceId: string) {
    const base: VoiceConfig =
      voiceConfig ?? { mode: "per_character", single_voice_id: null, narrator_voice_id: null, characters: {} };
    const cfg: VoiceConfig =
      target === "__narrator__"
        ? { ...base, narrator_voice_id: voiceId }
        : { ...base, characters: { ...(base.characters ?? {}), [target]: voiceId } };
    setVoiceConfig(cfg);
    await supabase.from("scripts").update({ voice_config: cfg }).eq("id", scriptId);
  }

  async function setWritersChoice(submissionId: string, characterId: string) {
    const { error: clearErr } = await supabase
      .from("submissions")
      .update({ is_writers_choice: false })
      .eq("character_id", characterId)
      .eq("is_writers_choice", true);
    const { error: setErr } = await supabase
      .from("submissions")
      .update({ is_writers_choice: true })
      .eq("id", submissionId);
    if (clearErr || setErr) {
      // Surface it instead of silently reverting on the next load.
      alert(`Couldn't save your pick: ${(clearErr || setErr)?.message ?? "unknown error"}`);
    }
    load();
  }

  async function togglePreview(sub: Sub) {
    if (previewFor === sub.id) {
      setPreviewFor(null);
      setPreviewUrls([]);
      return;
    }
    const paths = [...(sub.clips ?? []).map((c) => c.clip_url), ...(sub.video_url ? [sub.video_url] : [])];
    const { data: signed } = await supabase.storage.from("submissions").createSignedUrls(paths, 3600);
    setPreviewUrls((signed ?? []).map((s) => s?.signedUrl).filter(Boolean) as string[]);
    setPreviewFor(sub.id);
  }

  const nameOf = (vid?: string | null) =>
    vid ? voiceNames[vid] ?? "Selected voice" : "Default";

  // Character blurb for actors — shows on the script page under the Cast list
  // and on the "Read for a Role" cards. Saves on blur.
  const [descSavedFor, setDescSavedFor] = useState<string | null>(null);
  async function saveDescription(charId: string, description: string) {
    const clean = description.trim();
    const { error } = await supabase
      .from("characters")
      .update({ description: clean || null })
      .eq("id", charId);
    if (error) {
      alert(`Couldn't save the description: ${error.message}`);
      return;
    }
    setCharacters((cs) => cs.map((c) => (c.id === charId ? { ...c, description: clean || null } : c)));
    setDescSavedFor(charId);
    window.setTimeout(() => setDescSavedFor((cur) => (cur === charId ? null : cur)), 2000);
  }

  if (loading) {
    return <main className="mx-auto max-w-3xl px-6 py-16 text-taupe">Loading…</main>;
  }

  const characterNames = characters.map((c) => c.name);

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <Link href="/studio" className="text-sm text-taupe hover:text-ink">
        ← Studio
      </Link>
      <h1 className="mt-6 font-slab text-3xl">Casting · {title}</h1>

      {/* Script details + lines */}
      <section className="mt-8 rounded-xl border border-tan bg-ivory p-5">
        <h2 className="font-slab text-lg">Script &amp; lines</h2>
        <p className="mt-1 text-sm text-taupe">
          Set the poster, synopsis, and status — or fix anything the parser mis-read (reassign, merge/split, edit text).
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            href={`/studio/${scriptId}/details`}
            className="rounded-lg border border-brick px-4 py-2 text-sm font-medium text-brick hover:bg-brick/5"
          >
            Edit details →
          </Link>
          <Link
            href={`/studio/${scriptId}/lines`}
            className="rounded-lg border border-brick px-4 py-2 text-sm font-medium text-brick hover:bg-brick/5"
          >
            Edit lines →
          </Link>
        </div>
      </section>

      {/* AI voices */}
      <section className="mt-8 rounded-xl border border-tan bg-ivory p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-slab text-lg">AI Voices</h2>
          <div className="flex gap-2">
            <button
              onClick={() => setShowDesigner(true)}
              className="rounded-lg border border-brick px-4 py-2 text-sm font-medium text-brick hover:bg-brick/5"
            >
              ✨ Design a voice
            </button>
            <button
              onClick={() => setShowPicker(true)}
              className="rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white"
            >
              Edit voices
            </button>
          </div>
        </div>
        <p className="mt-1 text-sm text-taupe">
          Pick a voice per character and the narrator — these play in the table read.
        </p>
        <div className="mt-3 space-y-1 text-sm text-muted">
          <div>Narrator — {nameOf(voiceConfig?.narrator_voice_id)}</div>
          {characterNames.map((n) => (
            <div key={n}>
              {n} — {nameOf(voiceConfig?.characters?.[n.toUpperCase()])}
            </div>
          ))}
        </div>
      </section>

      {/* Publish */}
      <section className="mt-8 rounded-xl border border-tan bg-ivory p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-slab text-lg">Publish read</h2>
            <p className="mt-1 text-sm text-taupe">
              Make this table read public — it shows in Discover for audiences to watch and comment on.
            </p>
          </div>
          {readId ? (
            <Link
              href={`/read/${readId}`}
              className="shrink-0 rounded-lg border border-tan px-4 py-2 text-sm font-medium text-taupe hover:bg-elevated"
            >
              View read →
            </Link>
          ) : (
            <button
              onClick={publishRead}
              disabled={publishing}
              className="shrink-0 rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {publishing ? "Publishing…" : "Publish"}
            </button>
          )}
        </div>
      </section>

      {/* Live readings */}
      <section className="mt-8 rounded-xl border border-tan bg-ivory p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-slab text-lg">Live readings</h2>
            <p className="mt-1 text-sm text-taupe">
              Schedule a live Zoom reading — actors sign up, you pick the cast, and it&rsquo;s recorded for the Prelogue YouTube.
            </p>
          </div>
          <Link
            href={`/studio/${scriptId}/live`}
            className="shrink-0 rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white"
          >
            Schedule →
          </Link>
        </div>
      </section>

      {/* Reads / submissions */}
      <section className="mt-8">
        <h2 className="font-slab text-lg">Reads</h2>
        <div className="mt-4 space-y-6">
          {characters.map((c) => (
            <div key={c.id}>
              <div className="flex items-center justify-between">
                <span className="font-medium">{c.name}</span>
                <span className="text-sm text-muted">
                  {descSavedFor === c.id && <span className="mr-2 text-forest">Saved ✓</span>}
                  {c.submissions.length} read{c.submissions.length !== 1 ? "s" : ""}
                </span>
              </div>
              <textarea
                defaultValue={c.description ?? ""}
                placeholder="Describe this character for actors — age, temperament, what they want in the scene…"
                rows={2}
                onBlur={(e) => {
                  if (e.target.value.trim() !== (c.description ?? "")) {
                    saveDescription(c.id, e.target.value);
                  }
                }}
                className="mt-2 w-full resize-y rounded-lg border border-tan bg-elevated px-3 py-2 text-sm outline-none focus:border-brick"
              />
              {c.submissions.length === 0 ? (
                <p className="mt-2 text-sm text-muted">No reads yet.</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {c.submissions.map((sub) => (
                    <div
                      key={sub.id}
                      className={`rounded-lg border ${
                        sub.is_writers_choice ? "border-brick bg-brick/5" : "border-tan"
                      }`}
                    >
                      <div className="flex items-center gap-3 px-3 py-2">
                        <span className="h-8 w-8 shrink-0 overflow-hidden rounded-full border border-tan bg-elevated">
                          {sub.actor?.avatar_url ? (
                            <Image
                              src={sub.actor.avatar_url}
                              alt=""
                              width={32}
                              height={32}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <span className="flex h-full w-full items-center justify-center text-xs text-taupe">
                              {(sub.actor?.display_name ?? "A").charAt(0).toUpperCase()}
                            </span>
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">
                            {sub.actor?.display_name ?? "Actor"}
                          </div>
                          <div className="text-xs text-muted">Take #{sub.take_number}</div>
                        </div>
                        {((sub.clips?.length ?? 0) > 0 || sub.video_url) && (
                          <button
                            onClick={() => togglePreview(sub)}
                            className="shrink-0 rounded-lg border border-tan px-3 py-1 text-xs font-medium text-taupe hover:bg-elevated"
                          >
                            {previewFor === sub.id ? "Hide" : "▶ Preview"}
                          </button>
                        )}
                        {sub.is_writers_choice ? (
                          <span className="shrink-0 rounded-lg bg-brick px-3 py-1 text-xs font-medium text-white">
                            ★ Writer&rsquo;s Choice
                          </span>
                        ) : (
                          <button
                            onClick={() => setWritersChoice(sub.id, c.id)}
                            className="shrink-0 rounded-lg border border-tan px-3 py-1 text-xs font-medium hover:bg-elevated"
                          >
                            Pick
                          </button>
                        )}
                      </div>
                      {previewFor === sub.id && (
                        <div className="border-t border-tan p-3">
                          <ClipReel urls={previewUrls} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {characters.length === 0 && <p className="text-sm text-muted">No characters parsed yet.</p>}
        </div>
      </section>

      {showPicker && voiceConfig && (
        <VoicePicker
          scriptId={scriptId}
          characters={characterNames}
          startConfig={voiceConfig}
          onApply={applyVoices}
          onClose={() => setShowPicker(false)}
        />
      )}
      {showDesigner && (
        <VoiceDesigner
          characters={characterNames}
          scriptId={scriptId}
          onAssign={(target, voiceId) => void assignDesignedVoice(target, voiceId)}
          onClose={() => setShowDesigner(false)}
        />
      )}
    </main>
  );
}
