import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SiteHeader } from "@/components/SiteHeader";
import type { LiveReading } from "@/lib/shared";

export const metadata = {
  title: "Live Readings - Prelogue Studio",
  description: "Watch screenplays performed live by real actors, or sign up to read.",
};

type ReadingCard = Omit<LiveReading, "signups"> & {
  script: { title: string; slug: string | null; genre: string } | null;
  signups: { id: string; status: string }[];
};

export default async function LiveIndexPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("live_readings")
    .select("*, script:scripts(title, slug, genre), signups:live_reading_signups(id, status)")
    .eq("visibility", "public")
    .neq("status", "canceled")
    .order("scheduled_at", { ascending: true });
  const readings = (data as unknown as ReadingCard[]) ?? [];
  const now = Date.now();
  const upcoming = readings.filter((r) => new Date(r.scheduled_at).getTime() > now && r.status !== "completed");
  const past = readings.filter((r) => !upcoming.includes(r)).reverse();

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10">
      <SiteHeader />
      <h1 className="mt-8 font-slab text-4xl">Live readings</h1>
      <p className="mt-2 text-taupe">Watch screenplays performed live by real actors — or sign up to read.</p>

      {upcoming.length > 0 && (
        <section className="mt-8">
          <h2 className="font-slab text-lg">Upcoming</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {upcoming.map((r) => (
              <Card key={r.id} r={r} />
            ))}
          </div>
        </section>
      )}
      {past.length > 0 && (
        <section className="mt-10">
          <h2 className="font-slab text-lg">Past readings</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {past.map((r) => (
              <Card key={r.id} r={r} />
            ))}
          </div>
        </section>
      )}
      {readings.length === 0 && (
        <p className="mt-8 text-muted">No live readings scheduled yet — check back soon.</p>
      )}
    </main>
  );
}

function Card({ r }: { r: ReadingCard }) {
  const when = new Date(r.scheduled_at);
  const castCount = r.signups.filter((s) => s.status === "cast").length;
  const past = when.getTime() <= Date.now() || r.status === "completed";
  return (
    <Link href={`/live/${r.id}`} className="block rounded-xl border border-tan bg-ivory p-4 hover:border-brick">
      <div className="flex items-center gap-2">
        {r.status === "live" && (
          <span className="rounded-full bg-brick px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white">
            ● Live
          </span>
        )}
        {r.script?.genre && <span className="text-xs font-medium text-brick">{r.script.genre}</span>}
      </div>
      <div className="mt-1 font-slab text-lg leading-tight">{r.title}</div>
      {r.script?.title && <div className="text-sm text-muted">{r.script.title}</div>}
      <div className="mt-2 text-sm text-taupe">
        {when.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
      </div>
      <div className="mt-1 text-xs text-muted">
        {past ? (r.youtube_url ? "▶ Recording available" : "Completed") : `${castCount} cast so far`}
      </div>
    </Link>
  );
}
