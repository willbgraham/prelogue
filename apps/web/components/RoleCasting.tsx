"use client";

import { useCallback, useEffect, useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";

type Clip = { element_index: number; clip_url: string };
type Sub = {
  id: string;
  take_number: number | null;
  is_writers_choice: boolean;
  moderation_status: string | null;
  clips: Clip[] | null;
  video_url: string | null;
  actor: { display_name: string | null; avatar_url: string | null } | null;
};
type Invite = {
  id: string;
  email: string;
  note: string | null;
  status: string;
  created_at: string;
};
export type CastingChar = { id: string; name: string; submissions: Sub[] };

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

/**
 * Invitation-only casting. Scripts are private now, so actors can't browse for
 * roles — the writer invites a specific person to read a part, then reviews the
 * takes that come back and picks one (is_writers_choice, which the table read
 * already honors).
 */
export function RoleCasting({
  scriptId,
  scriptTitle,
  characters,
  onChanged,
}: {
  scriptId: string;
  scriptTitle: string;
  characters: CastingChar[];
  onChanged?: () => void;
}) {
  const supabase = getBrowserClient();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [openChar, setOpenChar] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string[]>>({});

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("role_invites")
      .select("id, character_id, email, note, status, created_at")
      .eq("script_id", scriptId)
      .order("created_at", { ascending: false });
    setInvites((data as unknown as (Invite & { character_id: string })[]) ?? []);
  }, [supabase, scriptId]);

  useEffect(() => {
    load();
  }, [load]);

  const invitesFor = (charId: string) =>
    (invites as unknown as (Invite & { character_id: string })[]).filter(
      (i) => i.character_id === charId
    );

  async function invite(charId: string, charName: string) {
    const e = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
      setError("Enter a valid email.");
      return;
    }
    setBusy(true);
    setError(null);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error: insErr } = await supabase.from("role_invites").insert({
      script_id: scriptId,
      character_id: charId,
      email: e,
      note: note.trim() || null,
      invited_by: user?.id,
    });
    if (insErr) {
      setError(
        insErr.message.toLowerCase().includes("duplicate")
          ? "You've already invited that person to this role."
          : insErr.message
      );
      setBusy(false);
      return;
    }
    // Let them know (in-app + push if they have the app). Fire-and-forget: the
    // invite itself is what grants access.
    supabase.functions
      .invoke("send-invite", {
        body: { script_id: scriptId, email: e, role: charName, kind: "role" },
      })
      .catch(() => {});
    setEmail("");
    setNote("");
    setBusy(false);
    load();
  }

  async function revoke(id: string) {
    setInvites((p) => p.filter((i) => i.id !== id));
    await supabase.from("role_invites").delete().eq("id", id);
  }

  async function choose(submissionId: string, characterId: string) {
    await supabase
      .from("submissions")
      .update({ is_writers_choice: false })
      .eq("character_id", characterId)
      .eq("is_writers_choice", true);
    await supabase.from("submissions").update({ is_writers_choice: true }).eq("id", submissionId);
    onChanged?.();
  }

  async function preview(sub: Sub) {
    if (previews[sub.id]) {
      setPreviews((p) => {
        const next = { ...p };
        delete next[sub.id];
        return next;
      });
      return;
    }
    const paths = (sub.clips ?? []).map((c) => c.clip_url).filter(Boolean);
    if (!paths.length && sub.video_url) paths.push(sub.video_url);
    if (!paths.length) return;
    const { data: signed } = await supabase.storage.from("submissions").createSignedUrls(paths, 3600);
    setPreviews((p) => ({
      ...p,
      [sub.id]: (signed ?? []).map((s) => s?.signedUrl).filter(Boolean) as string[],
    }));
  }

  return (
    <section className="mt-8 rounded-xl border border-tan bg-ivory p-5">
      <h2 className="font-slab text-lg">Cast your roles</h2>
      <p className="mt-1 text-sm text-taupe">
        Your script is private, so invite the actors you want to hear. They get access to read for
        that part only, and their takes come back here for you to pick from.
      </p>
      {error && <p className="mt-2 text-sm text-brick">{error}</p>}

      <div className="mt-4 space-y-3">
        {characters.map((c) => {
          const theirInvites = invitesFor(c.id);
          const takes = c.submissions ?? [];
          const chosen = takes.find((s) => s.is_writers_choice);
          const isOpen = openChar === c.id;
          return (
            <div key={c.id} className="rounded-lg border border-tan/60 bg-elevated p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-mono text-sm font-bold uppercase tracking-wide">
                    {c.name}
                  </span>
                  <span className="ml-2 text-xs text-muted">
                    {theirInvites.length} invited · {takes.length}{" "}
                    {takes.length === 1 ? "take" : "takes"}
                    {chosen ? " · cast ✓" : ""}
                  </span>
                </div>
                <button
                  onClick={() => {
                    setOpenChar(isOpen ? null : c.id);
                    setError(null);
                  }}
                  className="shrink-0 rounded-lg border border-brick px-3 py-1.5 text-xs font-medium text-brick hover:bg-brick/5"
                >
                  {isOpen ? "Close" : "Invite an actor"}
                </button>
              </div>

              {isOpen && (
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="actor@email.com"
                    type="email"
                    className="flex-1 rounded-lg border border-tan bg-ivory px-3 py-2 text-sm outline-none focus:border-brick"
                  />
                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Note (optional)"
                    className="flex-1 rounded-lg border border-tan bg-ivory px-3 py-2 text-sm outline-none focus:border-brick"
                  />
                  <button
                    onClick={() => invite(c.id, c.name)}
                    disabled={busy}
                    className="rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                  >
                    {busy ? "…" : "Invite"}
                  </button>
                </div>
              )}

              {theirInvites.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {theirInvites.map((i) => (
                    <span
                      key={i.id}
                      className="inline-flex items-center gap-1.5 rounded-full border border-tan bg-ivory px-2 py-0.5 text-[11px] text-taupe"
                      title={i.note ?? undefined}
                    >
                      {i.email}
                      <button
                        onClick={() => revoke(i.id)}
                        className="text-muted hover:text-brick"
                        title="Revoke invitation"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {takes.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  {takes.map((s) => {
                    const actor = one(s.actor);
                    return (
                      <div key={s.id} className="rounded-lg border border-tan/60 bg-ivory px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-medium">
                            {actor?.display_name ?? "Actor"}
                          </span>
                          <span className="text-xs text-muted">Take #{s.take_number ?? 1}</span>
                          {s.is_writers_choice && (
                            <span className="rounded-full bg-forest/10 px-2 py-0.5 text-[10px] font-medium text-forest">
                              cast
                            </span>
                          )}
                          <span className="ml-auto flex gap-2">
                            <button
                              onClick={() => preview(s)}
                              className="rounded-lg border border-tan px-2.5 py-1 text-xs text-taupe hover:bg-elevated"
                            >
                              {previews[s.id] ? "Hide" : "▶ Watch"}
                            </button>
                            {!s.is_writers_choice && (
                              <button
                                onClick={() => choose(s.id, c.id)}
                                className="rounded-lg bg-brick px-2.5 py-1 text-xs font-medium text-white"
                              >
                                Cast in this role
                              </button>
                            )}
                          </span>
                        </div>
                        {previews[s.id] && (
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            {previews[s.id].map((u) => (
                              <video
                                key={u}
                                src={u}
                                controls
                                className="w-full rounded-lg border border-tan"
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
