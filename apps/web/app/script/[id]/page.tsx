import Link from "next/link";
import Image from "next/image";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { TableReadPlayer } from "@/components/TableReadPlayer";
import { OwnerUnlock } from "@/components/OwnerUnlock";
import { OwnerPanel } from "@/components/OwnerPanel";
import { ShareButton } from "@/components/ShareButton";
import { ReadForRole } from "@/components/ReadForRole";
import { ScriptLiveReadings } from "@/components/ScriptLiveReadings";
import { ScriptCast } from "@/components/ScriptCast";
import { SiteHeader } from "@/components/SiteHeader";
import { StarRating } from "@/components/StarRating";
import { DeleteScriptButton } from "@/components/DeleteScriptButton";
import type { Script, Character } from "@/lib/shared";
import { labelOf, LISTING_STATUSES, FORMATS, AGE_RATINGS } from "@/lib/constants";

// A script URL handle is either a name slug (new) or a uuid (legacy links).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scriptCol = (handle: string) => (UUID_RE.test(handle) ? "id" : "slug");

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase
    .from("scripts")
    .select("title, logline, synopsis, cover_image_url")
    .eq(scriptCol(id), id)
    .single();
  if (!data) return { title: "Prelogue" };
  const description = (data.synopsis as string | null) || data.logline;
  return {
    title: `${data.title} - Prelogue`,
    description,
    openGraph: {
      title: data.title as string,
      description,
      ...(data.cover_image_url ? { images: [data.cover_image_url as string] } : {}),
    },
  };
}

export default async function ScriptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  // RLS: a private script the viewer can't see returns no row → 404.
  const { data: script } = await supabase
    .from("scripts")
    .select(
      "id, slug, title, logline, genre, visibility, full_read_unlocked, parsed_json, voice_config, writer_id, cover_image_url, synopsis, more_details, listing_status, format, page_count, age_rating, copyright_reg_number, rating_avg, rating_count"
    )
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
    .select("id, name, line_count, description")
    .eq("script_id", (script as Script).id)
    .order("line_count", { ascending: false });

  const s = script as Script;
  const statusLabel = labelOf(LISTING_STATUSES, s.listing_status);
  const formatLabel = labelOf(FORMATS, s.format);
  const ageLabel = labelOf(AGE_RATINGS, s.age_rating);

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <SiteHeader />
      <div className="mt-8 flex items-center justify-between gap-3">
        <Link href="/discover" className="text-sm text-taupe hover:text-ink">
          ← Discover
        </Link>
        <ShareButton
          title={`${(script as Script).title} — Prelogue`}
          url={`https://prelogue.studio/script/${(script as Script).slug ?? (script as Script).id}`}
        />
      </div>

      <div className="mt-6 flex gap-5">
        {s.cover_image_url && (
          <div className="relative h-48 w-32 shrink-0 overflow-hidden rounded-xl border border-tan bg-elevated sm:h-56 sm:w-[9.5rem]">
            <Image
              src={s.cover_image_url}
              alt=""
              fill
              sizes="(min-width: 640px) 152px, 128px"
              className="object-cover"
            />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-brick">{s.genre}</span>
            {statusLabel && (
              <span className="rounded-full border border-brick/30 bg-brick/5 px-2.5 py-0.5 text-xs font-medium text-brick">
                {statusLabel}
              </span>
            )}
          </div>
          <h1 className="mt-1 font-slab text-4xl leading-tight">{s.title}</h1>
          <p className="mt-3 text-taupe">{s.logline}</p>
          {writer?.username && (
            <Link
              href={`/u/${writer.username}`}
              className="mt-2 inline-block text-sm text-muted hover:text-brick"
            >
              by {writer.display_name || writer.username}
            </Link>
          )}
          {(formatLabel || s.page_count || ageLabel) && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
              {formatLabel && <span>{formatLabel}</span>}
              {s.page_count ? <span>{s.page_count} pages</span> : null}
              {ageLabel && <span>Rated {ageLabel}</span>}
            </div>
          )}
          {s.copyright_reg_number && (
            <div className="mt-2 text-xs text-muted">
              <span className="font-medium">Copyright:</span> {s.copyright_reg_number}
            </div>
          )}
        </div>
      </div>

      {s.synopsis && (
        <p className="mt-5 whitespace-pre-line leading-relaxed text-ink/90">{s.synopsis}</p>
      )}

      <div className="mt-4">
        <StarRating
          scriptId={s.id}
          initialAvg={Number(s.rating_avg ?? 0)}
          initialCount={s.rating_count ?? 0}
        />
      </div>

      <ScriptCast
        scriptId={s.id}
        characters={
          (characters as { id: string; name: string; description?: string | null }[] | null) ?? []
        }
        voiceConfig={s.voice_config}
      />

      {user?.id === s.writer_id && (
        <div className="mt-6">
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/studio/${s.id}/details`}
              className="rounded-lg border border-brick px-4 py-2 text-sm font-medium text-brick hover:bg-brick/5"
            >
              Edit details →
            </Link>
            <Link
              href={`/studio/${s.id}/lines`}
              className="rounded-lg border border-brick px-4 py-2 text-sm font-medium text-brick hover:bg-brick/5"
            >
              ✏️ Edit lines →
            </Link>
            <Link
              href={`/studio/${s.id}`}
              className="rounded-lg border border-tan px-4 py-2 text-sm font-medium text-taupe hover:bg-elevated"
            >
              Manage casting &amp; voices →
            </Link>
            <Link
              href={`/studio/${s.id}/live`}
              className="rounded-lg border border-brick px-4 py-2 text-sm font-medium text-brick hover:bg-brick/5"
            >
              Live readings →
            </Link>
          </div>
          <OwnerUnlock scriptId={s.id} unlocked={!!s.full_read_unlocked} />
          <OwnerPanel
            scriptId={s.id}
            initialVisibility={(s.visibility ?? "public") as "public" | "hidden" | "private"}
            unlocked={!!s.full_read_unlocked}
          />
          <div className="mt-4 flex justify-end">
            <DeleteScriptButton scriptId={s.id} title={s.title} />
          </div>
        </div>
      )}

      <div className="mt-6">
        <ReadForRole
          characters={
            (characters as Pick<Character, "id" | "name" | "line_count" | "description">[] | null) ??
            []
          }
        />
      </div>

      <ScriptLiveReadings
        scriptId={s.id}
        characters={(characters as { id: string; name: string }[] | null) ?? []}
      />

      <div className="mt-6">
        <TableReadPlayer
          scriptId={(script as Script).id}
          parsed={(script as Script).parsed_json}
          voiceConfig={(script as Script).voice_config}
          canChangeVoices={
            (script as Script).slug === "booth-nine" ||
            user?.id === (script as Script).writer_id
          }
          isOwner={user?.id === (script as Script).writer_id}
        />
      </div>

      {s.more_details && (
        <div className="mt-8">
          <h2 className="font-slab text-lg">More details</h2>
          <p className="mt-2 whitespace-pre-line leading-relaxed text-ink/90">{s.more_details}</p>
        </div>
      )}
    </main>
  );
}
