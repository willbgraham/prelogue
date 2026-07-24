"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getBrowserClient } from "@/lib/supabase/client";
import { isActiveStatus, isPlanId, planLabel, planPages } from "@/lib/shared/plans";

type PlanState = {
  plan: string | null;
  status: string | null;
  used: number;
  renewsAt: string | null;
} | null;

/** Owner-only unlock of a script's full read. Two ways to pay:
 *   • the writer's monthly plan (spends page_count from their budget), or
 *   • a one-time $19 checkout.
 * Free/over-budget writers see the $19 option plus a nudge toward a plan. */
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
        .select("plan, plan_status, plan_pages_used, plan_renews_at")
        .eq("id", user.id)
        .single();
      if (data) {
        setPlan({
          plan: data.plan ?? null,
          status: data.plan_status ?? null,
          used: data.plan_pages_used ?? 0,
          renewsAt: data.plan_renews_at ?? null,
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

  const pages = Math.max(1, pageCount ?? 30);
  const active = !!plan && isActiveStatus(plan.status) && isPlanId(plan.plan);
  const allowance = active ? planPages(plan!.plan) : 0;
  // Mirror the server's lazy reset: if the period end has passed, the budget is
  // treated as fresh (the renewal webhook will confirm it).
  const periodOver =
    !!plan?.renewsAt && Date.now() > new Date(plan.renewsAt).getTime();
  const used = periodOver ? 0 : plan?.used ?? 0;
  const remaining = Math.max(0, allowance - used);
  const canPlanUnlock = active && remaining >= pages;

  async function unlockWithPlan() {
    setBusy("plan");
    setError(null);
    const { data, error } = await getBrowserClient().functions.invoke("subscription-unlock", {
      body: { script_id: scriptId },
    });
    if (error || data?.error) {
      setError(
        data?.error === "over_budget"
          ? "That would go over your monthly pages. Upgrade or use a one-time unlock."
          : data?.error === "no_active_plan"
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
        canPlanUnlock
          ? "text-sm font-medium text-taupe underline decoration-tan underline-offset-4 hover:text-brick disabled:opacity-60"
          : "rounded-lg bg-brick px-5 py-2.5 font-medium text-white disabled:opacity-60"
      }
    >
      {busy === "once" ? "Starting checkout…" : canPlanUnlock ? "or pay $19 once" : "Unlock full read · $19"}
    </button>
  );

  return (
    <div className="mt-8 rounded-xl border border-tan bg-ivory p-5">
      <div className="font-slab text-lg">Unlock the full read</div>

      {canPlanUnlock ? (
        <>
          <p className="mt-1 text-sm text-taupe">
            Listeners currently hear a short preview. Unlock to voice the entire script — every
            line, with full narration — and share it privately, invite-only.
          </p>
          <p className="mt-2 text-sm text-forest">
            Included in your {planLabel(plan!.plan)} plan · uses about {pages}{" "}
            {pages === 1 ? "page" : "pages"} of your {remaining} left this month.
          </p>
          {error && <p className="mt-2 text-sm text-brick">{error}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <button
              onClick={unlockWithPlan}
              disabled={!!busy}
              className="rounded-lg bg-brick px-5 py-2.5 font-medium text-white disabled:opacity-60"
            >
              {busy === "plan" ? "Unlocking…" : `Unlock with your ${planLabel(plan!.plan)} plan`}
            </button>
            {onceButton}
          </div>
        </>
      ) : active ? (
        <>
          <p className="mt-1 text-sm text-taupe">
            You&rsquo;ve used {used} of {allowance} pages this month, and this script needs about{" "}
            {pages}. Upgrade for a bigger monthly budget, or unlock just this one.
          </p>
          {error && <p className="mt-2 text-sm text-brick">{error}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <Link
              href="/pricing"
              className="rounded-lg bg-brick px-5 py-2.5 font-medium text-white"
            >
              Upgrade plan
            </Link>
            {onceButton}
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm text-taupe">
            Listeners currently hear a short preview. Unlock to voice the entire script with full
            narration and share it privately, invite-only. One-time — yours forever.
          </p>
          {error && <p className="mt-2 text-sm text-brick">{error}</p>}
          <div className="mt-3">{onceButton}</div>
          <p className="mt-3 text-xs text-muted">
            Unlocking more than one script?{" "}
            <Link href="/pricing" className="text-brick hover:underline">
              Plans start at $19/mo →
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
