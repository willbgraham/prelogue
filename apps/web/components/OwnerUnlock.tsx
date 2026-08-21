"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getBrowserClient } from "@/lib/supabase/client";
import {
  ONE_TIME_UNLOCK_CREDITS,
  creditsForPages,
  isActiveStatus,
  isPlanId,
  planLabel,
} from "@/lib/shared/plans";

type PlanState = {
  plan: string | null;
  status: string | null;
  credits: number;
} | null;

/**
 * Owner-only unlock of a script's full read. Two ways in:
 *   • an active plan — unlocking costs nothing, voicing spends credits, or
 *   • a one-time $19 purchase, which unlocks the script and grants credits.
 * Unlocking is only access; credits are what meter the actual generation.
 */
export function OwnerUnlock({
  scriptId,
  unlocked: initialUnlocked,
  pageCount,
}: {
  scriptId: string;
  unlocked: boolean;
  pageCount?: number | null;
}) {
  const router = useRouter();
  const [unlocked, setUnlocked] = useState(initialUnlocked);
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
  const estCredits = creditsForPages(Math.max(1, pageCount ?? 30));

  async function unlockWithPlan() {
    setBusy("plan");
    setError(null);
    const { data, error } = await getBrowserClient().functions.invoke("subscription-unlock", {
      body: { script_id: scriptId },
    });
    if (error || data?.error) {
      setError(
        data?.error === "no_active_plan"
          ? "No active plan — subscribe or use a one-time unlock."
          : data?.error ?? error?.message ?? "Couldn't unlock."
      );
      setBusy(null);
      return;
    }
    setUnlocked(true);
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
          ? "or pay $19 once"
          : `Unlock full read · $19`}
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
            {ONE_TIME_UNLOCK_CREDITS} voice credits (this script needs about {estCredits}).
          </p>
          {error && <p className="mt-2 text-sm text-brick">{error}</p>}
          <div className="mt-3">{onceButton}</div>
          <p className="mt-3 text-xs text-muted">
            Voicing more than one script?{" "}
            <Link href="/pricing" className="text-brick hover:underline">
              Plans start at $19/mo →
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
