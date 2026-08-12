"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";

type ReqStatus = "pending" | "approved" | "denied";

/**
 * Request-to-listen flow for a gated (showcase) script. Requesting requires a
 * signed-in account with a name and a LinkedIn or IMDb link — the writer sees
 * who's asking and approves or denies each listener.
 */
export function RequestListen({
  scriptId,
  scriptSlug,
  writerName,
}: {
  scriptId: string;
  scriptSlug: string | null;
  writerName: string;
}) {
  const supabase = getBrowserClient();
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [status, setStatus] = useState<ReqStatus | null>(null);
  const [name, setName] = useState("");
  const [linkedin, setLinkedin] = useState("");
  const [imdb, setImdb] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setLoading(false);
        return;
      }
      setUserId(user.id);
      setEmail(user.email ?? null);
      const [{ data: profile }, { data: req }] = await Promise.all([
        supabase.from("users").select("display_name, links").eq("id", user.id).single(),
        supabase
          .from("listen_requests")
          .select("status")
          .eq("script_id", scriptId)
          .eq("requester_id", user.id)
          .maybeSingle(),
      ]);
      const links = (profile?.links ?? {}) as Record<string, string>;
      setName(profile?.display_name ?? "");
      setLinkedin(links.linkedin ?? "");
      setImdb(links.imdb ?? "");
      setStatus((req?.status as ReqStatus | undefined) ?? null);
      setLoading(false);
    })();
  }, [supabase, scriptId]);

  async function request() {
    if (!userId) return;
    const nm = name.trim();
    const li = linkedin.trim();
    const im = imdb.trim();
    if (!nm) {
      setError("Please add your name.");
      return;
    }
    if (!li && !im) {
      setError("Please add a LinkedIn or IMDb link so the writer knows who's asking.");
      return;
    }
    setBusy(true);
    setError(null);
    // Save the identity onto the profile (it doubles as their public identity).
    const { data: cur } = await supabase.from("users").select("links").eq("id", userId).single();
    await supabase
      .from("users")
      .update({
        display_name: nm,
        links: { ...((cur?.links ?? {}) as Record<string, string>), linkedin: li, imdb: im },
      })
      .eq("id", userId);
    const { error: reqErr } = await supabase
      .from("listen_requests")
      .insert({ script_id: scriptId, requester_id: userId, email, note: note.trim() || null });
    if (reqErr && !reqErr.message.toLowerCase().includes("duplicate")) {
      setError(reqErr.message);
      setBusy(false);
      return;
    }
    // Notify the writer — in-app row AND email, done server-side. (Clients
    // can't insert notifications for other users since the RLS hardening, so
    // a direct insert here would be silently dropped.)
    supabase.functions
      .invoke("notify-listen-request", { body: { script_id: scriptId, event: "created" } })
      .then(
        () => {},
        () => {}
      );
    setStatus("pending");
    setBusy(false);
  }

  if (loading) {
    return <div className="mt-8 rounded-xl border border-tan bg-ivory p-6 text-taupe">Loading…</div>;
  }

  if (status === "pending") {
    return (
      <div className="mt-8 rounded-xl border border-tan bg-ivory p-6">
        <div className="font-slab text-lg">Request sent ✓</div>
        <p className="mt-1 text-sm text-taupe">
          {writerName} has your request. You&rsquo;ll get a notification when they decide, and the
          full table read unlocks here the moment you&rsquo;re approved.
        </p>
      </div>
    );
  }

  if (status === "denied") {
    return (
      <div className="mt-8 rounded-xl border border-tan bg-ivory p-6">
        <div className="font-slab text-lg">Request declined</div>
        <p className="mt-1 text-sm text-taupe">
          {writerName} declined this request. You can still browse other scripts on Discover.
        </p>
      </div>
    );
  }

  if (status === "approved") {
    return (
      <div className="mt-8 rounded-xl border border-forest/40 bg-forest/5 p-6">
        <div className="font-slab text-lg">You&rsquo;re approved 🎉</div>
        <p className="mt-1 text-sm text-taupe">Reload the page to listen to the full table read.</p>
      </div>
    );
  }

  if (!userId) {
    return (
      <div className="mt-8 rounded-xl border-2 border-brick bg-elevated p-6">
        <div className="font-slab text-lg">🔒 This script is listen-by-request</div>
        <p className="mt-1 text-sm text-taupe">
          {writerName} shares the table read with approved listeners only. Sign in and request
          access — you&rsquo;ll need a name and a LinkedIn or IMDb link.
        </p>
        <Link
          href={`/sign-in?next=/script/${scriptSlug ?? scriptId}`}
          className="mt-4 inline-flex rounded-lg bg-brick px-5 py-2.5 font-medium text-white"
        >
          Sign in to request access
        </Link>
      </div>
    );
  }

  const profileComplete = !!name.trim() && !!(linkedin.trim() || imdb.trim());

  return (
    <div className="mt-8 rounded-xl border-2 border-brick bg-elevated p-6">
      <div className="font-slab text-lg">🔒 Request access to listen</div>
      <p className="mt-1 text-sm text-taupe">
        {writerName} approves each listener personally. Your name, email, and link below are shared
        with them so they know who&rsquo;s asking.
      </p>
      {error && <p className="mt-2 text-sm text-brick">{error}</p>}

      {!profileComplete && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Your name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-lg border border-tan bg-ivory px-3 py-2 text-sm outline-none focus:border-brick"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">LinkedIn URL</span>
            <input
              value={linkedin}
              onChange={(e) => setLinkedin(e.target.value)}
              placeholder="https://linkedin.com/in/…"
              className="rounded-lg border border-tan bg-ivory px-3 py-2 text-sm outline-none focus:border-brick"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              IMDb URL (or LinkedIn)
            </span>
            <input
              value={imdb}
              onChange={(e) => setImdb(e.target.value)}
              placeholder="https://imdb.com/name/…"
              className="rounded-lg border border-tan bg-ivory px-3 py-2 text-sm outline-none focus:border-brick"
            />
          </label>
        </div>
      )}
      {profileComplete && (
        <p className="mt-3 text-sm text-taupe">
          Requesting as <span className="font-medium text-ink">{name}</span>
          {email ? ` · ${email}` : ""}
        </p>
      )}

      <label className="mt-3 flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          Who you are (optional)
        </span>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={120}
          placeholder="Producer, Blue Hour Films"
          className="rounded-lg border border-tan bg-ivory px-3 py-2 text-sm outline-none focus:border-brick"
        />
      </label>

      <button
        onClick={request}
        disabled={busy}
        className="mt-4 rounded-lg bg-brick px-5 py-2.5 font-medium text-white disabled:opacity-60"
      >
        {busy ? "Sending…" : "Request access"}
      </button>
    </div>
  );
}
