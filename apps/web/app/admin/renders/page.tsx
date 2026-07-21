"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";
import { VoicePicker } from "@/components/VoicePicker";
import type { VoiceConfig } from "@/lib/shared";

type Render = {
  id: string;
  script_id: string;
  variant: "ai" | "composite";
  status: "processing" | "ready" | "failed" | "posted";
  video_path: string | null;
  caption: string | null;
  title: string | null;
  duration_frames: number | null;
  fps: number | null;
  error: string | null;
  created_at: string;
  /** Joined from scripts — Claude writes a logline with every daily scene. */
  script?: { logline: string | null } | null;
};

const badge: Record<Render["status"], string> = {
  processing: "bg-tan/50 text-taupe",
  ready: "bg-green-100 text-green-800",
  failed: "bg-brick/15 text-brick",
  posted: "bg-brick text-white",
};

export default function AdminRendersPage() {
  const supabase = getBrowserClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(false);
  const [renders, setRenders] = useState<Render[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [voiceEdit, setVoiceEdit] = useState<{ render: Render; characters: string[]; config: VoiceConfig } | null>(null);
  // scriptId -> the render id that was newest when we kicked off a re-render.
  // While present, that scene shows "rendering…"; cleared once a newer render lands.
  const [pending, setPending] = useState<Record<string, string | null>>({});
  // Keep polling for a brand-new "Generate now" scene until this epoch-ms.
  const [genUntil, setGenUntil] = useState(0);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.push("/sign-in?next=/admin/renders");
      return;
    }
    const { data: me } = await supabase.from("users").select("is_admin").eq("id", user.id).single();
    if (!me?.is_admin) {
      router.push("/");
      return;
    }
    setAllowed(true);
    const { data } = await supabase
      .from("daily_renders")
      .select("*, script:scripts(logline)")
      .order("created_at", { ascending: false });
    const rows = (data as Render[]) ?? [];
    setRenders(rows);
    const map: Record<string, string> = {};
    for (const r of rows) {
      if (r.video_path) {
        const { data: s } = await supabase.storage.from("daily-renders").createSignedUrl(r.video_path, 3600);
        if (s?.signedUrl) map[r.id] = s.signedUrl;
      }
    }
    setUrls(map);
    setLoading(false);
  }, [supabase, router]);

  useEffect(() => {
    load();
  }, [load]);

  // One card per scene: the newest render for each script + variant (rows are newest-first).
  const latest = useMemo(() => {
    const seen = new Map<string, Render>();
    for (const r of renders) {
      const k = `${r.script_id}:${r.variant}`;
      if (!seen.has(k)) seen.set(k, r);
    }
    return [...seen.values()];
  }, [renders]);

  // Clear a scene's "rendering…" flag once a newer render has landed for it.
  useEffect(() => {
    setPending((prev) => {
      if (!Object.keys(prev).length) return prev;
      let changed = false;
      const next = { ...prev };
      for (const r of latest) {
        if (r.script_id in next && r.id !== next[r.script_id] && r.status !== "processing") {
          delete next[r.script_id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [latest]);

  // Poll while anything is in flight (a scene rendering, a processing row, or a fresh generate).
  useEffect(() => {
    const active =
      Object.keys(pending).length > 0 ||
      latest.some((r) => r.status === "processing") ||
      Date.now() < genUntil;
    if (!active) return;
    const t = setInterval(() => void load(), 12000);
    return () => clearInterval(t);
  }, [pending, latest, genUntil, load]);

  async function dispatch(body: Record<string, unknown>, key: string, msg: string) {
    setBusy(key);
    setNote(null);
    const { error } = await supabase.functions.invoke("daily-dispatch", { body });
    setBusy(null);
    if (error) {
      setNote(`Error: ${error.message}`);
      return;
    }
    setNote(msg);
    if (body.action === "render" && typeof body.script_id === "string") {
      const sid = body.script_id;
      const cur = latest.find((r) => r.script_id === sid);
      setPending((p) => ({ ...p, [sid]: cur?.id ?? null }));
    } else if (body.action === "generate") {
      setGenUntil(Date.now() + 5 * 60 * 1000);
    }
    void load();
  }
  const generateNow = () =>
    dispatch({ action: "generate" }, "gen", "Generating a new scene — it'll appear here automatically in a few minutes.");
  const reRender = (r: Render) =>
    dispatch(
      { action: "render", script_id: r.script_id, variant: r.variant },
      r.id,
      "Re-rendering — the new version replaces this one automatically in ~2–3 min.",
    );

  async function openVoices(r: Render) {
    setBusy(`${r.id}:voices`);
    setNote(null);
    const [{ data: script }, { data: chars }] = await Promise.all([
      supabase.from("scripts").select("voice_config").eq("id", r.script_id).single(),
      supabase.from("characters").select("name").eq("script_id", r.script_id).order("name"),
    ]);
    setBusy(null);
    const config = (script?.voice_config as VoiceConfig | null) ?? {
      mode: "per_character",
      single_voice_id: null,
      narrator_voice_id: null,
      characters: {},
    };
    let names = (chars ?? []).map((c: { name: string }) => c.name);
    if (!names.length) names = Object.keys(config.characters ?? {});
    setVoiceEdit({ render: r, characters: names, config });
  }
  function applyVoices(cfg: VoiceConfig) {
    if (!voiceEdit) return;
    const r = voiceEdit.render;
    setVoiceEdit(null);
    dispatch(
      { action: "render", script_id: r.script_id, variant: r.variant, voice_config: cfg },
      r.id,
      "Voices saved — re-rendering with the new cast. The video updates automatically in ~2–3 min.",
    );
  }

  async function markPosted(r: Render) {
    await supabase.from("daily_renders").update({ status: "posted" }).eq("id", r.id);
    load();
  }
  async function saveCaption(r: Render, caption: string) {
    await supabase.from("daily_renders").update({ caption }).eq("id", r.id);
  }
  async function del(r: Render) {
    if (!confirm("Delete this scene and its video? This can't be undone.")) return;
    await supabase.rpc("delete_script", { p_script_id: r.script_id });
    await supabase.from("daily_renders").delete().eq("script_id", r.script_id);
    load();
  }

  if (loading) return <main className="mx-auto max-w-5xl px-6 py-16 text-taupe">Loading…</main>;
  if (!allowed) return null;

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <Link href="/admin/moderation" className="text-taupe hover:text-brick">Moderation</Link>
        <Link href="/admin/live" className="text-taupe hover:text-brick">Live readings</Link>
        <Link href="/admin/renders" className="font-medium text-brick">Daily renders</Link>
      </div>
      <div className="mt-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-slab text-3xl">Daily renders</h1>
          <p className="mt-1 text-sm text-taupe">AI-generated 9:16 scenes — download and post to social. Not shown on the public site.</p>
        </div>
        <button
          onClick={generateNow}
          disabled={busy === "gen"}
          className="shrink-0 rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy === "gen" ? "Generating…" : "✨ Generate now"}
        </button>
      </div>
      {note && <p className="mt-3 rounded-lg bg-ivory px-3 py-2 text-sm text-taupe">{note}</p>}

      <div className="mt-6 space-y-5">
        {latest.map((r) => {
          const rendering = r.script_id in pending || r.status === "processing";
          return (
            <div key={r.script_id} className="flex flex-col gap-4 rounded-xl border border-tan bg-ivory p-4 sm:flex-row">
              <div className="relative w-full shrink-0 sm:w-44">
                {urls[r.id] ? (
                  <video src={urls[r.id]} controls className="aspect-[9/16] w-full rounded-lg border border-tan bg-black object-contain" />
                ) : (
                  <div className="flex aspect-[9/16] w-full items-center justify-center rounded-lg border border-tan bg-elevated text-xs text-muted">
                    {r.status === "failed" ? "failed" : "rendering…"}
                  </div>
                )}
                {rendering && urls[r.id] && (
                  <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-ivory/80 text-xs font-medium text-taupe">
                    ⏳ rendering new version…
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-slab text-lg">{r.title || "Untitled"}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${rendering ? badge.processing : badge[r.status]}`}>
                    {rendering ? "rendering" : r.status}
                  </span>
                  <span className="text-xs text-muted">{r.variant === "composite" ? "with actors" : "AI voices"}</span>
                  {r.duration_frames && r.fps ? (
                    <span className="text-xs text-muted">{(r.duration_frames / r.fps).toFixed(0)}s</span>
                  ) : null}
                </div>
                {r.script?.logline && (
                  <p className="mt-1 text-sm leading-snug text-taupe">{r.script.logline}</p>
                )}
                {r.error && <p className="mt-1 text-xs text-brick">{r.error}</p>}
                <textarea
                  defaultValue={r.caption ?? ""}
                  onBlur={(e) => saveCaption(r, e.target.value)}
                  placeholder="Social caption…"
                  rows={2}
                  className="mt-2 w-full rounded-lg border border-tan bg-elevated px-3 py-2 text-sm outline-none focus:border-brick"
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  {urls[r.id] && (
                    <a
                      href={urls[r.id]}
                      download={`${(r.title || "scene").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.mp4`}
                      className="rounded-lg bg-brick px-3 py-1.5 text-xs font-medium text-white"
                    >
                      ⬇ Download
                    </a>
                  )}
                  <Link href={`/studio/${r.script_id}/lines`} className="rounded-lg border border-tan px-3 py-1.5 text-xs font-medium text-taupe hover:bg-elevated">
                    Edit scene
                  </Link>
                  <button onClick={() => reRender(r)} disabled={rendering} className="rounded-lg border border-tan px-3 py-1.5 text-xs font-medium text-taupe hover:bg-elevated disabled:opacity-60">
                    {rendering ? "…" : "↻ Re-render"}
                  </button>
                  <button onClick={() => openVoices(r)} disabled={rendering || busy === `${r.id}:voices`} className="rounded-lg border border-tan px-3 py-1.5 text-xs font-medium text-taupe hover:bg-elevated disabled:opacity-60">
                    {busy === `${r.id}:voices` ? "…" : "🎙 Change voices"}
                  </button>
                  {r.status !== "posted" && !rendering && (
                    <button onClick={() => markPosted(r)} className="rounded-lg border border-tan px-3 py-1.5 text-xs font-medium text-taupe hover:bg-elevated">
                      Mark posted
                    </button>
                  )}
                  <button onClick={() => del(r)} className="rounded-lg border border-brick/40 px-3 py-1.5 text-xs font-medium text-brick hover:bg-brick/5">
                    Delete
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {latest.length === 0 && (
          <p className="text-muted">No renders yet — hit “Generate now,” or wait for the daily cron.</p>
        )}
      </div>

      {voiceEdit && (
        <VoicePicker
          scriptId={voiceEdit.render.script_id}
          characters={voiceEdit.characters}
          startConfig={voiceEdit.config}
          onApply={(cfg) => applyVoices(cfg)}
          onClose={() => setVoiceEdit(null)}
        />
      )}
    </main>
  );
}
