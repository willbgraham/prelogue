"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";

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
      .select("*")
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

  async function dispatch(body: Record<string, unknown>, key: string, msg: string) {
    setBusy(key);
    setNote(null);
    const { error } = await supabase.functions.invoke("daily-dispatch", { body });
    setBusy(null);
    setNote(error ? `Error: ${error.message}` : msg);
  }
  const generateNow = () => dispatch({ action: "generate" }, "gen", "Generating a new scene — refresh in a couple of minutes.");
  const reRender = (r: Render) =>
    dispatch({ action: "render", script_id: r.script_id, variant: r.variant }, r.id, "Re-rendering — refresh shortly.");

  async function markPosted(r: Render) {
    await supabase.from("daily_renders").update({ status: "posted" }).eq("id", r.id);
    load();
  }
  async function saveCaption(r: Render, caption: string) {
    await supabase.from("daily_renders").update({ caption }).eq("id", r.id);
  }
  async function del(r: Render) {
    if (!confirm("Delete this render and its generated script? This can't be undone.")) return;
    await supabase.rpc("delete_script", { p_script_id: r.script_id });
    await supabase.from("daily_renders").delete().eq("id", r.id);
    load();
  }

  if (loading) return <main className="mx-auto max-w-5xl px-6 py-16 text-taupe">Loading…</main>;
  if (!allowed) return null;

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="flex items-center justify-between gap-3">
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
        {renders.map((r) => (
          <div key={r.id} className="flex flex-col gap-4 rounded-xl border border-tan bg-ivory p-4 sm:flex-row">
            <div className="w-full shrink-0 sm:w-44">
              {urls[r.id] ? (
                <video src={urls[r.id]} controls className="aspect-[9/16] w-full rounded-lg border border-tan bg-black object-contain" />
              ) : (
                <div className="flex aspect-[9/16] w-full items-center justify-center rounded-lg border border-tan bg-elevated text-xs text-muted">
                  {r.status === "processing" ? "rendering…" : r.status === "failed" ? "failed" : "no video"}
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-slab text-lg">{r.title || "Untitled"}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${badge[r.status]}`}>{r.status}</span>
                <span className="text-xs text-muted">{r.variant === "composite" ? "with actors" : "AI voices"}</span>
                {r.duration_frames && r.fps ? (
                  <span className="text-xs text-muted">{(r.duration_frames / r.fps).toFixed(0)}s</span>
                ) : null}
              </div>
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
                <button onClick={() => reRender(r)} disabled={busy === r.id} className="rounded-lg border border-tan px-3 py-1.5 text-xs font-medium text-taupe hover:bg-elevated disabled:opacity-60">
                  {busy === r.id ? "…" : "↻ Re-render"}
                </button>
                {r.status !== "posted" && (
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
        ))}
        {renders.length === 0 && (
          <p className="text-muted">No renders yet — hit “Generate now,” or wait for the daily cron.</p>
        )}
      </div>
    </main>
  );
}
