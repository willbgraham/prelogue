"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";
import {
  PLANS,
  TOPUPS,
  TOPUP_ORDER,
  dollars,
  isActiveStatus,
  isPlanId,
  planCredits,
  planLabel,
} from "@/lib/shared/plans";

type Billing = {
  plan: string | null;
  status: string | null;
  credits: number;
  renewsAt: string | null;
  customerId: string | null;
};
type LedgerRow = {
  id: string;
  delta: number;
  reason: string;
  balance_after: number;
  created_at: string;
};

const REASON_LABEL: Record<string, string> = {
  plan_grant: "Monthly credits",
  topup: "Credit top-up",
  unlock_grant: "Script unlock",
  generation: "Voice generation",
  preview: "Line previews",
  admin: "Adjustment",
};

const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : "—";
const fmtShort = (d: string) =>
  new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export default function BillingPage() {
  const router = useRouter();
  const [justPaid, setJustPaid] = useState(false);
  const [loading, setLoading] = useState(true);
  const [b, setB] = useState<Billing | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [portalBusy, setPortalBusy] = useState(false);
  const [topUpBusy, setTopUpBusy] = useState<string | null>(null);
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
    const [{ data }, { data: rows }] = await Promise.all([
      supabase
        .from("users")
        .select("plan, plan_status, credits_balance, plan_renews_at, stripe_customer_id")
        .eq("id", user.id)
        .single(),
      supabase
        .from("credit_ledger")
        .select("id, delta, reason, balance_after, created_at")
        .order("created_at", { ascending: false })
        .limit(12),
    ]);
    setB({
      plan: data?.plan ?? null,
      status: data?.plan_status ?? null,
      credits: data?.credits_balance ?? 0,
      renewsAt: data?.plan_renews_at ?? null,
      customerId: data?.stripe_customer_id ?? null,
    });
    setLedger((rows as LedgerRow[]) ?? []);
    setLoading(false);
  }, [router]);

  useEffect(() => {
    load();
    const params = new URLSearchParams(window.location.search);
    const subscribed = params.get("subscribed") === "1";
    const topped = params.get("credits") === "1";
    setJustPaid(subscribed || topped);
    // Subscribe is reported server-side now (stripe-webhook → Conversions
    // API); firing it here too would double-count.
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

  async function buyCredits(topup: string) {
    setTopUpBusy(topup);
    setError(null);
    const origin = window.location.origin;
    const { data, error } = await getBrowserClient().functions.invoke("create-checkout-session", {
      body: {
        topup,
        success_url: `${origin}/settings/billing?credits=1`,
        cancel_url: `${origin}/settings/billing`,
      },
    });
    if (error || data?.error || !data?.url) {
      setError(data?.error ?? error?.message ?? "Couldn't start checkout.");
      setTopUpBusy(null);
      return;
    }
    window.location.href = data.url;
  }

  if (loading) return <main className="mx-auto max-w-2xl px-6 py-16 text-taupe">Loading…</main>;

  const active = !!b && isActiveStatus(b.status) && isPlanId(b.plan);
  const allowance = active ? planCredits(b!.plan) : 0;
  const credits = b?.credits ?? 0;
  const pct = allowance > 0 ? Math.min(100, Math.round((credits / allowance) * 100)) : 0;

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      <Link href="/settings/profile" className="text-sm text-taupe hover:text-ink">
        ← Settings
      </Link>
      <h1 className="mt-6 font-slab text-3xl">Billing &amp; credits</h1>

      {justPaid && (
        <div className="mt-5 rounded-lg bg-forest/10 px-4 py-3 text-sm text-forest">
          Thanks! Your credits are being applied. If the balance below looks stale,{" "}
          <button onClick={load} className="font-medium underline">
            refresh
          </button>
          .
        </div>
      )}
      {error && <p className="mt-4 rounded-lg bg-brick/10 px-4 py-2 text-sm text-brick">{error}</p>}

      {/* Credit balance */}
      <div className="mt-6 rounded-2xl border border-tan bg-ivory p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="font-mono text-xs uppercase tracking-wider text-muted">
            Voice credits
          </div>
          {active && (
            <span className="text-xs text-muted">
              {allowance} refill on {fmtDate(b!.renewsAt)}
            </span>
          )}
        </div>
        <div className="mt-1 font-slab text-4xl">{credits}</div>
        {active && (
          <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-elevated">
            <div className="h-full rounded-full bg-brick" style={{ width: `${pct}%` }} />
          </div>
        )}
        <p className="mt-3 text-sm text-taupe">
          1 credit voices about 1,000 characters of speech. A 10-page short costs roughly 7
          credits, a 100-page feature about 85. Replays, edits and re-listening are always free —
          you only spend when new audio is generated.
        </p>
      </div>

      {/* Top-ups */}
      <h2 className="mt-8 font-slab text-lg">Add credits</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {TOPUP_ORDER.map((id) => {
          const t = TOPUPS[id];
          return (
            <button
              key={id}
              onClick={() => buyCredits(id)}
              disabled={!!topUpBusy}
              className="rounded-xl border border-tan bg-ivory p-4 text-left hover:border-brick disabled:opacity-60"
            >
              <div className="font-slab text-2xl">{t.credits}</div>
              <div className="text-xs uppercase tracking-wide text-muted">credits</div>
              <div className="mt-2 font-medium text-brick">
                {topUpBusy === id ? "Starting…" : dollars(t.price_cents)}
              </div>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted">
        Top-up credits never expire and stack on top of your monthly refill.
      </p>

      {/* Plan */}
      <h2 className="mt-8 font-slab text-lg">Plan</h2>
      {active ? (
        <div className="mt-3 rounded-2xl border border-tan bg-ivory p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="font-slab text-2xl">
              {planLabel(b!.plan)}
              <span className="ml-2 text-base font-normal text-muted">
                {dollars(PLANS[b!.plan as keyof typeof PLANS].price_cents)}/mo
              </span>
            </div>
            {b!.status === "past_due" && (
              <span className="rounded-full bg-brick/10 px-2.5 py-1 text-xs font-medium text-brick">
                Payment past due
              </span>
            )}
          </div>
          <p className="mt-2 text-sm text-taupe">
            {allowance} credits a month, topped up each billing period.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
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
        </div>
      ) : (
        <div className="mt-3 rounded-2xl border border-tan bg-ivory p-6">
          <div className="font-slab text-2xl">Free</div>
          <p className="mt-2 text-sm text-taupe">
            You&rsquo;re on the free plan: browse public reads and play the demo scene. Subscribe
            for monthly credits, or buy a pack above.
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

      {/* Ledger */}
      {ledger.length > 0 && (
        <>
          <h2 className="mt-8 font-slab text-lg">Recent activity</h2>
          <div className="mt-3 overflow-hidden rounded-xl border border-tan bg-ivory">
            {ledger.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between gap-3 border-b border-tan/60 px-4 py-2.5 text-sm last:border-0"
              >
                <span>{REASON_LABEL[r.reason] ?? r.reason}</span>
                <span className="ml-auto text-xs text-muted">{fmtShort(r.created_at)}</span>
                <span
                  className={`w-16 text-right font-medium ${
                    r.delta > 0 ? "text-forest" : "text-taupe"
                  }`}
                >
                  {r.delta > 0 ? `+${r.delta}` : r.delta}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
