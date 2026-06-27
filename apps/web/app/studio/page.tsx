import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { Script } from "@/lib/shared";

export default async function StudioPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data } = user
    ? await supabase
        .from("scripts")
        .select("id, title, genre, full_read_unlocked")
        .eq("writer_id", user.id)
        .order("created_at", { ascending: false })
    : { data: [] };
  const scripts = (data as Script[] | null) ?? [];

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="flex items-center justify-between">
        <Link href="/" className="font-slab text-xl">
          Prelogue
        </Link>
        <Link
          href="/studio/upload"
          className="rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white"
        >
          Upload
        </Link>
      </div>

      <h1 className="mt-8 font-slab text-3xl">Your scripts</h1>
      <div className="mt-4 divide-y divide-tan">
        {scripts.map((s) => (
          <div key={s.id} className="flex items-center justify-between gap-3 py-4">
            <Link href={`/script/${s.id}`} className="min-w-0 flex-1">
              <div className="font-slab text-lg">{s.title}</div>
              <div className="text-sm text-taupe">
                {s.genre} · {s.full_read_unlocked ? "Unlocked" : "Preview"}
              </div>
            </Link>
            <Link
              href={`/studio/${s.id}`}
              className="shrink-0 rounded-lg border border-tan px-3 py-1.5 text-sm font-medium text-taupe hover:bg-elevated"
            >
              Cast ›
            </Link>
          </div>
        ))}
        {scripts.length === 0 && (
          <p className="py-8 text-taupe">
            No scripts yet.{" "}
            <Link href="/studio/upload" className="text-ink underline">
              Upload your first.
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}
