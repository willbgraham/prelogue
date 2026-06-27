import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SiteHeader } from "@/components/SiteHeader";
import { TableReadPlayer } from "@/components/TableReadPlayer";
import { ReadComments } from "@/components/ReadComments";
import type { ParsedScript, VoiceConfig } from "@/lib/shared";

type ReadScript = {
  id: string;
  slug: string | null;
  title: string;
  logline: string;
  genre: string;
  parsed_json: ParsedScript | null;
  voice_config: VoiceConfig | null;
};

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase
    .from("assembled_reads")
    .select("scripts(title, logline)")
    .eq("id", id)
    .single();
  const s = data?.scripts as unknown as { title: string; logline: string } | { title: string; logline: string }[] | null;
  const script = Array.isArray(s) ? s[0] : s;
  if (!script) return { title: "Prelogue" };
  return { title: `${script.title} — a table read on Prelogue`, description: script.logline };
}

export default async function ReadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: read } = await supabase
    .from("assembled_reads")
    .select(
      "id, script_id, scripts(id, slug, title, logline, genre, parsed_json, voice_config)"
    )
    .eq("id", id)
    .single();
  if (!read) notFound();

  const raw = (read as { scripts: ReadScript | ReadScript[] | null }).scripts;
  const script = Array.isArray(raw) ? raw[0] : raw;
  if (!script) notFound();

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <SiteHeader />

      <div className="mt-10">
        <span className="text-xs font-medium text-brick">{script.genre}</span>
        <h1 className="mt-1 font-slab text-4xl leading-tight">{script.title}</h1>
        <p className="mt-3 text-taupe">{script.logline}</p>
        <Link
          href={`/script/${script.slug ?? script.id}`}
          className="mt-2 inline-block text-sm text-muted hover:text-brick"
        >
          View script + roles →
        </Link>
      </div>

      <div className="mt-6">
        <TableReadPlayer
          scriptId={script.id}
          parsed={script.parsed_json}
          voiceConfig={script.voice_config}
        />
      </div>

      <section className="mt-10">
        <h2 className="font-slab text-lg">Comments</h2>
        <ReadComments readId={id} />
      </section>
    </main>
  );
}
