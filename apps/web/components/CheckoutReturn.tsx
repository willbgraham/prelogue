"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserClient } from "@/lib/supabase/client";
import {
  finishSubscribed,
  finishUnlocked,
  returnFromSearch,
  withoutReturnMarks,
  type CheckoutReturnKind,
} from "@/lib/checkoutReturn";
import { planCredits, planLabel } from "@/lib/shared/plans";

type Phase =
  | { at: "idle" }
  | { at: "working"; kind: CheckoutReturnKind }
  | { at: "done"; kind: CheckoutReturnKind; plan?: string | null; credits?: number | null }
  | { at: "waiting"; kind: CheckoutReturnKind }
  | { at: "refused"; message: string };

/**
 * The writer has just come back to their script from the payment page
 * (`?subscribed=1` after a plan, `?unlocked=1` after the one-time unlock).
 * Finish the job here, where they are looking: unlock the script with the new
 * plan, or wait the second or two it can take for the payment to reach us, then
 * show the page as it now is. Shows nothing on an ordinary visit.
 */
export function CheckoutReturn({ scriptId, unlocked }: { scriptId: string; unlocked: boolean }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ at: "idle" });
  const started = useRef(false);
  // Is the page still showing this? Kept apart from the work below, which is
  // started once and must not be stopped by React mounting a component twice
  // in development.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    // Once per arrival: a re-render, or the page refreshing itself below, must not start it again.
    if (started.current) return;
    const kind = returnFromSearch(window.location.search);
    if (!kind) return;
    started.current = true;
    const cancelled = () => !alive.current;
    const clean = withoutReturnMarks(window.location.pathname, window.location.search);

    (async () => {
      // Paid for this one script and the page already shows it unlocked: nothing to do but tidy the address.
      if (kind === "unlocked" && unlocked) {
        window.history.replaceState(null, "", clean);
        return;
      }
      setPhase({ at: "working", kind });
      const client = getBrowserClient();
      const out =
        kind === "subscribed"
          ? await finishSubscribed(client, scriptId, { cancelled })
          : await finishUnlocked(client, scriptId, { cancelled });
      if (!alive.current) return;
      if (out.state === "unlocked") {
        setPhase({ at: "done", kind, plan: out.plan, credits: out.credits });
        // The address loses its mark (a reload shouldn't greet them twice) and the
        // page is drawn again from the server, now with the player and the
        // downloads of an unlocked script.
        window.history.replaceState(null, "", clean);
        router.refresh();
      } else if (out.state === "refused") {
        setPhase({ at: "refused", message: out.message });
      } else {
        setPhase({ at: "waiting", kind });
      }
    })();
    // The arrival is read once from the address; `unlocked` is the page's first answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptId]);

  if (phase.at === "idle") return null;

  const box = "mt-5 rounded-lg px-4 py-3 text-sm";
  if (phase.at === "working") {
    return (
      <div role="status" className={`${box} bg-forest/10 text-forest`}>
        {phase.kind === "subscribed"
          ? "Thanks for subscribing. Unlocking this script with your plan…"
          : "Thanks. Unlocking your script…"}
      </div>
    );
  }
  if (phase.at === "done") {
    const label = phase.kind === "subscribed" && phase.plan ? planLabel(phase.plan) : null;
    const monthly = phase.kind === "subscribed" && phase.plan ? planCredits(phase.plan) : 0;
    return (
      <div role="status" className={`${box} bg-forest/10 text-forest`}>
        {label ? (
          <>
            <span className="font-medium">You&rsquo;re on {label}, and this script is unlocked.</span>{" "}
            {monthly > 0 ? `${monthly} credits a month` : "Your credits"}
            {typeof phase.credits === "number" ? `; you have ${phase.credits} now` : ""}. Press play
            to hear all of it.
          </>
        ) : (
          <>
            <span className="font-medium">This script is unlocked.</span> Press play to hear all of
            it.
          </>
        )}
      </div>
    );
  }
  if (phase.at === "refused") {
    return (
      <div role="status" className={`${box} bg-brick/10 text-brick`}>
        {phase.message}
      </div>
    );
  }
  return (
    <div role="status" className={`${box} bg-elevated text-taupe`}>
      Word of your payment hasn&rsquo;t reached this page yet. Give it a minute, then{" "}
      <button
        onClick={() => window.location.reload()}
        className="font-medium text-brick underline underline-offset-2"
      >
        reload
      </button>
      {phase.kind === "subscribed"
        ? ": the script will unlock with your plan."
        : ": the script will be unlocked."}
    </div>
  );
}
