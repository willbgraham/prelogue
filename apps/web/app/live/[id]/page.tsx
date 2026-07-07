import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SiteHeader } from "@/components/SiteHeader";
import type { LiveReading } from "@/lib/shared";

type Detail = Omit<LiveReading, "signups"> & {
  script: { title: string; slug: string | null; genre: string; logline: string } | null;
  signups: {
    id: string;
    status: string;
    character: { name: string } | null;
    actor: { display_name: string; username: string | null } | null;
  }[];
};

// Accepts youtu.be, watch?v=, embed/, and live/ URL shapes.
function youtubeEmbed(url?: string | null): string | null {
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|live\/))([\w-]{11})/);
  return m ? `https://www.youtube.com/embed/${m[1]}` : null;
}

export default async function LiveReadingDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase
    .from("live_readings")
    .select(
      "*, script:scripts(title, slug, genre, logline), signups:live_reading_signups(id, status, character:characters!live_reading_signups_character_id_fkey(name), actor:users!live_reading_signups_actor_id_fkey(display_name, username))"
    )
    .eq("id", id)
    .single();
  if (!data) notFound();
  const r = data as unknown as Detail;
  const when = new Date(r.scheduled_at);
  const cast = r.signups.filter((s) => s.status === "cast");
  const embed = youtubeEmbed(r.youtube_url);

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <SiteHeader />
      <Link href="/live" className="mt-8 inline-block text-sm text-taupe hover:text-ink">
        ← Live readings
      </Link>
      <div className="mt-4 flex items-center gap-2">
        {r.status === "live" && (
          <span className="rounded-full bg-brick px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white">
            ● Live now
          </span>
        )}
        {r.script?.genre && <span className="text-xs font-medium text-brick">{r.script.genre}</span>}
      </div>
      <h1 className="mt-1 font-slab text-4xl leading-tight">{r.title}</h1>
      {r.script && (
        <Link href={`/script/${r.script.slug ?? r.script_id}`} className="mt-2 inline-block text-sm text-muted hover:text-brick">
          {r.script.title} →
        </Link>
      )}
      <p className="mt-3 text-taupe">
        {when.toLocaleString([], { dateStyle: "full", timeStyle: "short" })} · {r.duration_min} min
      </p>
      {r.description && <p className="mt-3 whitespace-pre-line leading-relaxed text-ink/90">{r.description}</p>}

      {embed && (
        <div className="mt-6 aspect-video w-full overflow-hidden rounded-xl border border-tan">
          <iframe
            src={embed}
            title={r.title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="h-full w-full"
          />
        </div>
      )}
      {!embed && r.status === "live" && r.stream_url && (
        <a
          href={r.stream_url}
          target="_blank"
          rel="noreferrer"
          className="mt-6 inline-block rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white"
        >
          ▶ Watch live on YouTube
        </a>
      )}

      {cast.length > 0 && (
        <section className="mt-8">
          <h2 className="font-slab text-lg">Cast</h2>
          <div className="mt-3 space-y-1">
            {cast.map((s) => {
              const name = s.actor?.display_name || s.actor?.username || "Actor";
              return (
                <div key={s.id} className="text-sm">
                  <span className="font-medium">{s.character?.name ?? "Role"}</span>
                  <span className="text-muted"> — </span>
                  {s.actor?.username ? (
                    <Link href={`/u/${s.actor.username}`} className="text-muted hover:text-brick">
                      {name}
                    </Link>
                  ) : (
                    <span className="text-muted">{name}</span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}
