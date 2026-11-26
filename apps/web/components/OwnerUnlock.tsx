"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getBrowserClient } from "@/lib/supabase/client";
import { pricingHref } from "@/lib/checkoutReturn";
import { refusalBody } from "@/lib/shared/voiceCues";
import {
  PLANS_FROM,
  UNLOCK_MIN_CREDITS,
  UNLOCK_PRICE,
  creditsForPages,
  isActiveStatus,
  isPlanId,
  planLabel,
  readCreditsEstimate,
  unlockCreditsForChars,
} from "@/lib/shared/plans";

type PlanState = {
  plan: string | null;
  status: string | null;
  credits: number;
} | null;

/**
 * Owner-only unlock of a script's full read. Two ways in:
 *   • an active plan — unlocking costs nothing, voicing spends credits, or
 *   • a one-time purchase, which unlocks the script and grants the credits
 *     to voice it (sized to the script; see lib/shared/plans.ts).
 * Unlocking is only access; credits are what meter the actual generation.
 */
export function OwnerUnlock({
  scriptId,
  unlocked: initialUnlocked,
  pageCount,
  spokenChars,
}: {
  scriptId: string;
  unlocked: boolean;
  pageCount?: number | null;
  /** Characters read aloud in this script, when the page has counted them. */
  spokenChars?: number;
}) {
  const router = useRouter();
  // Unlocked when the page says so, or when this panel has just done it. The
  // page's word counts whenever it changes: a writer back from subscribing has
  // the script unlocked for them further up the page (CheckoutReturn), and this
  // panel must not go on offering to.
  const [unlockedHere, setUnlockedHere] = useState(false);
  const unlocked = initialUnlocked || unlockedHere;
  const [busy, setBusy] = useState<null | "plan" | "once">(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanState>(null);

  // Purchase is reported server-side now (stripe-webhook → Conversions API):
  // the browser fire only worked if the buyer landed back here with
  // ?unlocked=1 and no ad-blocker — a real sale went unreported that way.
  // Firing here too would double-count, so the client stays quiet.

  useEffect(() => {
    if (initialUnlocked) return;
    (async () => {
      const supabase = getBrowserClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from("users")
        .select("plan, plan_status, credits_balance")
        .eq("id", user.id)
        .single();
      if (data) {
        setPlan({
          plan: data.plan ?? null,
          status: data.plan_status ?? null,
          credits: data.credits_balance ?? 0,
        });
      }
    })();
  }, [initialUnlocked]);

  if (unlocked) {
    return (
      <div className="mt-8 inline-flex items-center gap-2 rounded-lg bg-forest/10 px-4 py-2 text-sm font-medium text-forest">
        ✓ Full read unlocked
      </div>
    );
  }

  const active = !!plan && isActiveStatus(plan.status) && isPlanId(plan.plan);
  // What this script takes to voice, and what the one-time unlock includes for
  // it. From the script itself when we have it; pages are a poor guide (a
  // script that is mostly description needs twice what its page count says).
  const counted = typeof spokenChars === "number" && spokenChars > 0;
  const estCredits = counted
    ? readCreditsEstimate(spokenChars)
    : creditsForPages(Math.max(1, pageCount ?? 30));
  const unlockCredits = counted ? unlockCreditsForChars(spokenChars) : UNLOCK_MIN_CREDITS;
  // Said plainly either way: what is left over after a full read, or that the
  // included credits stop short (only a script past the ceiling).
  const spare = unlockCredits - estCredits;
  const roomToRecast = spare >= Math.max(10, Math.round(estCredits * 0.1));

  async function unlockWithPlan() {
    setBusy("plan");
    setError(null);
    const { data, error } = await getBrowserClient().functions.invoke("subscription-unlock", {
      body: { script_id: scriptId },
    });
    // A refusal (no active plan is HTTP 402) arrives as a bare "non-2xx" error
    // with the answer inside it.
    const said = (data as Record<string, unknown> | null) ?? (error ? await refusalBody(error) : null);
    if (error || said?.error) {
      setError(
        said?.error === "no_active_plan"
          ? "No active plan — subscribe or use a one-time unlock."
          : said?.error === "unreadable_script"
            ? (typeof said?.message === "string"
                ? said.message
                : "We couldn't read any lines from this PDF yet, so there is nothing to unlock.")
            : typeof said?.error === "string"
              ? said.error
              : (error?.message ?? "Couldn't unlock.")
      );
      setBusy(null);
      return;
    }
    setUnlockedHere(true);
    setBusy(null);
    router.refresh();
  }

  async function unlockOnce() {
    setBusy("once");
    setError(null);
    const origin = window.location.origin;
    const { data, error } = await getBrowserClient().functions.invoke("create-checkout-session", {
      body: {
        script_id: scriptId,
        success_url: `${origin}/script/${scriptId}?unlocked=1`,
        cancel_url: `${origin}/script/${scriptId}`,
      },
    });
    if (error || data?.error || !data?.url) {
      setError(data?.error ?? error?.message ?? "Couldn't start checkout.");
      setBusy(null);
      return;
    }
    window.location.href = data.url;
  }

  const onceButton = (
    <button
      onClick={unlockOnce}
      disabled={!!busy}
      className={
        active
          ? "text-sm font-medium text-taupe underline decoration-tan underline-offset-4 hover:text-brick disabled:opacity-60"
          : "rounded-lg bg-brick px-5 py-2.5 font-medium text-white disabled:opacity-60"
      }
    >
      {busy === "once"
        ? "Starting checkout…"
        : active
          ? `or pay ${UNLOCK_PRICE} once`
          : `Unlock full read · ${UNLOCK_PRICE}`}
    </button>
  );

  return (
    <div id="owner-unlock" className="mt-8 rounded-xl border border-tan bg-ivory p-5">
      <div className="font-slab text-lg">Unlock the full read</div>

      {active ? (
        <>
          <p className="mt-1 text-sm text-taupe">
            Unlocking is included in your {planLabel(plan!.plan)} plan. Voicing this script costs
            about <span className="font-medium text-ink">{estCredits} credits</span> — you have{" "}
            {plan!.credits}.
          </p>
          {error && <p className="mt-2 text-sm text-brick">{error}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <button
              onClick={unlockWithPlan}
              disabled={!!busy}
              className="rounded-lg bg-brick px-5 py-2.5 font-medium text-white disabled:opacity-60"
            >
              {busy === "plan" ? "Unlocking…" : "Unlock with your plan"}
            </button>
            {onceButton}
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm text-taupe">
            The read is locked. Unlock to voice the entire script with full narration, plus MP4 and
            MP3 downloads. One-time — yours forever, and it includes{" "}
            <span className="font-medium text-ink">{unlockCredits} voice credits</span>
            {spare < 0
              ? `. This script is long enough to need about ${estCredits}, so voicing all of it would take a top-up as well.`
              : roomToRecast
                ? ` (this script needs about ${estCredits}, so there is room to re-cast a role).`
                : ` (this script needs about ${estCredits}).`}
          </p>
          {error && <p className="mt-2 text-sm text-brick">{error}</p>}
          <div className="mt-3">{onceButton}</div>
          <p className="mt-3 text-xs text-muted">
            Voicing more than one script?{" "}
            <Link href={pricingHref(scriptId)} className="text-brick hover:underline">
              {`Plans start at ${PLANS_FROM}/mo →`}
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
