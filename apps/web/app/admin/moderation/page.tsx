"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";
import { ClipReel } from "@/components/ClipReel";

type SubClip = { element_index: number; clip_url: string };
type Sub = {
  id: string;
  take_number: number;
  created_at: string;
  clips: SubClip[] | null;
  video_url: string | null;
  moderation_meta: Record<string, unknown> | null;
  actor: { display_name: string } | null;
  character: { name: string } | null;
  script: { title: string; slug: string | null } | null;
};

export default function AdminModerationPage() {
  const supabase = getBrowserClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(false);
  const [subs, setSubs] = useState<Sub[]>([]);
  const [urls, setUrls] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.push("/sign-in?next=/admin/moderation");
      return;
    }
    const { data: me } = await supabase.from("users").select("is_admin").eq("id", user.id).single();
    if (!me?.is_admin) {
      router.push("/");
      return;
    }
    setAllowed(true);
    const { data } = await supabase
      .from("submissions")
      .select(
        "id, take_number, created_at, clips, video_url, moderation_meta, actor:users!submissions_actor_id_fkey(display_name), character:characters(name), script:scripts(title, slug)"
      )
      .eq("moderation_status", "pending")
      .order("created_at", { ascending: true });
    const list = (data as unknown as Sub[]) ?? [];
    setSubs(list);

    // Sign every clip in one batch, then map back per submission.
    const allPaths = [
      ...new Set(
        list.flatMap((s) => [
          ...((s.clips ?? []).map((c) => c.clip_url)),
          ...(s.video_url ? [s.video_url] : []),
        ])
      ),
    ];
    const byPath = new Map<string, string>();
    if (allPaths.length) {
      const { data: signed } = await supabase.storage.from("submissions").createSignedUrls(allPaths, 3600);
      allPaths.forEach((p, i) => byPath.set(p, signed?.[i]?.signedUrl ?? ""));
    }
    const map: Record<string, string[]> = {};
    for (const s of list) {
      const paths = [...(s.clips ?? []).map((c) => c.clip_url), ...(s.video_url ? [s.video_url] : [])];
      map[s.id] = paths.map((p) => byPath.get(p) ?? "").filter(Boolean);
    }
    setUrls(map);
    setLoading(false);
  }, [supabase, router]);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(s: Sub, status: "approved" | "rejected") {
    setBusy(s.id);
    await supabase
      .from("submissions")
      .update({
        moderation_status: status,
        moderation_meta: { ...(s.moderation_meta || {}), manual: status, at: new Date().toISOString() },
      })
      .eq("id", s.id);
    setBusy(null);
    setNote(`${status === "approved" ? "Approved" : "Rejected"} — ${s.actor?.display_name ?? "read"}.`);
    load();
  }

  if (loading) return <main className="mx-auto max-w-4xl px-6 py-16 text-taupe">Loading…</main>;
  if (!allowed) return null;

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <Link href="/admin/users" className="text-taupe hover:text-brick">People</Link>
        <Link href="/admin/moderation" className="font-medium text-brick">Moderation</Link>
        <Link href="/admin/live" className="text-taupe hover:text-brick">Live readings</Link>
        <Link href="/admin/renders" className="text-taupe hover:text-brick">Daily renders</Link>
      </div>
      <h1 className="mt-5 font-slab text-3xl">Moderation queue</h1>
      <p className="mt-1 text-sm text-taupe">
        Reads awaiting review. Watch, then <b>Approve</b> (writer can see + cast it) or <b>Reject</b> (stays hidden).
      </p>
      {note && <p className="mt-3 rounded-lg bg-ivory px-3 py-2 text-sm text-taupe">{note}</p>}

      <div className="mt-6 space-y-6">
        {subs.map((s) => {
          const flag = (s.moderation_meta as { reasons?: string[] } | null)?.reasons;
          return (
            <div key={s.id} className="rounded-xl border border-tan bg-ivory p-4">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium">{s.actor?.display_name ?? "Actor"}</span>
                <span className="text-sm text-muted">as {s.character?.name ?? "—"}</span>
                <span className="text-xs text-muted">· {s.script?.title ?? "—"} · take #{s.take_number}</span>
                <span className="text-xs text-muted">· {new Date(s.created_at).toLocaleString()}</span>
                {flag && flag.length > 0 && (
                  <span className="rounded-full bg-brick/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-brick">
                    flagged: {flag.join(", ")}
                  </span>
                )}
              </div>
              <div className="mt-3">
                <ClipReel urls={urls[s.id] ?? []} />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => decide(s, "approved")}
                  disabled={busy === s.id}
                  className="rounded-lg bg-brick px-4 py-1.5 text-sm font-medium text-white disabled:opacity-60"
                >
                  ✓ Approve
                </button>
                <button
                  onClick={() => decide(s, "rejected")}
                  disabled={busy === s.id}
                  className="rounded-lg border border-brick/40 px-4 py-1.5 text-sm font-medium text-brick hover:bg-brick/5 disabled:opacity-60"
                >
                  ✕ Reject
                </button>
                {s.script?.slug && (
                  <Link
                    href={`/script/${s.script.slug}`}
                    className="rounded-lg border border-tan px-4 py-1.5 text-sm font-medium text-taupe hover:bg-elevated"
                  >
                    View script
                  </Link>
                )}
              </div>
            </div>
          );
        })}
        {subs.length === 0 && <p className="text-muted">Nothing to review — the queue is empty. 🎉</p>}
      </div>
    </main>
  );
}
