"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { getBrowserClient } from "@/lib/supabase/client";

type Requester = {
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
  links: Record<string, string> | null;
};
type Req = {
  id: string;
  status: "pending" | "approved" | "denied";
  email: string | null;
  note: string | null;
  created_at: string;
  requester: Requester | Requester[] | null;
};

const one = (r: Requester | Requester[] | null): Requester | null =>
  Array.isArray(r) ? r[0] ?? null : r;

/** Writer's inbox for a showcase script: who's asking to listen, with their
 *  name/email/LinkedIn/IMDb, and Approve / Deny. */
export function ListenRequests({
  scriptId,
  scriptSlug,
  scriptTitle,
}: {
  scriptId: string;
  scriptSlug: string | null;
  scriptTitle: string;
}) {
  const supabase = getBrowserClient();
  const [reqs, setReqs] = useState<Req[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("listen_requests")
      .select("id, status, email, note, created_at, requester:users!listen_requests_requester_id_fkey(display_name, username, avatar_url, links)")
      .eq("script_id", scriptId)
      .order("created_at", { ascending: false });
    setReqs((data as unknown as Req[]) ?? []);
    setLoaded(true);
  }, [supabase, scriptId]);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(req: Req, status: "approved" | "denied") {
    setBusy(req.id);
    const { error } = await supabase
      .from("listen_requests")
      .update({ status, decided_at: new Date().toISOString() })
      .eq("id", req.id);
    if (!error) {
      setReqs((p) => p.map((r) => (r.id === req.id ? { ...r, status } : r)));
      // Notify the requester (fire-and-forget). We need their user id — refetch
      // minimal row including requester_id for the notification.
      const { data: row } = await supabase
        .from("listen_requests")
        .select("requester_id")
        .eq("id", req.id)
        .single();
      if (row?.requester_id) {
        supabase
          .from("notifications")
          .insert({
            user_id: row.requester_id,
            type: "listen_request_decided",
            payload: {
              script_id: scriptId,
              script_slug: scriptSlug,
              script_title: scriptTitle,
              status,
            },
          })
          .then(
            () => {},
            () => {}
          );
      }
    }
    setBusy(null);
  }

  if (!loaded) return null;

  const pending = reqs.filter((r) => r.status === "pending");
  const decided = reqs.filter((r) => r.status !== "pending");

  return (
    <div className="mt-6 rounded-xl border border-tan bg-ivory p-5">
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-slab text-lg">Listen requests</div>
        <span className="text-xs text-muted">
          {pending.length} pending · {decided.filter((r) => r.status === "approved").length} approved
        </span>
      </div>
      {reqs.length === 0 && (
        <p className="mt-2 text-sm text-muted">
          No requests yet. When someone asks to hear your script, they&rsquo;ll appear here for your
          approval.
        </p>
      )}

      <div className="mt-3 space-y-2">
        {[...pending, ...decided].map((r) => {
          const u = one(r.requester);
          const links = (u?.links ?? {}) as Record<string, string>;
          return (
            <div
              key={r.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-tan/60 px-3 py-2.5"
            >
              <span className="h-8 w-8 shrink-0 overflow-hidden rounded-full border border-tan bg-elevated">
                {u?.avatar_url ? (
                  <Image
                    src={u.avatar_url}
                    alt={u.display_name ?? ""}
                    width={32}
                    height={32}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-xs text-taupe">
                    {(u?.display_name ?? "?").charAt(0).toUpperCase()}
                  </span>
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{u?.display_name ?? "Someone"}</div>
                {r.note && <div className="truncate text-xs text-taupe">{r.note}</div>}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                  {r.email && (
                    <a href={`mailto:${r.email}`} className="text-brick hover:underline">
                      {r.email}
                    </a>
                  )}
                  {links.linkedin && (
                    <a href={links.linkedin} target="_blank" rel="noopener noreferrer" className="text-taupe hover:text-brick">
                      LinkedIn ↗
                    </a>
                  )}
                  {links.imdb && (
                    <a href={links.imdb} target="_blank" rel="noopener noreferrer" className="text-taupe hover:text-brick">
                      IMDb ↗
                    </a>
                  )}
                </div>
              </div>
              {r.status === "pending" ? (
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => decide(r, "approved")}
                    disabled={busy === r.id}
                    className="rounded-lg bg-forest px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => decide(r, "denied")}
                    disabled={busy === r.id}
                    className="rounded-lg border border-brick px-3 py-1.5 text-xs font-medium text-brick hover:bg-brick/5 disabled:opacity-60"
                  >
                    Deny
                  </button>
                </div>
              ) : (
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      r.status === "approved"
                        ? "bg-forest/10 text-forest"
                        : "bg-brick/10 text-brick"
                    }`}
                  >
                    {r.status}
                  </span>
                  <button
                    onClick={() => decide(r, r.status === "approved" ? "denied" : "approved")}
                    disabled={busy === r.id}
                    className="text-xs text-muted hover:text-brick"
                    title={r.status === "approved" ? "Revoke access" : "Approve instead"}
                  >
                    {r.status === "approved" ? "Revoke" : "Approve"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
