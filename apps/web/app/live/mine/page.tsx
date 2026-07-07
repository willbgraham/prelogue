"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getBrowserClient } from "@/lib/supabase/client";
import type { LiveReading } from "@/lib/shared";

type Row = {
  id: string;
  status: string;
  character: { name: string } | null;
  reading: (LiveReading & { script: { title: string; slug: string | null } | null }) | null;
};

export default function MyLiveReadingsPage() {
  const supabase = getBrowserClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.push("/sign-in?next=/live/mine");
      return;
    }
    const { data } = await supabase
      .from("live_reading_signups")
      .select(
        "id, status, character:characters!live_reading_signups_character_id_fkey(name), reading:live_readings!live_reading_signups_live_reading_id_fkey(*, script:scripts(title, slug))"
      )
      .eq("actor_id", user.id)
      .order("created_at", { ascending: false });
    setRows((data as unknown as Row[]) ?? []);
    setLoading(false);
  }, [supabase, router]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <main className="mx-auto max-w-3xl px-6 py-16 text-taupe">Loading…</main>;

  const now = Date.now();
  const upcoming = rows.filter(
    (r) => r.reading && new Date(r.reading.scheduled_at).getTime() > now && r.reading.status !== "canceled"
  );
  const past = rows.filter((r) => !upcoming.includes(r));

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <Link href="/discover" className="text-sm text-taupe hover:text-ink">
        ← Discover
      </Link>
      <h1 className="mt-6 font-slab text-3xl">My live readings</h1>
      {rows.length === 0 && (
        <p className="mt-6 text-muted">
          You haven&rsquo;t signed up for any live readings yet — find one on a script&rsquo;s page.
        </p>
      )}

      {upcoming.length > 0 && (
        <>
          <h2 className="mt-8 font-slab text-lg">Upcoming</h2>
          <div className="mt-3 space-y-3">
            {upcoming.map((row) => (
              <ReadingRow key={row.id} row={row} />
            ))}
          </div>
        </>
      )}
      {past.length > 0 && (
        <>
          <h2 className="mt-8 font-slab text-lg">Past</h2>
          <div className="mt-3 space-y-3">
            {past.map((row) => (
              <ReadingRow key={row.id} row={row} />
            ))}
          </div>
        </>
      )}
    </main>
  );
}

function ReadingRow({ row }: { row: Row }) {
  const r = row.reading;
  if (!r) return null;
  const when = new Date(r.scheduled_at);
  const cast = row.status === "cast";
  return (
    <div className="rounded-xl border border-tan bg-ivory p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{r.title}</span>
        {cast ? (
          <span className="rounded-full bg-brick px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white">
            Cast
          </span>
        ) : row.status === "declined" ? (
          <span className="text-xs text-muted">not selected</span>
        ) : (
          <span className="text-xs text-muted">signed up</span>
        )}
      </div>
      <div className="text-sm text-taupe">
        {when.toLocaleString()}
        {r.script?.title ? ` · ${r.script.title}` : ""}
        {row.character?.name ? ` · ${row.character.name}` : ""}
      </div>
      {cast && r.zoom_join_url && (
        <a
          href={r.zoom_join_url}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block rounded-lg bg-brick px-3 py-1.5 text-xs font-medium text-white"
        >
          Join the reading →
        </a>
      )}
      {r.youtube_url && (
        <a href={r.youtube_url} target="_blank" rel="noreferrer" className="mt-2 ml-2 inline-block text-sm text-brick underline">
          Watch the recording →
        </a>
      )}
    </div>
  );
}
