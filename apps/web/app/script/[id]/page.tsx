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
import { RequestListen } from "@/components/RequestListen";
import { ListenRequests } from "@/components/ListenRequests";
import { InvitedToRead } from "@/components/InvitedToRead";
import type { Script, Character } from "@/lib/shared";
import { labelOf, LISTING_STATUSES, FORMATS, AGE_RATINGS } from "@/lib/constants";

// A script URL handle is either a name slug (new) or a uuid (legacy links).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scriptCol = (handle: string) => (UUID_RE.test(handle) ? "id" : "slug");

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: direct } = await supabase
    .from("scripts")
    .select("title, logline, synopsis, cover_image_url")
    .eq(scriptCol(id), id)
    .single();
  // Gated showcase scripts are RLS-private; their public card comes via RPC.
  let data = direct;
  if (!data) {
    const { data: listing } = await supabase.rpc("get_script_listing", { p_handle: id });
    data = (Array.isArray(listing) ? listing[0] : listing) ?? null;
  }
  if (!data) return { title: "Prelogue Studio" };
  const description = (data.synopsis as string | null) || data.logline;
  return {
    title: `${data.title} - Prelogue Studio`,
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

  // RLS: a private script the viewer can't see returns no row. For a gated
  // showcase script that's expected — fall back to its public listing card
  // (poster/logline/writer) with a request-access flow. Anything else → 404.
  const { data: script } = await supabase
    .from("scripts")
    .select(
      "id, slug, title, logline, genre, visibility, listen_gated, full_read_unlocked, parsed_json, voice_config, ambience_config, writer_id, cover_image_url, synopsis, more_details, listing_status, format, page_count, age_rating, copyright_reg_number, rating_avg, rating_count"
    )
    .eq(scriptCol(id), id)
    .single();
  if (!script) {
    const { data: listingRows } = await supabase.rpc("get_script_listing", { p_handle: id });
    const l = (Array.isArray(listingRows) ? listingRows[0] : listingRows) as
      | {
          id: string;
          slug: string | null;
          title: string;
          genre: string;
          logline: string;
          synopsis: string | null;
          cover_image_url: string | null;
          page_count: number | null;
          format: string | null;
          listing_status: string | null;
          writer_id: string;
          writer_name: string;
          writer_username: string | null;
          writer_avatar: string | null;
        }
      | null
      | undefined;
    if (!l) notFound();
    const lStatus = labelOf(LISTING_STATUSES, l.listing_status);
    const lFormat = labelOf(FORMATS, l.format);
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-10">
        <SiteHeader />
        <div className="mt-8">
          <Link href="/discover" className="text-sm text-taupe hover:text-ink">
            ← Discover
          </Link>
        </div>

        <div className="mt-6 flex gap-5">
          {l.cover_image_url && (
            <div className="relative h-48 w-32 shrink-0 overflow-hidden rounded-xl border border-tan bg-elevated sm:h-56 sm:w-[9.5rem]">
              <Image
                src={l.cover_image_url}
                alt=""
                fill
                sizes="(min-width: 640px) 152px, 128px"
                className="object-cover"
              />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-brick">{l.genre}</span>
              <span className="rounded-full border border-brick/30 bg-brick/5 px-2.5 py-0.5 text-xs font-medium text-brick">
                🔒 Listen by request
              </span>
              {lStatus && (
                <span className="rounded-full border border-tan px-2.5 py-0.5 text-xs font-medium text-muted">
                  {lStatus}
                </span>
              )}
            </div>
            <h1 className="mt-1 font-slab text-4xl leading-tight">{l.title}</h1>
            <p className="mt-3 text-taupe">{l.logline}</p>
            <div className="mt-3 flex items-center gap-2">
              <span className="h-7 w-7 overflow-hidden rounded-full border border-tan bg-elevated">
                {l.writer_avatar ? (
                  <Image
                    src={l.writer_avatar}
                    alt={l.writer_name}
                    width={28}
                    height={28}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-xs text-taupe">
                    {(l.writer_name || "?").charAt(0).toUpperCase()}
                  </span>
                )}
              </span>
              {l.writer_username ? (
                <Link href={`/u/${l.writer_username}`} className="text-sm text-muted hover:text-brick">
                  by {l.writer_name}
                </Link>
              ) : (
                <span className="text-sm text-muted">by {l.writer_name}</span>
              )}
            </div>
            {(lFormat || l.page_count) && (
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
                {lFormat && <span>{lFormat}</span>}
                {l.page_count ? <span>{l.page_count} pages</span> : null}
              </div>
            )}
          </div>
        </div>

        {l.synopsis && (
          <p className="mt-5 whitespace-pre-line leading-relaxed text-ink/90">{l.synopsis}</p>
        )}

        <RequestListen
          scriptId={l.id}
          scriptSlug={l.slug}
          scriptTitle={l.title}
          writerId={l.writer_id}
          writerName={l.writer_name}
        />
      </main>
    );
  }

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
          title={`${(script as Script).title} - Prelogue Studio`}
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
          <OwnerUnlock
            scriptId={s.id}
            unlocked={!!s.full_read_unlocked}
            pageCount={s.page_count}
          />
          <OwnerPanel
            scriptId={s.id}
            initialVisibility={(s.visibility ?? "public") as "public" | "hidden" | "private"}
            initialListenGated={!!s.listen_gated}
          />
          {s.listen_gated && (
            <ListenRequests scriptId={s.id} scriptSlug={s.slug ?? null} scriptTitle={s.title} />
          )}
          <div className="mt-4 flex justify-end">
            <DeleteScriptButton scriptId={s.id} title={s.title} />
          </div>
        </div>
      )}

      {user?.id !== s.writer_id && <InvitedToRead scriptId={s.id} />}

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
          ambience={(script as Script).ambience_config ?? null}
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
