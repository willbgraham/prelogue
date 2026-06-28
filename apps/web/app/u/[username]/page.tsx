import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SiteHeader } from "@/components/SiteHeader";
import {
  GlobeIcon,
  XIcon,
  InstagramIcon,
  TikTokIcon,
  YouTubeIcon,
} from "@/components/icons";

type Links = {
  x?: string;
  instagram?: string;
  tiktok?: string;
  youtube?: string;
  imdb?: string;
};

const SOCIALS: { key: keyof Links; Icon: typeof XIcon; label: string }[] = [
  { key: "x", Icon: XIcon, label: "X" },
  { key: "instagram", Icon: InstagramIcon, label: "Instagram" },
  { key: "tiktok", Icon: TikTokIcon, label: "TikTok" },
  { key: "youtube", Icon: YouTubeIcon, label: "YouTube" },
];

export async function generateMetadata({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const supabase = await createClient();
  const { data } = await supabase
    .from("users")
    .select("display_name, bio")
    .eq("username", username)
    .single();
  if (!data) return { title: "Prelogue" };
  return {
    title: `${data.display_name || username} — Prelogue`,
    description: data.bio ?? undefined,
  };
}

export default async function ProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const supabase = await createClient();

  const { data: profile } = await supabase
    .from("users")
    .select("id, username, display_name, avatar_url, bio, website, links")
    .eq("username", username)
    .single();
  if (!profile) notFound();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const isMe = user?.id === profile.id;

  // Scripts they've written (public ones only).
  const { data: scriptRows } = await supabase
    .from("scripts")
    .select("id, slug, title, logline, genre, visibility")
    .eq("writer_id", profile.id)
    .order("created_at", { ascending: false });
  const scripts = (scriptRows ?? []).filter(
    (s) => (s.visibility ?? "public") !== "private"
  );

  // Roles they've read for (RLS already hides private-script submissions from
  // viewers who can't see them). De-dupe to one entry per (script, role).
  const { data: subRows } = await supabase
    .from("submissions")
    .select("character:characters(name), script:scripts(title, slug)")
    .eq("actor_id", profile.id);
  const seen = new Set<string>();
  const roles = ((subRows as unknown as {
    character: { name: string } | null;
    script: { title: string; slug: string | null } | null;
  }[] | null) ?? [])
    .filter((r) => r.script && r.character)
    .filter((r) => {
      const k = `${r.script!.slug}:${r.character!.name}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  const links = (profile.links ?? {}) as Links;
  const name = profile.display_name || profile.username;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <SiteHeader />

      <section className="mt-12 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
        <div className="h-24 w-24 shrink-0 overflow-hidden rounded-full border border-tan bg-elevated">
          {profile.avatar_url ? (
            <Image
              src={profile.avatar_url}
              alt={name}
              width={96}
              height={96}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center font-slab text-3xl text-taupe">
              {name.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
        <div className="min-w-0">
          <h1 className="font-slab text-3xl leading-tight">{name}</h1>
          <div className="font-mono text-sm text-muted">@{profile.username}</div>
          {profile.bio && <p className="mt-2 max-w-xl text-taupe">{profile.bio}</p>}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            {profile.website && (
              <a
                href={profile.website}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-taupe hover:text-brick"
              >
                <GlobeIcon className="h-4 w-4" />
                Website
              </a>
            )}
            {SOCIALS.map(({ key, Icon, label }) =>
              links[key] ? (
                <a
                  key={key}
                  href={links[key]}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  className="text-taupe hover:text-brick"
                >
                  <Icon className="h-5 w-5" />
                </a>
              ) : null
            )}
            {links.imdb && (
              <a
                href={links.imdb}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded bg-[#f5c518] px-1.5 py-0.5 text-xs font-bold text-black hover:opacity-90"
              >
                IMDb
              </a>
            )}
            {isMe && (
              <Link
                href="/settings/profile"
                className="rounded-lg border border-tan px-3 py-1.5 text-sm text-taupe hover:bg-ivory"
              >
                Edit profile
              </Link>
            )}
          </div>
        </div>
      </section>

      {scripts.length > 0 && (
        <section className="mt-12">
          <h2 className="font-slab text-lg">Scripts</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {scripts.map((s) => (
              <Link
                key={s.id}
                href={`/script/${s.slug ?? s.id}`}
                className="rounded-xl border border-tan bg-ivory p-4 transition-colors hover:bg-elevated"
              >
                <div className="text-xs font-medium text-brick">{s.genre}</div>
                <div className="mt-1 font-slab text-lg">{s.title}</div>
                <p className="mt-1 line-clamp-2 text-sm text-taupe">{s.logline}</p>
              </Link>
            ))}
          </div>
        </section>
      )}

      {roles.length > 0 && (
        <section className="mt-12">
          <h2 className="font-slab text-lg">Roles read</h2>
          <div className="mt-4 divide-y divide-tan">
            {roles.map((r) => (
              <Link
                key={`${r.script!.slug}:${r.character!.name}`}
                href={`/script/${r.script!.slug}`}
                className="flex items-center justify-between py-3 hover:text-brick"
              >
                <span className="font-medium">{r.character!.name}</span>
                <span className="text-sm text-taupe">{r.script!.title} ›</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {scripts.length === 0 && roles.length === 0 && (
        <p className="mt-12 text-muted">No public scripts or roles yet.</p>
      )}
    </main>
  );
}
