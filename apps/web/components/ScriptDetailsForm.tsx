"use client";

import { useState } from "react";
import Image from "next/image";
import { getBrowserClient } from "@/lib/supabase/client";
import { FORMATS, AGE_RATINGS, LISTING_STATUSES } from "@/lib/constants";

const input =
  "w-full rounded-lg border border-tan bg-elevated px-4 py-3 outline-none focus:border-brick";
const label = "text-xs font-medium uppercase tracking-wide text-muted";

export type ScriptDetailsValues = {
  cover_image_url?: string | null;
  synopsis?: string | null;
  format?: string | null;
  age_rating?: string | null;
  listing_status?: string | null;
  more_details?: string | null;
};

/**
 * Shared listing-metadata fields (poster, synopsis, format, age rating, status,
 * more details) used by both the upload form and the studio details editor.
 * Fully controlled — the parent owns `values` and applies `onChange` patches.
 * The poster uploads to the public `avatars` bucket (same as mobile covers) and
 * stores the resulting public URL, so it renders on public pages without signing.
 */
export function ScriptDetailsForm({
  userId,
  values,
  onChange,
}: {
  userId: string;
  values: ScriptDetailsValues;
  onChange: (patch: Partial<ScriptDetailsValues>) => void;
}) {
  const supabase = getBrowserClient();
  const [posterBusy, setPosterBusy] = useState(false);
  const [posterErr, setPosterErr] = useState<string | null>(null);

  async function onPoster(file: File | null) {
    if (!file) return;
    setPosterBusy(true);
    setPosterErr(null);
    try {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${userId}/poster-${Date.now()}.${ext}`;
      const up = await supabase.storage
        .from("avatars")
        .upload(path, file, { contentType: file.type || "image/jpeg", upsert: true });
      if (up.error) throw up.error;
      const { data } = supabase.storage.from("avatars").getPublicUrl(path);
      onChange({ cover_image_url: data.publicUrl });
    } catch (e) {
      setPosterErr((e as { message?: string })?.message ?? "Couldn't upload the poster.");
    } finally {
      setPosterBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Poster */}
      <div className="flex gap-4">
        <div className="relative h-40 w-[6.75rem] shrink-0 overflow-hidden rounded-lg border border-tan bg-elevated">
          {values.cover_image_url ? (
            <Image
              src={values.cover_image_url}
              alt="Poster"
              fill
              sizes="108px"
              className="object-cover"
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center px-2 text-center text-[10px] text-muted">
              2:3 poster
            </span>
          )}
        </div>
        <div className="flex flex-col justify-center gap-1">
          <span className={label}>Poster image</span>
          <p className="text-xs text-muted">Portrait key art (2:3). Shows on the script page and in Discover.</p>
          <label className="mt-1 inline-flex w-fit cursor-pointer items-center rounded-lg border border-tan bg-elevated px-3 py-1.5 text-sm hover:bg-ivory">
            {posterBusy ? "Uploading…" : values.cover_image_url ? "Replace poster" : "Upload poster"}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              disabled={posterBusy}
              onChange={(e) => onPoster(e.target.files?.[0] ?? null)}
            />
          </label>
          {posterErr && <span className="text-xs text-brick">{posterErr}</span>}
        </div>
      </div>

      {/* Status + Format + Age rating */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className={label}>Status</span>
          <select
            value={values.listing_status ?? ""}
            onChange={(e) => onChange({ listing_status: e.target.value || null })}
            className={input}
          >
            <option value="">Not set</option>
            {LISTING_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={label}>Format</span>
          <select
            value={values.format ?? ""}
            onChange={(e) => onChange({ format: e.target.value || null })}
            className={input}
          >
            <option value="">Not set</option>
            {FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={label}>Age rating</span>
          <select
            value={values.age_rating ?? ""}
            onChange={(e) => onChange({ age_rating: e.target.value || null })}
            className={input}
          >
            <option value="">Not set</option>
            {AGE_RATINGS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Synopsis */}
      <label className="flex flex-col gap-1">
        <span className={label}>Synopsis</span>
        <textarea
          rows={4}
          value={values.synopsis ?? ""}
          onChange={(e) => onChange({ synopsis: e.target.value })}
          placeholder="A fuller summary than the logline — the story, the stakes, the world."
          className={input}
        />
      </label>

      {/* More details */}
      <label className="flex flex-col gap-1">
        <span className={label}>More details</span>
        <textarea
          rows={4}
          value={values.more_details ?? ""}
          onChange={(e) => onChange({ more_details: e.target.value })}
          placeholder="Accolades, coverage, comps, what you're looking for (a manager, financing, a director)…"
          className={input}
        />
      </label>
    </div>
  );
}
