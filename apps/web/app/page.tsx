import Link from "next/link";
import Image from "next/image";
import { createClient } from "@/lib/supabase/server";
import { SiteHeader } from "@/components/SiteHeader";
import { HeroScriptDemo } from "@/components/HeroScriptDemo";
import { MicIcon, VideoIcon, CastIcon, YouTubeIcon } from "@/components/icons";
import type { Script } from "@/lib/shared";

const DEMO_SCRIPT_SLUG = "booth-nine";

// A taste of the library on the voices card — real names from the catalog.
const VOICE_CHIPS = ["Roger One", "Marcia", "Atlas", "Olympe", "Bella", "Cormac", "Gigi"];
const EMOTION_TAGS = ["[scared]", "[whispers]", "[angry]", "[sad]", "[cheerfully]", "[deadpan]"];

export default async function Home() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("scripts")
    .select("id, slug, title, logline, genre, visibility, cover_image_url")
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(12);

  const scripts = ((data as Script[] | null) ?? []).filter(
    (s) => (s.visibility ?? "public") === "public"
  );

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <SiteHeader />

      {/* HERO — the pitch on the left, the product performing itself on the right */}
      <section className="mt-12 grid items-center gap-10 lg:grid-cols-[1fr_minmax(0,34rem)]">
        <div>
          <div className="font-mono text-xs uppercase tracking-widest text-brick">
            A table read, on demand
          </div>
          <h1 className="mt-3 max-w-xl font-slab text-4xl leading-tight sm:text-5xl">
            Hear your screenplay performed.
          </h1>
          <p className="mt-4 max-w-xl text-lg text-taupe">
            Upload a script and it reads itself aloud — cast from 900+ AI voices,
            direct any single line&rsquo;s emotion, and let real actors audition
            for your roles.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link
              href={`/script/${DEMO_SCRIPT_SLUG}`}
              className="inline-flex items-center gap-2 rounded-xl bg-brick px-5 py-3 font-medium text-white"
            >
              ▶ Try the demo — no account
            </Link>
            <Link
              href="/studio/upload"
              className="inline-flex items-center gap-2 rounded-xl border border-tan px-5 py-3 font-medium text-taupe hover:bg-ivory"
            >
              Upload a script
            </Link>
          </div>
          <p className="mt-4 font-mono text-[11px] uppercase tracking-wider text-muted">
            Free preview · $19 unlocks the full read · no subscription
          </p>
        </div>

        <HeroScriptDemo />
      </section>

      {/* FEATURES — four artifacts from the product's world */}
      <section className="mt-20">
        <div className="font-mono text-xs uppercase tracking-widest text-brick">The toolkit</div>
        <h2 className="mt-2 font-slab text-2xl sm:text-3xl">Everything a read needs</h2>

        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          {/* 900+ voices */}
          <Link
            href={`/script/${DEMO_SCRIPT_SLUG}`}
            className="group rounded-2xl border border-tan bg-ivory p-6 transition-colors hover:border-brick"
          >
            <div className="flex items-center gap-2 text-brick">
              <MicIcon className="h-5 w-5" />
              <span className="font-slab text-xl">900+ voices</span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-taupe">
              Cast every character from a searchable voice library — filter by
              gender, age, and accent, preview instantly, and swap any role in
              seconds.
            </p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {VOICE_CHIPS.map((v) => (
                <span
                  key={v}
                  className="rounded-full border border-tan bg-elevated px-2.5 py-1 text-xs text-taupe"
                >
                  {v}
                </span>
              ))}
              <span className="rounded-full border border-brick/40 bg-brick/5 px-2.5 py-1 text-xs font-medium text-brick">
                +900 more
              </span>
            </div>
          </Link>

          {/* Per-line direction */}
          <Link
            href={`/script/${DEMO_SCRIPT_SLUG}`}
            className="group rounded-2xl border border-tan bg-ivory p-6 transition-colors hover:border-brick"
          >
            <div className="flex items-center gap-2 text-brick">
              <span className="font-mono text-lg font-bold">[&nbsp;]</span>
              <span className="font-slab text-xl">Direct every line</span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-taupe">
              Tune speed and delivery per role — or per single line. Tag a line
              with an emotion and it&rsquo;s acted, not just read.
            </p>
            <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1.5 font-mono text-sm text-brick">
              {EMOTION_TAGS.map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>
          </Link>

          {/* Real actors */}
          <Link
            href={`/script/${DEMO_SCRIPT_SLUG}`}
            className="group rounded-2xl border border-tan bg-ivory p-6 transition-colors hover:border-brick"
          >
            <div className="flex items-center gap-2 text-brick">
              <VideoIcon className="h-5 w-5" />
              <span className="font-slab text-xl">Real actors, real takes</span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-taupe">
              Actors record your roles by webcam, line by line. Preview their
              takes, cast your favorite, and their performance splices into the
              read.
            </p>
            <div className="mt-4 space-y-1.5 font-mono text-xs text-taupe">
              <div className="flex items-center justify-between rounded-lg border border-tan bg-elevated px-3 py-1.5">
                <span className="font-bold text-ink">VERA</span>
                <span>
                  Read by Ceecee <span className="text-brick">★</span>
                </span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-tan bg-elevated px-3 py-1.5">
                <span className="font-bold text-ink">DANNY</span>
                <span>
                  Read by hlamode <span className="text-brick">★</span>
                </span>
              </div>
            </div>
          </Link>

          {/* Live readings */}
          <Link
            href="/live"
            className="group rounded-2xl border border-tan bg-ivory p-6 transition-colors hover:border-brick"
          >
            <div className="flex items-center gap-2 text-brick">
              <CastIcon className="h-5 w-5" />
              <span className="font-slab text-xl">Live table reads</span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-taupe">
              Schedule a live Zoom reading — actors sign up, you choose the
              cast, everyone performs together in real time.
            </p>
            <div className="mt-4 rounded-lg border border-tan bg-elevated px-3 py-2.5 font-mono text-xs text-taupe">
              <div className="flex items-center justify-between">
                <span className="font-bold uppercase tracking-wide text-ink">Live reading</span>
                <span className="rounded-full bg-brick px-2 py-0.5 text-[10px] font-medium uppercase text-white">
                  Zoom
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between">
                <span>Actors sign up → writer casts</span>
                <span className="flex items-center gap-1">
                  <YouTubeIcon className="h-3.5 w-3.5" /> recorded
                </span>
              </div>
            </div>
          </Link>
        </div>
      </section>

      {/* FEATURED SCRIPTS */}
      {scripts.length > 0 && (
        <section className="mt-20">
          <div className="flex items-end justify-between gap-3">
            <div>
              <div className="font-mono text-xs uppercase tracking-widest text-brick">
                Now reading
              </div>
              <h2 className="mt-2 font-slab text-2xl sm:text-3xl">Featured scripts</h2>
            </div>
            <Link href="/discover" className="text-sm text-taupe hover:text-brick">
              Discover all →
            </Link>
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {scripts.map((s) => (
              <Link
                key={s.id}
                href={`/script/${s.slug ?? s.id}`}
                className="flex gap-4 rounded-xl border border-tan bg-ivory p-4 transition-colors hover:bg-elevated"
              >
                {s.cover_image_url && (
                  <div className="relative h-28 w-[4.75rem] shrink-0 overflow-hidden rounded-lg border border-tan bg-elevated">
                    <Image src={s.cover_image_url} alt="" fill sizes="76px" className="object-cover" />
                  </div>
                )}
                <div className="min-w-0">
                  <div className="text-xs font-medium text-brick">{s.genre}</div>
                  <div className="mt-1 font-slab text-lg leading-tight">{s.title}</div>
                  <p className="mt-1 line-clamp-2 text-sm text-taupe">{s.logline}</p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* WRITER CTA */}
      <section className="mt-20 rounded-2xl border border-tan bg-ivory p-8 text-center sm:p-10">
        <div className="font-mono text-xs uppercase tracking-widest text-brick">For writers</div>
        <h2 className="mx-auto mt-2 max-w-lg font-slab text-2xl leading-snug sm:text-3xl">
          Your script deserves to be heard before it&rsquo;s shot.
        </h2>
        <p className="mx-auto mt-3 max-w-md text-taupe">
          Upload a PDF and hear the opening free. One payment of $19 unlocks the
          complete read — replays are free forever.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/studio/upload"
            className="rounded-xl bg-brick px-5 py-3 font-medium text-white"
          >
            Upload a script
          </Link>
          <Link
            href="/how-it-works"
            className="rounded-xl border border-tan px-5 py-3 font-medium text-taupe hover:bg-elevated"
          >
            How it works
          </Link>
        </div>
      </section>
    </main>
  );
}
