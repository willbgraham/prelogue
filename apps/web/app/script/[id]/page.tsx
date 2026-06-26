import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { TableReadPlayer } from "@/components/TableReadPlayer";
import { OwnerUnlock } from "@/components/OwnerUnlock";
import { ShareButton } from "@/components/ShareButton";
import { ReadForRole } from "@/components/ReadForRole";
import type { Script, Character } from "@/lib/shared";

// A script URL handle is either a name slug (new) or a uuid (legacy links).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scriptCol = (handle: string) => (UUID_RE.test(handle) ? "id" : "slug");

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase
    .from("scripts")
    .select("title, logline")
    .eq(scriptCol(id), id)
    .single();
  if (!data) return { title: "Prelogue" };
  return { title: `${data.title} — Prelogue`, description: data.logline };
}

export default async function ScriptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  // RLS: a private script the viewer can't see returns no row → 404.
  const { data: script } = await supabase
    .from("scripts")
    .select("id, slug, title, logline, genre, full_read_unlocked, parsed_json, voice_config, writer_id")
    .eq(scriptCol(id), id)
    .single();
  if (!script) notFound();

  // Canonicalize the URL to the name-based slug (a uuid or stale handle → slug),
  // so visitors always see the name, not the numbers.
  const slug = (script as Script).slug;
  if (slug && id !== slug) {
    redirect(`/script/${slug}`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: writer } = await supabase
    .from("users")
    .select("display_name, username")
    .eq("id", (script as Script).writer_id)
    .single();

  const { data: characters } = await supabase
    .from("characters")
    .select("id, name, line_count")
    .eq("script_id", (script as Script).id)
    .order("line_count", { ascending: false });

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="flex items-center justify-between gap-3">
        <Link href="/" className="text-sm text-taupe hover:text-ink">
          ← Prelogue
        </Link>
        <ShareButton
          title={`${(script as Script).title} — Prelogue`}
          url={`https://prelogue.studio/script/${(script as Script).slug ?? (script as Script).id}`}
        />
      </div>

      <div className="mt-6">
        <span className="text-xs font-medium text-brick">{(script as Script).genre}</span>
        <h1 className="mt-1 font-slab text-4xl leading-tight">{(script as Script).title}</h1>
        <p className="mt-3 text-taupe">{(script as Script).logline}</p>
        {writer?.username && (
          <Link
            href={`/u/${writer.username}`}
            className="mt-2 inline-block text-sm text-muted hover:text-brick"
          >
            by {writer.display_name || writer.username}
          </Link>
        )}
      </div>

      <div className="mt-6">
        <ReadForRole
          characters={((characters as Pick<Character, "id" | "name" | "line_count">[] | null) ?? [])}
        />
      </div>

      <div className="mt-6">
        <TableReadPlayer
          scriptId={(script as Script).id}
          parsed={(script as Script).parsed_json}
          voiceConfig={(script as Script).voice_config}
          canChangeVoices={
            (script as Script).slug === "booth-nine" ||
            user?.id === (script as Script).writer_id
          }
        />
      </div>

      {user?.id === (script as Script).writer_id && (
        <OwnerUnlock scriptId={(script as Script).id} unlocked={!!(script as Script).full_read_unlocked} />
      )}
    </main>
  );
}
