"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getBrowserClient } from "@/lib/supabase/client";
import { GENRES } from "@/lib/constants";
import { useRoles } from "@/lib/useRoles";

const input =
  "w-full rounded-lg border border-tan bg-elevated px-4 py-3 outline-none focus:border-brick";
const label = "text-xs font-medium uppercase tracking-wide text-muted";

export default function UploadPage() {
  const router = useRouter();
  const { userId, loading: rolesLoading, has, addRole } = useRoles();
  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState<string>(GENRES[6]); // Drama
  const [logline, setLogline] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError("Choose a screenplay PDF.");
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setError("Please sign in first.");
      setBusy(false);
      return;
    }
    try {
      setStatus("Uploading PDF…");
      const path = `${user.id}/${Date.now()}.pdf`;
      const up = await supabase.storage
        .from("scripts")
        .upload(path, file, { contentType: "application/pdf" });
      if (up.error) throw up.error;

      setStatus("Saving script…");
      const { data: script, error: insErr } = await supabase
        .from("scripts")
        .insert({
          writer_id: user.id,
          title: title.trim(),
          genre,
          logline: logline.trim(),
          file_url: path,
          status: "open",
          submission_deadline: "2099-12-31",
        })
        .select("id")
        .single();
      if (insErr) throw insErr;

      setStatus("Parsing the screenplay…");
      await supabase.functions.invoke("parse-script", { body: { script_id: script.id } });

      router.push(`/script/${script.id}`);
    } catch (e) {
      setBusy(false);
      setStatus("");
      // Supabase Storage/Postgrest errors aren't `Error` instances — pull the
      // message off whatever shape we got so the real reason shows.
      const msg =
        (e as { message?: string; error?: string } | null)?.message ||
        (e as { error?: string } | null)?.error ||
        "Upload failed — please try again.";
      setError(msg);
    }
  }

  if (userId && !rolesLoading && !has("writer")) {
    return (
      <main className="mx-auto w-full max-w-xl px-6 py-16 text-center">
        <h1 className="font-slab text-3xl">Upload a screenplay</h1>
        <p className="mt-3 text-taupe">
          Publishing scripts is for writers — add the Writer role to your profile to upload a screenplay.
        </p>
        <button
          onClick={() => addRole("writer")}
          className="mt-5 rounded-lg bg-brick px-5 py-2.5 font-medium text-white"
        >
          Become a writer
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-10">
      <Link href="/studio" className="text-sm text-taupe hover:text-ink">
        ← Studio
      </Link>
      <h1 className="mt-4 font-slab text-3xl">Upload a screenplay</h1>
      <p className="mt-2 text-taupe">
        We&rsquo;ll parse it into scenes and characters so it can be performed as a table read.
      </p>

      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
        {error && <p className="rounded-lg bg-brick/10 px-3 py-2 text-sm text-brick">{error}</p>}
        <label className="flex flex-col gap-1">
          <span className={label}>Title</span>
          <input required value={title} onChange={(e) => setTitle(e.target.value)} className={input} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={label}>Genre</span>
          <select value={genre} onChange={(e) => setGenre(e.target.value)} className={input}>
            {GENRES.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={label}>Logline</span>
          <textarea
            required
            rows={2}
            value={logline}
            onChange={(e) => setLogline(e.target.value)}
            className={input}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={label}>Screenplay PDF</span>
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm text-taupe file:mr-3 file:rounded-lg file:border file:border-tan file:bg-elevated file:px-4 file:py-2 file:text-sm"
          />
        </label>
        <button
          disabled={busy}
          className="w-full rounded-lg bg-brick px-4 py-3 font-medium text-white disabled:opacity-60"
        >
          {busy ? status || "Working…" : "Upload & parse"}
        </button>
      </form>
    </main>
  );
}
