"use client";

import { useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";
import type { PlanId } from "@/lib/shared/plans";

/** Starts a monthly subscription checkout for one tier. Signed-out visitors are
 *  routed to sign-in first, then back to pricing. */
export function SubscribeButton({
  plan,
  label,
  className,
}: {
  plan: PlanId;
  label: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function subscribe() {
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      window.location.href = "/sign-in?next=/pricing";
      return;
    }
    const origin = window.location.origin;
    const { data, error } = await supabase.functions.invoke("create-checkout-session", {
      body: {
        plan,
        success_url: `${origin}/settings/billing?subscribed=1`,
        cancel_url: `${origin}/pricing`,
      },
    });
    if (error || data?.error || !data?.url) {
      setError(data?.error ?? error?.message ?? "Couldn't start checkout.");
      setBusy(false);
      return;
    }
    window.location.href = data.url;
  }

  return (
    <div>
      <button onClick={subscribe} disabled={busy} className={className}>
        {busy ? "Starting checkout…" : label}
      </button>
      {error && <p className="mt-2 text-sm text-brick">{error}</p>}
    </div>
  );
}
