"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";

const LABELS: Record<string, string> = {
  new_script: "New Script",
  new_submission: "New Submission",
  writers_choice: "Writer's Choice",
  assembly_ready: "Table Read Ready",
  audience_vote: "Audience Vote",
  new_comment: "New Comment",
  live_reading_signup: "Live Reading Sign-up",
  live_reading_cast: "You're Cast!",
  live_reading_reminder: "Live Reading Reminder",
  live_reading_published: "Recording Posted",
};

type Notif = {
  id: string;
  type: string;
  payload: Record<string, unknown> | null;
  read: boolean;
  created_at: string;
};

function relativeTime(iso: string): string {
  const abs = Math.abs(Date.now() - new Date(iso).getTime()) / 1000;
  if (abs < 60) return "just now";
  if (abs < 3600) return `${Math.round(abs / 60)}m ago`;
  if (abs < 86400) return `${Math.round(abs / 3600)}h ago`;
  if (abs < 604800) return `${Math.round(abs / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function NotificationsPage() {
  const router = useRouter();
  const supabase = getBrowserClient();
  const [items, setItems] = useState<Notif[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.push("/sign-in?next=/notifications");
      return;
    }
    setUserId(user.id);
    const { data } = await supabase
      .from("notifications")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(80);
    setItems((data as Notif[]) ?? []);
    setLoading(false);
  }, [router, supabase]);

  useEffect(() => {
    load();
  }, [load]);

  // Realtime — prepend new notifications as they arrive.
  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel("notifications-web")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` },
        (payload) => setItems((prev) => [payload.new as Notif, ...prev])
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, supabase]);

  async function markAllRead() {
    if (!userId) return;
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    await supabase.from("notifications").update({ read: true }).eq("user_id", userId).eq("read", false);
  }

  function onClick(n: Notif) {
    if (!n.read) {
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      supabase.from("notifications").update({ read: true }).eq("id", n.id);
    }
    const p = (n.payload ?? {}) as Record<string, string>;
    if (n.type === "new_submission" && p.script_id) router.push(`/studio/${p.script_id}`);
    else if (n.type === "live_reading_signup" && p.script_id) router.push(`/studio/${p.script_id}/live`);
    else if (n.type.startsWith("live_reading") && p.live_reading_id) router.push(`/live/${p.live_reading_id}`);
    else if (p.script_id) router.push(`/script/${p.script_id}`);
  }

  if (loading) {
    return <main className="mx-auto max-w-2xl px-6 py-16 text-taupe">Loading…</main>;
  }

  const unread = items.filter((n) => !n.read);
  const read = items.filter((n) => n.read);

  const Row = ({ n }: { n: Notif }) => {
    const p0 = n.payload as { message?: string; body?: string } | null;
    const message = p0?.message ?? p0?.body;
    return (
      <button
        onClick={() => onClick(n)}
        className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left ${
          n.read ? "border-tan bg-ivory" : "border-brick/30 bg-brick/5"
        }`}
      >
        {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brick" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium">{LABELS[n.type] ?? n.type}</span>
            <span className="shrink-0 text-xs text-muted">{relativeTime(n.created_at)}</span>
          </div>
          {message && <p className="mt-0.5 text-sm text-taupe">{message}</p>}
        </div>
      </button>
    );
  };

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      <Link href="/" className="text-sm text-taupe hover:text-ink">
        ← Prelogue
      </Link>

      <div className="mt-6 flex items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 font-slab text-3xl">
          Notifications
          {unread.length > 0 && (
            <span className="rounded-full bg-brick px-2 py-0.5 text-sm font-medium text-white">
              {unread.length}
            </span>
          )}
        </h1>
        {unread.length > 0 && (
          <button onClick={markAllRead} className="text-sm font-medium text-brick hover:underline">
            Mark all read
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="mt-12 rounded-2xl border border-tan bg-ivory p-10 text-center">
          <p className="font-slab text-xl">All caught up</p>
          <p className="mt-2 text-sm text-taupe">
            Activity on your scripts, reads, and table reads shows up here.
          </p>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          {unread.length > 0 && (
            <section>
              <h2 className="mb-2 font-mono text-xs uppercase tracking-wider text-muted">New</h2>
              <div className="space-y-2">
                {unread.map((n) => (
                  <Row key={n.id} n={n} />
                ))}
              </div>
            </section>
          )}
          {read.length > 0 && (
            <section>
              <h2 className="mb-2 font-mono text-xs uppercase tracking-wider text-muted">Earlier</h2>
              <div className="space-y-2">
                {read.map((n) => (
                  <Row key={n.id} n={n} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </main>
  );
}
