"use client";

import { useCallback, useEffect, useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";

type Vis = "public" | "hidden" | "private";

const OPTS: { key: Vis; label: string; hint: string }[] = [
  { key: "public", label: "Public", hint: "Listed in Discover and open to everyone." },
  { key: "hidden", label: "Hidden", hint: "Unlisted — reachable only by direct link." },
  { key: "private", label: "Private", hint: "Invite-only — only people you invite can open it." },
];

/** Writer-only sharing controls: visibility + invite-by-email (private scripts). */
export function OwnerPanel({
  scriptId,
  initialVisibility,
  unlocked,
}: {
  scriptId: string;
  initialVisibility: Vis;
  unlocked: boolean;
}) {
  const supabase = getBrowserClient();
  const [visibility, setVisibility] = useState<Vis>(initialVisibility);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invites, setInvites] = useState<{ id: string; email: string }[]>([]);
  const [email, setEmail] = useState("");
  const [adding, setAdding] = useState(false);

  const loadInvites = useCallback(async () => {
    const { data } = await supabase
      .from("script_invites")
      .select("id, email")
      .eq("script_id", scriptId)
      .order("created_at", { ascending: true });
    setInvites(data ?? []);
  }, [supabase, scriptId]);

  useEffect(() => {
    if (visibility === "private") loadInvites();
  }, [visibility, loadInvites]);

  async function changeVisibility(next: Vis) {
    if (next === visibility) return;
    if (next === "private" && !unlocked) {
      setError("Unlock the full read ($19) to make this script invite-only.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await supabase.from("scripts").update({ visibility: next }).eq("id", scriptId);
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setVisibility(next);
  }

  async function addInvite() {
    const e = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
      setError("Enter a valid email.");
      return;
    }
    setAdding(true);
    setError(null);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("script_invites")
      .insert({ script_id: scriptId, email: e, invited_by: user?.id });
    setAdding(false);
    if (error) {
      setError(
        error.message.toLowerCase().includes("duplicate")
          ? "That email is already invited."
          : error.message
      );
      return;
    }
    setEmail("");
    loadInvites();
    // Fire-and-forget the invite email (no-op until the email provider is set up).
    supabase.functions.invoke("send-invite", { body: { script_id: scriptId, email: e } }).catch(() => {});
  }

  async function removeInvite(id: string) {
    setInvites((p) => p.filter((i) => i.id !== id));
    await supabase.from("script_invites").delete().eq("id", id);
  }

  return (
    <div className="mt-6 rounded-xl border border-tan bg-ivory p-5">
      <div className="font-slab text-lg">Sharing</div>
      {error && <p className="mt-2 text-sm text-brick">{error}</p>}

      <div className="mt-3 flex gap-2">
        {OPTS.map((o) => {
          const active = visibility === o.key;
          const locked = o.key === "private" && !unlocked;
          return (
            <button
              key={o.key}
              onClick={() => changeVisibility(o.key)}
              disabled={busy}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
                active
                  ? "border-brick bg-brick text-white"
                  : "border-tan text-taupe hover:bg-elevated"
              } ${locked ? "opacity-60" : ""}`}
            >
              {o.label}
              {locked ? " 🔒" : ""}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted">{OPTS.find((o) => o.key === visibility)?.hint}</p>

      {visibility === "private" && (
        <div className="mt-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">
            Invite by email
          </div>
          <div className="mt-2 flex gap-2">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addInvite()}
              placeholder="name@email.com"
              type="email"
              className="flex-1 rounded-lg border border-tan bg-elevated px-3 py-2 text-sm outline-none focus:border-brick"
            />
            <button
              onClick={addInvite}
              disabled={adding}
              className="rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {adding ? "…" : "Invite"}
            </button>
          </div>
          <div className="mt-3 space-y-2">
            {invites.map((i) => (
              <div
                key={i.id}
                className="flex items-center justify-between rounded-lg border border-tan/60 px-3 py-2 text-sm"
              >
                <span className="truncate">{i.email}</span>
                <button onClick={() => removeInvite(i.id)} className="shrink-0 text-muted hover:text-brick">
                  Remove
                </button>
              </div>
            ))}
            {invites.length === 0 && (
              <p className="text-xs text-muted">
                No one invited yet. They get access when they sign in with the invited email.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
