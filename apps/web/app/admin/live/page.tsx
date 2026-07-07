"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";
import type { LiveReading } from "@/lib/shared";

type Row = Omit<LiveReading, "signups"> & {
  script: { title: string; slug: string | null } | null;
  signups: { id: string; status: string }[];
};

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-tan/50 text-taupe",
  scheduled: "bg-green-100 text-green-800",
  live: "bg-brick text-white",
  completed: "bg-tan/50 text-taupe",
  canceled: "bg-brick/15 text-brick",
};

export default function AdminLivePage() {
  const supabase = getBrowserClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.push("/sign-in?next=/admin/live");
      return;
    }
    const { data: me } = await supabase.from("users").select("is_admin").eq("id", user.id).single();
    if (!me?.is_admin) {
      router.push("/");
      return;
    }
    setAllowed(true);
    const { data } = await supabase
      .from("live_readings")
      .select("*, script:scripts(title, slug), signups:live_reading_signups(id, status)")
      .order("scheduled_at", { ascending: false });
    const list = (data as unknown as Row[]) ?? [];
    setRows(list);
    const map: Record<string, string> = {};
    for (const r of list) {
      if (r.recording_path) {
        const { data: s } = await supabase.storage.from("live-readings").createSignedUrl(r.recording_path, 3600);
        if (s?.signedUrl) map[r.id] = s.signedUrl;
      }
    }
    setUrls(map);
    setLoading(false);
  }, [supabase, router]);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(id: string, p: Record<string, unknown>, key: string) {
    setBusy(key);
    await supabase.from("live_readings").update(p).eq("id", id);
    setBusy(null);
    load();
  }

  async function publishYouTube(r: Row, url: string) {
    if (!url) return;
    setBusy(`${r.id}:yt`);
    await supabase
      .from("live_readings")
      .update({ youtube_url: url, recording_status: "published" })
      .eq("id", r.id);
    // Notify the cast that their reading is posted.
    const { data: cast } = await supabase
      .from("live_reading_signups")
      .select("actor_id")
      .eq("live_reading_id", r.id)
      .eq("status", "cast");
    for (const c of (cast as { actor_id: string }[]) ?? []) {
      await supabase.functions.invoke("send-notification", {
        body: {
          user_id: c.actor_id,
          type: "live_reading_published",
          title: "Your reading is on YouTube 🎬",
          body: `"${r.title}" is now posted.`,
          data: { live_reading_id: r.id, youtube_url: url },
        },
      });
    }
    setBusy(null);
    setNote("Published + cast notified.");
    load();
  }

  if (loading) return <main className="mx-auto max-w-5xl px-6 py-16 text-taupe">Loading…</main>;
  if (!allowed) return null;

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <Link href="/admin/moderation" className="text-taupe hover:text-brick">Moderation</Link>
        <Link href="/admin/live" className="font-medium text-brick">Live readings</Link>
        <Link href="/admin/renders" className="text-taupe hover:text-brick">Daily renders</Link>
      </div>
      <h1 className="mt-5 font-slab text-3xl">Live readings</h1>
      <p className="mt-1 text-sm text-taupe">
        Every scheduled reading. Import the Zoom recording, publish it to the Prelogue YouTube, and manage status.
      </p>
      {note && <p className="mt-3 rounded-lg bg-ivory px-3 py-2 text-sm text-taupe">{note}</p>}

      <div className="mt-6 space-y-5">
        {rows.map((r) => {
          const when = new Date(r.scheduled_at);
          const castCount = r.signups.filter((s) => s.status === "cast").length;
          return (
            <div key={r.id} className="rounded-xl border border-tan bg-ivory p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/live/${r.id}`} className="font-slab text-lg hover:text-brick">
                  {r.title}
                </Link>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_BADGE[r.status]}`}
                >
                  {r.status}
                </span>
                <span className="text-xs text-muted">rec: {r.recording_status}</span>
              </div>
              <p className="mt-1 text-sm text-taupe">
                {when.toLocaleString()} · {r.duration_min} min · {r.script?.title ?? "—"} · {castCount} cast
              </p>

              {urls[r.id] && (
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <video
                    src={urls[r.id]}
                    controls
                    className="w-full rounded-lg border border-tan bg-black sm:w-80"
                  />
                  <a
                    href={urls[r.id]}
                    download={`${r.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.mp4`}
                    className="h-fit rounded-lg bg-brick px-3 py-1.5 text-xs font-medium text-white"
                  >
                    ⬇ Download
                  </a>
                </div>
              )}

              {/* Publish to YouTube (auto-upload lands here in a later layer) */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  id={`yt-${r.id}`}
                  defaultValue={r.youtube_url ?? ""}
                  placeholder="Paste the Prelogue YouTube URL…"
                  className="min-w-[220px] flex-1 rounded-lg border border-tan bg-elevated px-3 py-1.5 text-sm outline-none focus:border-brick"
                />
                <button
                  onClick={() => {
                    const el = document.getElementById(`yt-${r.id}`) as HTMLInputElement | null;
                    if (el) publishYouTube(r, el.value.trim());
                  }}
                  disabled={busy === `${r.id}:yt`}
                  className="rounded-lg bg-brick px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                >
                  {busy === `${r.id}:yt` ? "…" : "Publish + notify cast"}
                </button>
                {r.youtube_url && (
                  <a
                    href={r.youtube_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-brick underline"
                  >
                    open
                  </a>
                )}
              </div>

              <div className="mt-3 flex flex-wrap gap-2 border-t border-tan pt-3">
                {r.status !== "live" && (
                  <button
                    onClick={() => patch(r.id, { status: "live" }, `${r.id}:live`)}
                    className="rounded-lg border border-tan px-3 py-1.5 text-xs font-medium text-taupe hover:bg-elevated"
                  >
                    Mark live
                  </button>
                )}
                {r.status !== "completed" && (
                  <button
                    onClick={() => patch(r.id, { status: "completed" }, `${r.id}:done`)}
                    className="rounded-lg border border-tan px-3 py-1.5 text-xs font-medium text-taupe hover:bg-elevated"
                  >
                    Mark completed
                  </button>
                )}
                {r.status !== "canceled" && (
                  <button
                    onClick={() => patch(r.id, { status: "canceled" }, `${r.id}:cancel`)}
                    className="rounded-lg border border-brick/40 px-3 py-1.5 text-xs font-medium text-brick hover:bg-brick/5"
                  >
                    Cancel
                  </button>
                )}
                <Link
                  href={`/studio/${r.script_id}/live`}
                  className="rounded-lg border border-tan px-3 py-1.5 text-xs font-medium text-taupe hover:bg-elevated"
                >
                  Writer view →
                </Link>
              </div>
            </div>
          );
        })}
        {rows.length === 0 && <p className="text-muted">No live readings scheduled yet.</p>}
      </div>
    </main>
  );
}
