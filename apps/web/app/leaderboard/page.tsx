import Link from "next/link";
import Image from "next/image";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = {
  title: "Leaderboard - Prelogue",
  description: "Top actors on Prelogue by Writer's Choice and Audience Favorite.",
};

type Actor = {
  id: string;
  username: string | null;
  display_name: string;
  avatar_url: string | null;
  writers_choice_count: number;
  audience_favorite_count: number;
};

function Board({ actors, metric }: { actors: Actor[]; metric: "writers_choice_count" | "audience_favorite_count" }) {
  const ranked = [...actors].filter((a) => a[metric] > 0).sort((a, b) => b[metric] - a[metric]).slice(0, 20);
  if (ranked.length === 0) {
    return <p className="mt-4 text-sm text-muted">No rankings yet — this fills in as writers and audiences pick reads.</p>;
  }
  return (
    <div className="mt-4 divide-y divide-tan rounded-xl border border-tan bg-ivory">
      {ranked.map((a, i) => (
        <Link
          key={a.id}
          href={a.username ? `/u/${a.username}` : "#"}
          className="flex items-center gap-3 px-4 py-3 hover:bg-elevated"
        >
          <span className="w-6 text-center font-slab text-sm text-muted">{i + 1}</span>
          <span className="h-9 w-9 overflow-hidden rounded-full border border-tan bg-elevated">
            {a.avatar_url ? (
              <Image src={a.avatar_url} alt={a.display_name} width={36} height={36} className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-sm text-taupe">
                {a.display_name.charAt(0).toUpperCase()}
              </span>
            )}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{a.display_name}</span>
          <span className="shrink-0 text-sm text-muted">{a[metric]}</span>
        </Link>
      ))}
    </div>
  );
}

export default async function LeaderboardPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("users")
    .select("id, username, display_name, avatar_url, writers_choice_count, audience_favorite_count")
    .or("writers_choice_count.gt.0,audience_favorite_count.gt.0")
    .limit(100);
  const actors = (data as Actor[] | null) ?? [];

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10">
      <SiteHeader />
      <section className="mt-12">
        <h1 className="font-slab text-4xl leading-tight sm:text-5xl">Leaderboard</h1>
        <p className="mt-3 text-taupe">The actors writers and audiences love most.</p>
      </section>

      <div className="mt-10 grid gap-8 sm:grid-cols-2">
        <section>
          <h2 className="font-slab text-lg">★ Writer&rsquo;s Choice</h2>
          <Board actors={actors} metric="writers_choice_count" />
        </section>
        <section>
          <h2 className="font-slab text-lg">♥ Audience Favorite</h2>
          <Board actors={actors} metric="audience_favorite_count" />
        </section>
      </div>
    </main>
  );
}
