import Link from "next/link";
import Image from "next/image";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { SiteHeader } from "@/components/SiteHeader";
import type { Script } from "@/lib/shared";

export const metadata: Metadata = {
  title: "Discover — Prelogue",
  description: "Browse screenplays performed as table reads by AI voices and real actors.",
};

type Actor = {
  id: string;
  username: string | null;
  display_name: string;
  avatar_url: string | null;
  writers_choice_count: number;
};

export default async function DiscoverPage() {
  const supabase = await createClient();
  const [{ data: scriptRows }, { data: actorRows }] = await Promise.all([
    supabase
      .from("scripts")
      .select("id, slug, title, logline, genre, visibility")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(60),
    supabase
      .from("users")
      .select("id, username, display_name, avatar_url, writers_choice_count")
      .order("writers_choice_count", { ascending: false })
      .limit(10),
  ]);

  const scripts = ((scriptRows as Script[] | null) ?? []).filter(
    (s) => (s.visibility ?? "public") === "public"
  );
  const actors = ((actorRows as Actor[] | null) ?? []).filter(
    (a) => a.writers_choice_count > 0
  );

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <SiteHeader />

      <section className="mt-12">
        <h1 className="font-slab text-4xl leading-tight sm:text-5xl">Discover</h1>
        <p className="mt-3 text-taupe">Screenplays performed as table reads — pick one and press play.</p>
      </section>

      <div className="mt-10 grid gap-10 lg:grid-cols-[1fr_280px]">
        {/* Scripts */}
        <section>
          <h2 className="font-slab text-lg">Open scripts</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {scripts.map((s) => (
              <Link
                key={s.id}
                href={`/script/${s.slug ?? s.id}`}
                className="rounded-xl border border-tan bg-ivory p-5 transition-colors hover:bg-elevated"
              >
                <div className="text-xs font-medium text-brick">{s.genre}</div>
                <div className="mt-1 font-slab text-xl">{s.title}</div>
                <p className="mt-1 line-clamp-2 text-sm text-taupe">{s.logline}</p>
              </Link>
            ))}
            {scripts.length === 0 && (
              <p className="text-muted">No open scripts yet — check back soon.</p>
            )}
          </div>
        </section>

        {/* Top actors */}
        <aside>
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-slab text-lg">Top actors</h2>
            <Link href="/leaderboard" className="text-sm text-brick hover:underline">
              All ›
            </Link>
          </div>
          {actors.length > 0 ? (
            <div className="mt-4 divide-y divide-tan rounded-xl border border-tan bg-ivory">
              {actors.map((a, i) => (
                <Link
                  key={a.id}
                  href={a.username ? `/u/${a.username}` : "#"}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-elevated"
                >
                  <span className="w-5 text-center font-slab text-sm text-muted">{i + 1}</span>
                  <span className="h-8 w-8 overflow-hidden rounded-full border border-tan bg-elevated">
                    {a.avatar_url ? (
                      <Image
                        src={a.avatar_url}
                        alt={a.display_name}
                        width={32}
                        height={32}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-xs text-taupe">
                        {a.display_name.charAt(0).toUpperCase()}
                      </span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{a.display_name}</span>
                  <span className="shrink-0 text-xs text-muted">★ {a.writers_choice_count}</span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted">
              No Writer&rsquo;s Choice picks yet — actors climb here as writers choose their reads.
            </p>
          )}
        </aside>
      </div>
    </main>
  );
}
