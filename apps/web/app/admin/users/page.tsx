"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";

type ScriptRow = {
  id: string;
  slug: string | null;
  title: string;
  visibility: string | null;
  full_read_unlocked: boolean;
  page_count: number | null;
  created_at: string;
};
type Person = {
  id: string;
  email: string | null;
  display_name: string;
  roles: string[];
  is_admin: boolean;
  scripts: number;
  unlocked_scripts: number;
  scripts_list: ScriptRow[];
  created_at: string | null;
  last_sign_in_at: string | null;
};

const HOUSE_ID = "e13e3e11-e65a-4318-a96a-384b442f113a";
const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString() : "—");

export default function AdminUsersPage() {
  const supabase = getBrowserClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.push("/sign-in?next=/admin/users");
      return;
    }
    const { data: me } = await supabase.from("users").select("is_admin").eq("id", user.id).single();
    if (!me?.is_admin) {
      router.push("/");
      return;
    }
    setAllowed(true);
    const { data, error: fnErr } = await supabase.functions.invoke("admin-users", { body: {} });
    if ((data as { error?: string } | null)?.error || fnErr) {
      setError((data as { error?: string } | null)?.error ?? fnErr?.message ?? "Couldn't load users.");
    } else {
      setPeople((data as { users?: Person[] } | null)?.users ?? []);
    }
    setLoading(false);
  }, [router, supabase]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <main className="mx-auto max-w-5xl px-6 py-16 text-taupe">Loading…</main>;
  if (!allowed) return null;

  // Real signups (drop the house account), and who has actually uploaded.
  const realPeople = people.filter((p) => p.id !== HOUSE_ID);
  const emails = realPeople.map((p) => p.email).filter(Boolean) as string[];
  const writerEmails = realPeople.filter((p) => p.scripts > 0 && p.email).map((p) => p.email!) as string[];

  const copy = async (list: string[]) => {
    await navigator.clipboard.writeText(list.join(", "));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <Link href="/admin/users" className="font-medium text-brick">People</Link>
        <Link href="/admin/moderation" className="text-taupe hover:text-brick">Moderation</Link>
        <Link href="/admin/live" className="text-taupe hover:text-brick">Live readings</Link>
        <Link href="/admin/renders" className="text-taupe hover:text-brick">Daily renders</Link>
      </div>

      <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-slab text-3xl">People</h1>
          <p className="mt-1 text-sm text-taupe">
            {realPeople.length} signups · {writerEmails.length} have uploaded a script.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => copy(writerEmails)}
            disabled={!writerEmails.length}
            className="rounded-lg border border-brick px-3 py-1.5 text-sm font-medium text-brick hover:bg-brick/5 disabled:opacity-50"
          >
            Copy writer emails ({writerEmails.length})
          </button>
          <button
            onClick={() => copy(emails)}
            disabled={!emails.length}
            className="rounded-lg border border-tan px-3 py-1.5 text-sm font-medium text-taupe hover:bg-elevated disabled:opacity-50"
          >
            Copy all emails ({emails.length})
          </button>
          <a
            href={`mailto:?bcc=${encodeURIComponent(writerEmails.join(","))}`}
            className="rounded-lg bg-brick px-3 py-1.5 text-sm font-medium text-white"
          >
            Email writers
          </a>
        </div>
      </div>
      {copied && <p className="mt-2 text-sm text-forest">Copied to clipboard ✓</p>}
      {error && <p className="mt-2 text-sm text-brick">{error}</p>}

      <div className="mt-6 overflow-hidden rounded-xl border border-tan bg-ivory">
        <div className="hidden grid-cols-[1fr_1.4fr_auto_auto_auto] gap-3 border-b border-tan px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted sm:grid">
          <span>Name</span>
          <span>Email</span>
          <span className="text-center">Scripts</span>
          <span>Joined</span>
          <span>Last seen</span>
        </div>
        {realPeople.map((p) => {
          const theirs = p.scripts_list ?? [];
          const expanded = open === p.id;
          return (
            <div key={p.id} className="border-b border-tan/60 last:border-0">
              <button
                onClick={() => setOpen(expanded ? null : p.id)}
                className="grid w-full grid-cols-1 items-center gap-1 px-4 py-2.5 text-left hover:bg-elevated sm:grid-cols-[1fr_1.4fr_auto_auto_auto] sm:gap-3"
              >
                <span className="flex items-center gap-2 font-medium">
                  {p.display_name || "—"}
                  {p.is_admin && (
                    <span className="rounded-full bg-brick/10 px-1.5 py-0.5 text-[10px] font-medium text-brick">
                      admin
                    </span>
                  )}
                  {p.roles.map((r) => (
                    <span key={r} className="rounded-full border border-tan px-1.5 py-0.5 text-[10px] text-muted">
                      {r}
                    </span>
                  ))}
                </span>
                <a
                  href={p.email ? `mailto:${p.email}` : undefined}
                  onClick={(e) => e.stopPropagation()}
                  className="truncate text-sm text-brick hover:underline"
                >
                  {p.email ?? "—"}
                </a>
                <span className="text-sm text-taupe sm:text-center">
                  {p.scripts}
                  {p.unlocked_scripts > 0 && (
                    <span className="ml-1 text-xs text-forest">({p.unlocked_scripts} full)</span>
                  )}
                </span>
                <span className="text-sm text-muted">{fmt(p.created_at)}</span>
                <span className="text-sm text-muted">{fmt(p.last_sign_in_at)}</span>
              </button>

              {expanded && theirs.length > 0 && (
                <div className="space-y-1 bg-elevated px-4 py-3">
                  {theirs.map((s) => (
                    <div key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <Link href={`/script/${s.slug ?? s.id}`} className="font-medium text-brick hover:underline">
                        {s.title}
                      </Link>
                      <span className="text-xs text-muted">{s.visibility ?? "public"}</span>
                      {s.page_count ? <span className="text-xs text-muted">{s.page_count}p</span> : null}
                      {s.full_read_unlocked && (
                        <span className="rounded-full bg-forest/10 px-1.5 py-0.5 text-[10px] text-forest">
                          full read
                        </span>
                      )}
                      <span className="text-xs text-muted">{fmt(s.created_at)}</span>
                    </div>
                  ))}
                </div>
              )}
              {expanded && theirs.length === 0 && (
                <div className="bg-elevated px-4 py-3 text-sm text-muted">No scripts uploaded.</div>
              )}
            </div>
          );
        })}
        {realPeople.length === 0 && <p className="px-4 py-6 text-muted">No signups yet.</p>}
      </div>
    </main>
  );
}
