import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { AuthNav } from "@/components/AuthNav";
import type { Script } from "@/lib/shared";

const DEMO_SCRIPT_ID = "b0078900-0000-4000-8000-000000000009";

export default async function Home() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("scripts")
    .select("id, title, logline, genre, visibility")
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(12);

  const scripts = ((data as Script[] | null) ?? []).filter(
    (s) => (s.visibility ?? "public") === "public"
  );

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brick font-slab text-xl text-white">
          P
        </div>
        <span className="font-slab text-xl">Prelogue</span>
        <div className="ml-auto">
          <AuthNav />
        </div>
      </header>

      <section className="mt-12">
        <h1 className="max-w-2xl font-slab text-4xl leading-tight sm:text-5xl">
          Hear your screenplay performed.
        </h1>
        <p className="mt-4 max-w-xl text-taupe">
          AI voices and real actors perform a script as a table read — with the
          screenplay typed on screen.
        </p>
        <Link
          href={`/script/${DEMO_SCRIPT_ID}`}
          className="mt-6 inline-flex items-center gap-2 rounded-xl bg-brick px-5 py-3 font-medium text-white"
        >
          ▶ Try the demo scene
        </Link>
      </section>

      <section className="mt-14">
        <h2 className="font-slab text-lg">Featured scripts</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {scripts.map((s) => (
            <Link
              key={s.id}
              href={`/script/${s.id}`}
              className="rounded-xl border border-tan bg-ivory p-4 transition-colors hover:bg-elevated"
            >
              <div className="text-xs font-medium text-brick">{s.genre}</div>
              <div className="mt-1 font-slab text-lg">{s.title}</div>
              <p className="mt-1 line-clamp-2 text-sm text-taupe">{s.logline}</p>
            </Link>
          ))}
          {scripts.length === 0 && (
            <p className="text-muted">No scripts yet — check back soon.</p>
          )}
        </div>
      </section>
    </main>
  );
}
