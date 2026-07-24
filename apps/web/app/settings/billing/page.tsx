"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";
import {
  PLANS,
  dollars,
  isActiveStatus,
  isPlanId,
  planLabel,
  planPages,
} from "@/lib/shared/plans";

type Billing = {
  plan: string | null;
  status: string | null;
  used: number;
  renewsAt: string | null;
  customerId: string | null;
  subscriptionId: string | null;
};

const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : "—";

export default function BillingPage() {
  const router = useRouter();
  const [justSubscribed, setJustSubscribed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [b, setB] = useState<Billing | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = getBrowserClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.push("/sign-in?next=/settings/billing");
      return;
    }
    const { data } = await supabase
      .from("users")
      .select("plan, plan_status, plan_pages_used, plan_renews_at, stripe_customer_id, stripe_subscription_id")
      .eq("id", user.id)
      .single();
    setB({
      plan: data?.plan ?? null,
      status: data?.plan_status ?? null,
      used: data?.plan_pages_used ?? 0,
      renewsAt: data?.plan_renews_at ?? null,
      customerId: data?.stripe_customer_id ?? null,
      subscriptionId: data?.stripe_subscription_id ?? null,
    });
    setLoading(false);
  }, [router]);

  useEffect(() => {
    load();
    setJustSubscribed(new URLSearchParams(window.location.search).get("subscribed") === "1");
  }, [load]);

  async function openPortal() {
    setPortalBusy(true);
    setError(null);
    const { data, error } = await getBrowserClient().functions.invoke("create-portal-session", {
      body: { return_url: `${window.location.origin}/settings/billing` },
    });
    if (error || data?.error || !data?.url) {
      setError(data?.error ?? error?.message ?? "Couldn't open the billing portal.");
      setPortalBusy(false);
      return;
    }
    window.location.href = data.url;
  }

  if (loading) return <main className="mx-auto max-w-2xl px-6 py-16 text-taupe">Loading…</main>;

  const active = !!b && isActiveStatus(b.status) && isPlanId(b.plan);
  const allowance = active ? planPages(b!.plan) : 0;
  const periodOver = !!b?.renewsAt && Date.now() > new Date(b.renewsAt).getTime();
  const used = periodOver ? 0 : b?.used ?? 0;
  const remaining = Math.max(0, allowance - used);
  const pct = allowance > 0 ? Math.min(100, Math.round((used / allowance) * 100)) : 0;

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      <Link href="/settings/profile" className="text-sm text-taupe hover:text-ink">
        ← Settings
      </Link>
      <h1 className="mt-6 font-slab text-3xl">Billing</h1>

      {justSubscribed && (
        <div className="mt-5 rounded-lg bg-forest/10 px-4 py-3 text-sm text-forest">
          Thanks for subscribing! Your plan is being activated. If it doesn&rsquo;t show below in a
          moment,{" "}
          <button onClick={load} className="font-medium underline">
            refresh
          </button>
          .
        </div>
      )}
      {error && <p className="mt-4 rounded-lg bg-brick/10 px-4 py-2 text-sm text-brick">{error}</p>}

      {active ? (
        <div className="mt-6 rounded-2xl border border-tan bg-ivory p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <div className="font-mono text-xs uppercase tracking-wider text-muted">
                Current plan
              </div>
              <div className="mt-1 font-slab text-2xl">
                {planLabel(b!.plan)}
                <span className="ml-2 text-base font-normal text-muted">
                  {dollars(PLANS[b!.plan as keyof typeof PLANS].price_cents)}/mo
                </span>
              </div>
            </div>
            {b!.status === "past_due" && (
              <span className="rounded-full bg-brick/10 px-2.5 py-1 text-xs font-medium text-brick">
                Payment past due
              </span>
            )}
          </div>

          <div className="mt-5">
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-medium">Pages this month</span>
              <span className="text-taupe">
                {used} / {allowance} used · {remaining} left
              </span>
            </div>
            <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-elevated">
              <div className="h-full rounded-full bg-brick" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-2 text-xs text-muted">
              Budget resets {fmtDate(b!.renewsAt)}. Unlocking a script spends its pages once; replays
              and edits are free forever.
            </p>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              onClick={openPortal}
              disabled={portalBusy}
              className="rounded-lg bg-brick px-5 py-2.5 text-sm font-medium text-white disabled:opacity-60"
            >
              {portalBusy ? "Opening…" : "Manage billing"}
            </button>
            <Link
              href="/pricing"
              className="rounded-lg border border-tan px-5 py-2.5 text-sm font-medium text-taupe hover:bg-elevated"
            >
              Change plan
            </Link>
          </div>
          <p className="mt-3 text-xs text-muted">
            Manage billing opens Stripe, where you can update your card, switch plans, or cancel.
          </p>
        </div>
      ) : (
        <div className="mt-6 rounded-2xl border border-tan bg-ivory p-6">
          <div className="font-mono text-xs uppercase tracking-wider text-muted">Current plan</div>
          <div className="mt-1 font-slab text-2xl">Free</div>
          <p className="mt-2 text-sm text-taupe">
            You&rsquo;re on the free plan: listen to public reads and hear the opening scene of any
            script. Subscribe to unlock full table reads by the month, or unlock a single script for
            $19.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              href="/pricing"
              className="rounded-lg bg-brick px-5 py-2.5 text-sm font-medium text-white"
            >
              See plans
            </Link>
            {b?.customerId && (
              <button
                onClick={openPortal}
                disabled={portalBusy}
                className="rounded-lg border border-tan px-5 py-2.5 text-sm font-medium text-taupe hover:bg-elevated disabled:opacity-60"
              >
                {portalBusy ? "Opening…" : "Billing history"}
              </button>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
