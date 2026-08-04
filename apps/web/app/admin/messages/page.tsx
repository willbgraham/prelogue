"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";

type Msg = {
  id: string;
  name: string;
  email: string;
  topic: string;
  message: string;
  handled: boolean;
  created_at: string;
};

const TOPIC_LABEL: Record<string, string> = {
  question: "Question",
  feedback: "Feedback",
  bug: "Bug",
  billing: "Billing",
  other: "Other",
};

const fmt = (d: string) =>
  new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function AdminMessagesPage() {
  const supabase = getBrowserClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [showHandled, setShowHandled] = useState(false);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.push("/sign-in?next=/admin/messages");
      return;
    }
    const { data: me } = await supabase.from("users").select("is_admin").eq("id", user.id).single();
    if (!me?.is_admin) {
      router.push("/");
      return;
    }
    setAllowed(true);
    const { data } = await supabase
      .from("contact_messages")
      .select("id, name, email, topic, message, handled, created_at")
      .order("created_at", { ascending: false });
    setMsgs((data as Msg[]) ?? []);
    setLoading(false);
  }, [router, supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleHandled(m: Msg) {
    setMsgs((p) => p.map((x) => (x.id === m.id ? { ...x, handled: !x.handled } : x)));
    await supabase.from("contact_messages").update({ handled: !m.handled }).eq("id", m.id);
  }

  if (loading) return <main className="mx-auto max-w-4xl px-6 py-16 text-taupe">Loading…</main>;
  if (!allowed) return null;

  const open = msgs.filter((m) => !m.handled);
  const shown = showHandled ? msgs : open;

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <Link href="/admin/users" className="text-taupe hover:text-brick">People</Link>
        <Link href="/admin/messages" className="font-medium text-brick">Messages</Link>
        <Link href="/admin/moderation" className="text-taupe hover:text-brick">Moderation</Link>
        <Link href="/admin/live" className="text-taupe hover:text-brick">Live readings</Link>
        <Link href="/admin/renders" className="text-taupe hover:text-brick">Daily renders</Link>
      </div>

      <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-slab text-3xl">Messages</h1>
          <p className="mt-1 text-sm text-taupe">
            {open.length} open · {msgs.length} total
          </p>
        </div>
        <button
          onClick={() => setShowHandled((s) => !s)}
          className="rounded-lg border border-tan px-3 py-1.5 text-sm text-taupe hover:bg-elevated"
        >
          {showHandled ? "Hide handled" : "Show handled"}
        </button>
      </div>

      <div className="mt-6 space-y-3">
        {shown.map((m) => (
          <div
            key={m.id}
            className={`rounded-xl border bg-ivory p-4 ${
              m.handled ? "border-tan/60 opacity-60" : "border-tan"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{m.name}</span>
              <a href={`mailto:${m.email}`} className="text-sm text-brick hover:underline">
                {m.email}
              </a>
              <span className="rounded-full border border-tan px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                {TOPIC_LABEL[m.topic] ?? m.topic}
              </span>
              <span className="ml-auto text-xs text-muted">{fmt(m.created_at)}</span>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm text-taupe">{m.message}</p>
            <div className="mt-3 flex gap-2">
              <a
                href={`mailto:${m.email}?subject=${encodeURIComponent("Re: your message to Prelogue")}`}
                className="rounded-lg bg-brick px-3 py-1.5 text-xs font-medium text-white"
              >
                Reply
              </a>
              <button
                onClick={() => toggleHandled(m)}
                className="rounded-lg border border-tan px-3 py-1.5 text-xs font-medium text-taupe hover:bg-elevated"
              >
                {m.handled ? "Reopen" : "Mark handled"}
              </button>
            </div>
          </div>
        ))}
        {shown.length === 0 && (
          <p className="rounded-xl border border-tan bg-ivory px-4 py-8 text-center text-muted">
            {msgs.length === 0 ? "No messages yet." : "Nothing open — all caught up."}
          </p>
        )}
      </div>
    </main>
  );
}
