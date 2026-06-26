"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";

const input =
  "w-full rounded-lg border border-tan bg-elevated px-4 py-2.5 outline-none focus:border-brick";
const label = "text-xs font-medium uppercase tracking-wide text-muted";

type Form = {
  display_name: string;
  username: string;
  bio: string;
  website: string;
  avatar_url: string;
  x: string;
  instagram: string;
  tiktok: string;
  youtube: string;
};

const EMPTY: Form = {
  display_name: "",
  username: "",
  bio: "",
  website: "",
  avatar_url: "",
  x: "",
  instagram: "",
  tiktok: "",
  youtube: "",
};

export default function EditProfilePage() {
  const router = useRouter();
  const supabase = getBrowserClient();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push("/sign-in?next=/settings/profile");
        return;
      }
      setUserId(user.id);
      const { data } = await supabase
        .from("users")
        .select("display_name, username, bio, website, avatar_url, links")
        .eq("id", user.id)
        .single();
      if (data) {
        const links = (data.links ?? {}) as Record<string, string>;
        setForm({
          display_name: data.display_name ?? "",
          username: data.username ?? "",
          bio: data.bio ?? "",
          website: data.website ?? "",
          avatar_url: data.avatar_url ?? "",
          x: links.x ?? "",
          instagram: links.instagram ?? "",
          tiktok: links.tiktok ?? "",
          youtube: links.youtube ?? "",
        });
      }
      setLoading(false);
    })();
  }, [router, supabase]);

  async function onAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !userId) return;
    setUploading(true);
    setError(null);
    try {
      const ext = file.name.split(".").pop() || "jpg";
      const path = `${userId}/avatar-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("avatars")
        .upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) throw upErr;
      const { data } = supabase.storage.from("avatars").getPublicUrl(path);
      setForm((f) => ({ ...f, avatar_url: data.publicUrl }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!userId) return;
    const username = form.username
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!username) {
      setError("Pick a username.");
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    const { error } = await supabase
      .from("users")
      .update({
        display_name: form.display_name.trim(),
        username,
        bio: form.bio.trim() || null,
        website: form.website.trim() || null,
        avatar_url: form.avatar_url || null,
        links: {
          x: form.x.trim(),
          instagram: form.instagram.trim(),
          tiktok: form.tiktok.trim(),
          youtube: form.youtube.trim(),
        },
      })
      .eq("id", userId);
    setSaving(false);
    if (error) {
      setError(
        error.message.toLowerCase().includes("duplicate")
          ? "That username is already taken."
          : error.message
      );
      return;
    }
    setSaved(true);
    setForm((f) => ({ ...f, username }));
    router.refresh();
  }

  if (loading) {
    return <main className="mx-auto max-w-xl px-6 py-16 text-taupe">Loading…</main>;
  }

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-10">
      <Link href={`/u/${form.username}`} className="text-sm text-taupe hover:text-ink">
        ← View profile
      </Link>
      <h1 className="mt-6 font-slab text-3xl">Edit profile</h1>

      <form onSubmit={onSave} className="mt-8 flex flex-col gap-5">
        {error && (
          <p className="rounded-lg bg-brick/10 px-3 py-2 text-sm text-brick">{error}</p>
        )}
        {saved && (
          <p className="rounded-lg bg-forest/10 px-3 py-2 text-sm text-forest">Saved.</p>
        )}

        <div className="flex items-center gap-4">
          <div className="h-20 w-20 shrink-0 overflow-hidden rounded-full border border-tan bg-elevated">
            {form.avatar_url ? (
              <Image
                src={form.avatar_url}
                alt="avatar"
                width={80}
                height={80}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center font-slab text-2xl text-taupe">
                {(form.display_name || "?").charAt(0).toUpperCase()}
              </div>
            )}
          </div>
          <label className="cursor-pointer rounded-lg border border-tan px-4 py-2 text-sm text-taupe hover:bg-ivory">
            {uploading ? "Uploading…" : "Change photo"}
            <input type="file" accept="image/*" onChange={onAvatar} className="hidden" />
          </label>
        </div>

        <label className="flex flex-col gap-1">
          <span className={label}>Name</span>
          <input value={form.display_name} onChange={set("display_name")} className={input} required />
        </label>
        <label className="flex flex-col gap-1">
          <span className={label}>Username (your URL: /u/your-name)</span>
          <input value={form.username} onChange={set("username")} className={input} required />
        </label>
        <label className="flex flex-col gap-1">
          <span className={label}>Bio</span>
          <textarea value={form.bio} onChange={set("bio")} rows={3} className={input} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={label}>Website</span>
          <input value={form.website} onChange={set("website")} placeholder="https://" className={input} />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className={label}>X (Twitter) URL</span>
            <input value={form.x} onChange={set("x")} placeholder="https://x.com/…" className={input} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>Instagram URL</span>
            <input value={form.instagram} onChange={set("instagram")} placeholder="https://instagram.com/…" className={input} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>TikTok URL</span>
            <input value={form.tiktok} onChange={set("tiktok")} placeholder="https://tiktok.com/@…" className={input} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>YouTube URL</span>
            <input value={form.youtube} onChange={set("youtube")} placeholder="https://youtube.com/@…" className={input} />
          </label>
        </div>

        <button
          disabled={saving || uploading}
          className="rounded-lg bg-brick px-5 py-3 font-medium text-white disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save profile"}
        </button>
      </form>
    </main>
  );
}
