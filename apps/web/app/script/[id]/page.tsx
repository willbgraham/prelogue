import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { TableReadPlayer } from "@/components/TableReadPlayer";
import { OwnerUnlock } from "@/components/OwnerUnlock";
import { ShareButton } from "@/components/ShareButton";
import { ReadForRole } from "@/components/ReadForRole";
import type { Script, Character } from "@/lib/shared";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase.from("scripts").select("title, logline").eq("id", id).single();
  if (!data) return { title: "Prelogue" };
  return { title: `${data.title} — Prelogue`, description: data.logline };
}

export default async function ScriptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  // RLS: a private script the viewer can't see returns no row → 404.
  const { data: script } = await supabase
    .from("scripts")
    .select("id, title, logline, genre, full_read_unlocked, parsed_json, voice_config, writer_id")
    .eq("id", id)
    .single();
  if (!script) notFound();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: characters } = await supabase
    .from("characters")
    .select("id, name, line_count")
    .eq("script_id", id)
    .order("line_count", { ascending: false });

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="flex items-center justify-between gap-3">
        <Link href="/" className="text-sm text-taupe hover:text-ink">
          ← Prelogue
        </Link>
        <ShareButton
          title={`${(script as Script).title} — Prelogue`}
          url={`https://prelogue.studio/script/${id}`}
        />
      </div>

      <div className="mt-6">
        <span className="text-xs font-medium text-brick">{(script as Script).genre}</span>
        <h1 className="mt-1 font-slab text-4xl leading-tight">{(script as Script).title}</h1>
        <p className="mt-3 text-taupe">{(script as Script).logline}</p>
      </div>

      <div className="mt-6">
        <ReadForRole
          characters={((characters as Pick<Character, "id" | "name" | "line_count">[] | null) ?? [])}
        />
      </div>

      <div className="mt-6">
        <TableReadPlayer
          scriptId={id}
          parsed={(script as Script).parsed_json}
          voiceConfig={(script as Script).voice_config}
        />
      </div>

      {user?.id === (script as Script).writer_id && (
        <OwnerUnlock scriptId={id} unlocked={!!(script as Script).full_read_unlocked} />
      )}
    </main>
  );
}
