"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";
import { GENRES } from "@/lib/constants";
import { ScriptDetailsForm, type ScriptDetailsValues } from "@/components/ScriptDetailsForm";

const input =
  "w-full rounded-lg border border-tan bg-elevated px-4 py-3 outline-none focus:border-brick";
const label = "text-xs font-medium uppercase tracking-wide text-muted";

export default function ScriptDetailsPage() {
  const { scriptId } = useParams<{ scriptId: string }>();
  const router = useRouter();
  const supabase = getBrowserClient();

  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState<string>("Drama");
  const [logline, setLogline] = useState("");
  const [pageCount, setPageCount] = useState<string>("");
  const [details, setDetails] = useState<ScriptDetailsValues>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.push(`/sign-in?next=/studio/${scriptId}/details`);
      return;
    }
    setUserId(user.id);
    const { data: s } = await supabase
      .from("scripts")
      .select(
        "title, genre, logline, writer_id, cover_image_url, synopsis, more_details, format, age_rating, listing_status, page_count, copyright_reg_number"
      )
      .eq("id", scriptId)
      .single();
    if (!s || s.writer_id !== user.id) {
      router.push("/studio");
      return;
    }
    setTitle(s.title ?? "");
    setGenre(s.genre ?? "Drama");
    setLogline(s.logline ?? "");
    setPageCount(s.page_count != null ? String(s.page_count) : "");
    setDetails({
      cover_image_url: s.cover_image_url,
      synopsis: s.synopsis,
      more_details: s.more_details,
      format: s.format,
      age_rating: s.age_rating,
      listing_status: s.listing_status,
      copyright_reg_number: s.copyright_reg_number,
    });
    setLoading(false);
  }, [scriptId, router, supabase]);

  useEffect(() => {
    load();
  }, [load]);

  const touch = () => {
    setDirty(true);
    setSaved(false);
  };

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const pc = pageCount.trim() === "" ? null : Math.max(0, parseInt(pageCount, 10) || 0);
      // No .select() → no RETURNING → avoids re-running the private-view-guard.
      const { error: upErr } = await supabase
        .from("scripts")
        .update({
          title: title.trim(),
          genre,
          logline: logline.trim(),
          cover_image_url: details.cover_image_url ?? null,
          synopsis: details.synopsis?.trim() || null,
          more_details: details.more_details?.trim() || null,
          format: details.format || null,
          age_rating: details.age_rating || null,
          listing_status: details.listing_status || null,
          copyright_reg_number: details.copyright_reg_number?.trim() || null,
          page_count: pc,
        })
        .eq("id", scriptId);
      if (upErr) throw upErr;
      setDirty(false);
      setSaved(true);
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Couldn't save — please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <main className="mx-auto max-w-2xl px-6 py-16 text-taupe">Loading…</main>;
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      <div className="flex items-center justify-between gap-3">
        <Link href={`/studio/${scriptId}`} className="text-sm text-taupe hover:text-ink">
          ← Casting
        </Link>
        <div className="flex items-center gap-3">
          {saved && !dirty && <span className="text-sm text-green-700">Saved ✓</span>}
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <h1 className="mt-5 font-slab text-3xl">Script details</h1>
      <p className="mt-2 text-sm text-taupe">
        How your script appears in Discover and on its page — poster, synopsis, status, and more.
      </p>
      {error && <p className="mt-3 rounded-lg bg-brick/10 px-3 py-2 text-sm text-brick">{error}</p>}

      <div className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className={label}>Title</span>
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              touch();
            }}
            className={input}
          />
        </label>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className={label}>Genre</span>
            <select
              value={genre}
              onChange={(e) => {
                setGenre(e.target.value);
                touch();
              }}
              className={input}
            >
              {GENRES.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>Pages</span>
            <input
              type="number"
              min={0}
              value={pageCount}
              onChange={(e) => {
                setPageCount(e.target.value);
                touch();
              }}
              placeholder="Auto-filled from the PDF"
              className={input}
            />
          </label>
        </div>

        <label className="flex flex-col gap-1">
          <span className={label}>Logline</span>
          <textarea
            rows={2}
            value={logline}
            onChange={(e) => {
              setLogline(e.target.value);
              touch();
            }}
            className={input}
          />
        </label>

        {userId && (
          <ScriptDetailsForm
            userId={userId}
            values={details}
            onChange={(patch) => {
              setDetails((v) => ({ ...v, ...patch }));
              touch();
            }}
          />
        )}
      </div>

      <div className="mt-8 flex items-center justify-end gap-3 border-t border-tan pt-5">
        {dirty && <span className="text-sm text-taupe">Unsaved changes</span>}
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="rounded-lg bg-brick px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save details"}
        </button>
      </div>
    </main>
  );
}
