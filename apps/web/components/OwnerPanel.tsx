"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";
import { isActiveStatus } from "@/lib/shared/plans";

type Vis = "public" | "hidden" | "private";

const OPTS: { key: Vis; label: string; hint: string }[] = [
  { key: "public", label: "Public", hint: "Listed in Discover and open to everyone." },
  { key: "hidden", label: "Hidden", hint: "Unlisted — reachable only by direct link." },
  { key: "private", label: "Private", hint: "Invite-only — only people you invite can open it." },
];

/** Writer-only sharing controls: visibility + invite-by-email (private scripts)
 *  + the request-to-listen showcase toggle. */
export function OwnerPanel({
  scriptId,
  initialVisibility,
  initialListenGated = false,
}: {
  scriptId: string;
  initialVisibility: Vis;
  initialListenGated?: boolean;
}) {
  const supabase = getBrowserClient();
  const [visibility, setVisibility] = useState<Vis>(initialVisibility);
  const [listenGated, setListenGated] = useState(initialListenGated);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invites, setInvites] = useState<{ id: string; email: string }[]>([]);
  const [email, setEmail] = useState("");
  const [adding, setAdding] = useState(false);
  // Creating NEW invites is a subscription feature (RLS enforces the same);
  // null while the plan check loads. Existing invites stay listed/removable.
  const [canInvite, setCanInvite] = useState<boolean | null>(null);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setCanInvite(false);
        return;
      }
      const { data } = await supabase
        .from("users")
        .select("plan_status")
        .eq("id", user.id)
        .single();
      setCanInvite(isActiveStatus(data?.plan_status));
    })();
  }, [supabase]);

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
    // Privacy is free — tool first. The $19 unlock buys the full read + export.
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

  async function toggleShowcase() {
    setBusy(true);
    setError(null);
    const next = !listenGated;
    // Showcase = listed publicly (poster/logline/you) while text + audio stay
    // locked per-listener. Private visibility is what locks the script itself;
    // the listing RPCs keep the card public.
    const patch = next
      ? { listen_gated: true, visibility: "private" as Vis }
      : { listen_gated: false };
    const { error } = await supabase.from("scripts").update(patch).eq("id", scriptId);
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setListenGated(next);
    if (next) setVisibility("private");
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
          return (
            <button
              key={o.key}
              onClick={() => changeVisibility(o.key)}
              disabled={busy}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
                active
                  ? "border-brick bg-brick text-white"
                  : "border-tan text-taupe hover:bg-elevated"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted">{OPTS.find((o) => o.key === visibility)?.hint}</p>

      {/* Request-to-listen showcase */}
      <div className="mt-4 flex items-start justify-between gap-3 rounded-lg border border-tan/60 bg-elevated p-3">
        <div>
          <div className="text-sm font-medium">Request-to-listen showcase</div>
          <p className="mt-0.5 text-xs text-muted">
            List your script on Discover (poster, logline, your name) while the read and text stay
            locked. You approve each listener — they request access with their name and a LinkedIn
            or IMDb link.
          </p>
        </div>
        <button
          onClick={toggleShowcase}
          disabled={busy}
          role="switch"
          aria-checked={listenGated}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
            listenGated ? "bg-brick" : "bg-tan"
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
              listenGated ? "left-[1.375rem]" : "left-0.5"
            }`}
          />
        </button>
      </div>

      {visibility === "private" && (
        <div className="mt-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">
            Invite by email
          </div>
          {canInvite ? (
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
          ) : canInvite === false ? (
            <div className="mt-2 rounded-lg border border-tan/60 bg-elevated p-3 text-sm text-taupe">
              Inviting listeners by private link is part of Prelogue plans.{" "}
              <Link href="/pricing" className="font-medium text-brick hover:underline">
                See plans →
              </Link>
            </div>
          ) : null}
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
            {invites.length === 0 && canInvite && (
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
