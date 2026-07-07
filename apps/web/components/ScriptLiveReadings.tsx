"use client";

import { useCallback, useEffect, useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";
import type { LiveReading, LiveReadingSignup } from "@/lib/shared";

type Char = { id: string; name: string };
type Reading = Omit<LiveReading, "signups"> & {
  signups: Pick<LiveReadingSignup, "id" | "actor_id" | "character_id" | "status">[];
};

/**
 * Upcoming live readings for a script, with a sign-up flow. Renders nothing when
 * there are no scheduled readings, so it stays invisible on most scripts.
 */
export function ScriptLiveReadings({ scriptId, characters }: { scriptId: string; characters: Char[] }) {
  const supabase = getBrowserClient();
  const [readings, setReadings] = useState<Reading[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pickFor, setPickFor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    setUserId(user?.id ?? null);
    const { data } = await supabase
      .from("live_readings")
      .select("*, signups:live_reading_signups(id, actor_id, character_id, status)")
      .eq("script_id", scriptId)
      .in("status", ["scheduled", "live"])
      .order("scheduled_at", { ascending: true });
    setReadings((data as unknown as Reading[]) ?? []);
    setLoaded(true);
  }, [scriptId, supabase]);

  useEffect(() => {
    load();
  }, [load]);

  function requireAuth(): boolean {
    if (userId) return true;
    const next = typeof window !== "undefined" ? window.location.pathname : `/script/${scriptId}`;
    window.location.href = `/sign-in?next=${encodeURIComponent(next)}`;
    return false;
  }

  async function signUp(reading: Reading, characterId: string | null) {
    if (!requireAuth()) return;
    setBusy(reading.id);
    const { error } = await supabase.from("live_reading_signups").insert({
      live_reading_id: reading.id,
      actor_id: userId,
      character_id: characterId,
    });
    setBusy(null);
    setPickFor(null);
    if (error) return;
    if (reading.writer_id) {
      const charName = characters.find((c) => c.id === characterId)?.name;
      await supabase.functions.invoke("send-notification", {
        body: {
          user_id: reading.writer_id,
          type: "live_reading_signup",
          title: "New live-reading sign-up",
          body: `An actor signed up${charName ? ` for ${charName}` : ""} in "${reading.title}".`,
          data: { live_reading_id: reading.id, script_id: scriptId },
        },
      });
    }
    load();
  }

  if (!loaded || readings.length === 0) return null;

  return (
    <section className="mt-6 rounded-xl border border-tan bg-ivory p-5">
      <h2 className="font-slab text-lg">🎭 Live readings</h2>
      <p className="mt-1 text-sm text-taupe">Sign up to perform a role live on Zoom — the writer picks the cast.</p>
      <div className="mt-4 space-y-3">
        {readings.map((r) => {
          const mine = userId ? r.signups.filter((s) => s.actor_id === userId) : [];
          const cast = mine.find((s) => s.status === "cast");
          const pending = mine.find((s) => s.status === "signed_up" || s.status === "waitlist");
          const when = new Date(r.scheduled_at);
          const signupClosed = r.signup_deadline ? new Date(r.signup_deadline).getTime() < Date.now() : false;
          return (
            <div key={r.id} className="rounded-lg border border-tan p-3">
              <div className="font-medium">{r.title}</div>
              <div className="text-sm text-taupe">
                {when.toLocaleString()} · {r.duration_min} min
              </div>
              {r.description && <p className="mt-1 text-sm text-muted">{r.description}</p>}

              {cast ? (
                <div className="mt-2 rounded-lg border border-brick bg-brick/5 px-3 py-2 text-sm">
                  ★ You&rsquo;re cast!{" "}
                  {r.zoom_join_url ? (
                    <a href={r.zoom_join_url} target="_blank" rel="noreferrer" className="font-medium text-brick underline">
                      Join link
                    </a>
                  ) : (
                    <span className="text-muted">Join link coming soon.</span>
                  )}
                </div>
              ) : pending ? (
                <div className="mt-2 text-sm text-muted">
                  You signed up
                  {pending.character_id
                    ? ` for ${characters.find((c) => c.id === pending.character_id)?.name ?? "a role"}`
                    : ""}{" "}
                  — waiting on the writer&rsquo;s pick.
                </div>
              ) : mine.length > 0 ? (
                <div className="mt-2 text-sm text-muted">Not selected this time.</div>
              ) : signupClosed ? (
                <div className="mt-2 text-sm text-muted">Sign-ups are closed.</div>
              ) : pickFor === r.id ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {characters.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => signUp(r, c.id)}
                      disabled={busy === r.id}
                      className="rounded-lg border border-tan px-2.5 py-1 text-xs font-medium hover:bg-elevated disabled:opacity-60"
                    >
                      {c.name}
                    </button>
                  ))}
                  <button
                    onClick={() => signUp(r, null)}
                    disabled={busy === r.id}
                    className="rounded-lg border border-tan px-2.5 py-1 text-xs font-medium text-muted hover:bg-elevated disabled:opacity-60"
                  >
                    Any role
                  </button>
                  <button onClick={() => setPickFor(null)} className="rounded-lg px-2.5 py-1 text-xs text-muted">
                    cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => (requireAuth() ? setPickFor(r.id) : undefined)}
                  className="mt-2 rounded-lg bg-brick px-3 py-1.5 text-xs font-medium text-white"
                >
                  Sign up to read
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
