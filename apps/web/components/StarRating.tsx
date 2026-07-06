"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";

/**
 * 1–5 star rating for a script. Shows the average (rounded), lets a signed-in
 * viewer set/change their own rating (upsert into script_ratings), and re-reads
 * the trigger-maintained aggregate off scripts afterward.
 */
export function StarRating({
  scriptId,
  initialAvg,
  initialCount,
}: {
  scriptId: string;
  initialAvg: number;
  initialCount: number;
}) {
  const supabase = getBrowserClient();
  const [avg, setAvg] = useState(initialAvg);
  const [count, setCount] = useState(initialCount);
  const [mine, setMine] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (cancelled) return;
      setUserId(user?.id ?? null);
      if (user) {
        const { data } = await supabase
          .from("script_ratings")
          .select("stars")
          .eq("script_id", scriptId)
          .eq("user_id", user.id)
          .maybeSingle();
        if (!cancelled && data) setMine(data.stars);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, scriptId]);

  async function rate(stars: number) {
    if (!userId || busy) return;
    setBusy(true);
    const prev = mine;
    setMine(stars); // optimistic
    const { error } = await supabase
      .from("script_ratings")
      .upsert(
        { script_id: scriptId, user_id: userId, stars, updated_at: new Date().toISOString() },
        { onConflict: "script_id,user_id" }
      );
    if (error) {
      setMine(prev);
      setBusy(false);
      return;
    }
    // The trigger refreshed scripts.rating_avg / rating_count — re-read it.
    const { data } = await supabase
      .from("scripts")
      .select("rating_avg, rating_count")
      .eq("id", scriptId)
      .maybeSingle();
    if (data) {
      setAvg(Number(data.rating_avg));
      setCount(data.rating_count);
    }
    setBusy(false);
  }

  const shown = hover ?? mine ?? Math.round(avg);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <div
        className="flex items-center"
        onMouseLeave={() => setHover(null)}
        role={userId ? "radiogroup" : undefined}
        aria-label="Rate this script"
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            disabled={!userId || busy}
            onMouseEnter={() => userId && setHover(n)}
            onClick={() => rate(n)}
            className={`text-xl leading-none ${userId ? "cursor-pointer" : "cursor-default"} ${
              n <= shown ? "text-brick" : "text-tan"
            } disabled:cursor-default`}
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
            title={userId ? `Rate ${n}` : undefined}
          >
            {n <= shown ? "★" : "☆"}
          </button>
        ))}
      </div>

      <div className="text-sm text-muted">
        {count > 0 ? (
          <>
            <span className="font-medium text-ink">{avg.toFixed(1)}</span> · {count} rating
            {count !== 1 ? "s" : ""}
            {mine ? <span className="text-brick"> · you rated {mine}</span> : null}
          </>
        ) : userId ? (
          <span>Be the first to rate</span>
        ) : (
          <span>No ratings yet</span>
        )}
        {!userId && (
          <>
            {" "}
            —{" "}
            <Link href="/sign-in" className="text-brick hover:underline">
              sign in to rate
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
