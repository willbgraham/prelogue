"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { getBrowserClient } from "@/lib/supabase/client";
import type { LiveReading, LiveReadingSignup } from "@/lib/shared";

type Char = { id: string; name: string };
type SignupRow = Omit<LiveReadingSignup, "actor" | "character"> & {
  actor: { id: string; display_name: string; avatar_url: string | null } | null;
  character: { id: string; name: string } | null;
};
type Reading = Omit<LiveReading, "signups"> & { signups: SignupRow[] };

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-tan/50 text-taupe",
  scheduled: "bg-green-100 text-green-800",
  live: "bg-brick text-white",
  completed: "bg-tan/50 text-taupe",
  canceled: "bg-brick/15 text-brick",
};

export default function LiveReadingsManager() {
  const { scriptId } = useParams<{ scriptId: string }>();
  const router = useRouter();
  const supabase = getBrowserClient();
  const [loading, setLoading] = useState(true);
  const [scriptTitle, setScriptTitle] = useState("");
  const [characters, setCharacters] = useState<Char[]>([]);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    title: "",
    scheduled_at: "",
    duration_min: 60,
    signup_deadline: "",
    description: "",
    visibility: "public" as "public" | "unlisted",
  });

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.push(`/sign-in?next=/studio/${scriptId}/live`);
      return;
    }
    const { data: script } = await supabase.from("scripts").select("title, writer_id").eq("id", scriptId).single();
    if (!script || script.writer_id !== user.id) {
      router.push("/studio");
      return;
    }
    setScriptTitle(script.title);
    setForm((f) => ({ ...f, title: f.title || `${script.title} — Live Reading` }));
    const { data: chars } = await supabase.from("characters").select("id, name").eq("script_id", scriptId).order("name");
    setCharacters((chars as Char[]) ?? []);
    const { data: rs } = await supabase
      .from("live_readings")
      .select(
        "*, signups:live_reading_signups(*, actor:users!live_reading_signups_actor_id_fkey(id, display_name, avatar_url), character:characters!live_reading_signups_character_id_fkey(id, name))"
      )
      .eq("script_id", scriptId)
      .order("scheduled_at", { ascending: false });
    setReadings((rs as unknown as Reading[]) ?? []);
    setLoading(false);
  }, [scriptId, router, supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function createReading() {
    if (!form.title || !form.scheduled_at) {
      setNote("Add a title and a date/time.");
      return;
    }
    setBusy("create");
    setNote(null);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data: ins, error } = await supabase
      .from("live_readings")
      .insert({
        script_id: scriptId,
        writer_id: user!.id,
        title: form.title,
        description: form.description || null,
        scheduled_at: new Date(form.scheduled_at).toISOString(),
        duration_min: form.duration_min,
        signup_deadline: form.signup_deadline ? new Date(form.signup_deadline).toISOString() : null,
        visibility: form.visibility,
      })
      .select("id")
      .single();
    if (error) {
      setBusy(null);
      setNote(`Error: ${error.message}`);
      return;
    }
    // Best-effort auto-provision of a Prelogue-hosted Zoom meeting. Until the Zoom
    // app is configured the reading still schedules — you paste a join link below.
    let zoomMsg = "";
    if (ins?.id) {
      const { data: z, error: zErr } = await supabase.functions.invoke("zoom-create-meeting", {
        body: { live_reading_id: ins.id },
      });
      const zr = z as { ok?: boolean } | null;
      zoomMsg = !zErr && zr?.ok ? " Zoom meeting created." : " Add a Zoom link below (auto-create isn't set up yet).";
    }
    setBusy(null);
    setShowForm(false);
    setForm((f) => ({ ...f, scheduled_at: "", signup_deadline: "", description: "" }));
    setNote("Reading scheduled." + zoomMsg);
    load();
  }

  async function patchReading(id: string, patch: Record<string, unknown>, key: string) {
    setBusy(key);
    await supabase.from("live_readings").update(patch).eq("id", id);
    setBusy(null);
    load();
  }

  async function castSignup(reading: Reading, signup: SignupRow) {
    setBusy(signup.id);
    await supabase.from("live_reading_signups").update({ status: "cast" }).eq("id", signup.id);
    if (signup.actor?.id) {
      await supabase.functions.invoke("send-notification", {
        body: {
          user_id: signup.actor.id,
          type: "live_reading_cast",
          title: "You're cast! 🎭",
          body: `You're cast as ${signup.character?.name ?? "a role"} in "${reading.title}".`,
          data: { live_reading_id: reading.id, script_id: scriptId, join_url: reading.zoom_join_url },
        },
      });
    }
    setBusy(null);
    load();
  }

  if (loading) return <main className="mx-auto max-w-3xl px-6 py-16 text-taupe">Loading…</main>;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <Link href={`/studio/${scriptId}`} className="text-sm text-taupe hover:text-ink">
        ← Casting
      </Link>
      <div className="mt-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-slab text-3xl">Live readings</h1>
          <p className="mt-1 text-sm text-taupe">{scriptTitle}</p>
        </div>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="shrink-0 rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white"
        >
          {showForm ? "Close" : "+ Schedule"}
        </button>
      </div>
      {note && <p className="mt-3 rounded-lg bg-ivory px-3 py-2 text-sm text-taupe">{note}</p>}

      {showForm && (
        <section className="mt-6 space-y-3 rounded-xl border border-tan bg-ivory p-5">
          <label className="block text-sm">
            <span className="text-taupe">Title</span>
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="mt-1 w-full rounded-lg border border-tan bg-elevated px-3 py-2 text-sm outline-none focus:border-brick"
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <label className="block min-w-[180px] flex-1 text-sm">
              <span className="text-taupe">Date &amp; time</span>
              <input
                type="datetime-local"
                value={form.scheduled_at}
                onChange={(e) => setForm({ ...form, scheduled_at: e.target.value })}
                className="mt-1 w-full rounded-lg border border-tan bg-elevated px-3 py-2 text-sm outline-none focus:border-brick"
              />
            </label>
            <label className="block w-28 text-sm">
              <span className="text-taupe">Minutes</span>
              <input
                type="number"
                min={15}
                step={15}
                value={form.duration_min}
                onChange={(e) => setForm({ ...form, duration_min: Number(e.target.value) })}
                className="mt-1 w-full rounded-lg border border-tan bg-elevated px-3 py-2 text-sm outline-none focus:border-brick"
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <label className="block min-w-[180px] flex-1 text-sm">
              <span className="text-taupe">Sign-up deadline (optional)</span>
              <input
                type="datetime-local"
                value={form.signup_deadline}
                onChange={(e) => setForm({ ...form, signup_deadline: e.target.value })}
                className="mt-1 w-full rounded-lg border border-tan bg-elevated px-3 py-2 text-sm outline-none focus:border-brick"
              />
            </label>
            <label className="block w-40 text-sm">
              <span className="text-taupe">Visibility</span>
              <select
                value={form.visibility}
                onChange={(e) => setForm({ ...form, visibility: e.target.value as "public" | "unlisted" })}
                className="mt-1 w-full rounded-lg border border-tan bg-elevated px-3 py-2 text-sm outline-none focus:border-brick"
              >
                <option value="public">Public</option>
                <option value="unlisted">Unlisted</option>
              </select>
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-taupe">Description (optional)</span>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
              className="mt-1 w-full rounded-lg border border-tan bg-elevated px-3 py-2 text-sm outline-none focus:border-brick"
            />
          </label>
          <button
            onClick={createReading}
            disabled={busy === "create"}
            className="rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {busy === "create" ? "Scheduling…" : "Schedule reading"}
          </button>
        </section>
      )}

      <div className="mt-6 space-y-5">
        {readings.map((r) => {
          const when = new Date(r.scheduled_at);
          const general = r.signups.filter((s) => !s.character_id);
          return (
            <div key={r.id} className="rounded-xl border border-tan bg-ivory p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-slab text-lg">{r.title}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_BADGE[r.status]}`}
                >
                  {r.status}
                </span>
                {r.visibility === "unlisted" && <span className="text-xs text-muted">unlisted</span>}
              </div>
              <p className="mt-1 text-sm text-taupe">
                {when.toLocaleString()} · {r.duration_min} min
              </p>
              {r.description && <p className="mt-1 text-sm text-muted">{r.description}</p>}

              {/* Join link — pasted for now; the Zoom layer will auto-fill this. */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  defaultValue={r.zoom_join_url ?? ""}
                  placeholder="Paste the Zoom/Meet join link…"
                  onBlur={(e) =>
                    e.target.value !== (r.zoom_join_url ?? "") &&
                    patchReading(r.id, { zoom_join_url: e.target.value || null }, `${r.id}:join`)
                  }
                  className="min-w-[200px] flex-1 rounded-lg border border-tan bg-elevated px-3 py-1.5 text-sm outline-none focus:border-brick"
                />
                {r.zoom_join_url && (
                  <a
                    href={r.zoom_join_url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg border border-tan px-3 py-1.5 text-xs font-medium text-taupe hover:bg-elevated"
                  >
                    Open
                  </a>
                )}
              </div>

              {/* Sign-ups grouped by character */}
              <div className="mt-4 space-y-3">
                {characters.map((c) => {
                  const subs = r.signups.filter((s) => s.character_id === c.id);
                  return (
                    <div key={c.id}>
                      <div className="text-sm font-medium">
                        {c.name} <span className="text-xs text-muted">· {subs.length} signed up</span>
                      </div>
                      {subs.length === 0 ? (
                        <p className="text-xs text-muted">No sign-ups yet.</p>
                      ) : (
                        <div className="mt-1 space-y-1">
                          {subs.map((s) => (
                            <div
                              key={s.id}
                              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 ${
                                s.status === "cast" ? "border-brick bg-brick/5" : "border-tan"
                              }`}
                            >
                              <span className="h-6 w-6 shrink-0 overflow-hidden rounded-full border border-tan bg-elevated text-center text-xs leading-6 text-taupe">
                                {s.actor?.avatar_url ? (
                                  <Image
                                    src={s.actor.avatar_url}
                                    alt=""
                                    width={24}
                                    height={24}
                                    className="h-full w-full object-cover"
                                  />
                                ) : (
                                  (s.actor?.display_name ?? "A").charAt(0).toUpperCase()
                                )}
                              </span>
                              <span className="flex-1 truncate text-sm">{s.actor?.display_name ?? "Actor"}</span>
                              {s.status === "cast" ? (
                                <span className="rounded-lg bg-brick px-2 py-0.5 text-xs font-medium text-white">★ Cast</span>
                              ) : (
                                <button
                                  onClick={() => castSignup(r, s)}
                                  disabled={busy === s.id}
                                  className="rounded-lg border border-tan px-2 py-0.5 text-xs font-medium hover:bg-elevated disabled:opacity-60"
                                >
                                  Cast
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {general.length > 0 && (
                  <p className="text-xs text-muted">{general.length} general sign-up(s) (no specific role)</p>
                )}
              </div>

              {/* After the reading: YouTube link + status controls */}
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-tan pt-3">
                <input
                  defaultValue={r.youtube_url ?? ""}
                  placeholder="Paste the YouTube URL after posting…"
                  onBlur={(e) =>
                    e.target.value !== (r.youtube_url ?? "") &&
                    patchReading(r.id, { youtube_url: e.target.value || null }, `${r.id}:yt`)
                  }
                  className="min-w-[200px] flex-1 rounded-lg border border-tan bg-elevated px-3 py-1.5 text-sm outline-none focus:border-brick"
                />
                {r.status !== "completed" && (
                  <button
                    onClick={() => patchReading(r.id, { status: "completed" }, `${r.id}:done`)}
                    className="rounded-lg border border-tan px-3 py-1.5 text-xs font-medium text-taupe hover:bg-elevated"
                  >
                    Mark done
                  </button>
                )}
                {r.status !== "canceled" && (
                  <button
                    onClick={() => patchReading(r.id, { status: "canceled" }, `${r.id}:cancel`)}
                    className="rounded-lg border border-brick/40 px-3 py-1.5 text-xs font-medium text-brick hover:bg-brick/5"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {readings.length === 0 && !showForm && (
          <p className="text-muted">No live readings yet — schedule one to let actors sign up.</p>
        )}
      </div>
    </main>
  );
}
