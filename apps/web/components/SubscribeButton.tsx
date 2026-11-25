"use client";

import { useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";
import { startPlanCheckout } from "@/lib/checkoutReturn";
import type { PlanId } from "@/lib/shared/plans";

/** Starts a monthly subscription checkout for one tier. Signed-out visitors are
 *  routed to sign-in first, then back to pricing. After paying, the writer is
 *  returned to their script (the one they came from, named in the address as
 *  `?script=`, else the one they uploaded last) with it unlocked: see
 *  lib/checkoutReturn.ts. */
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
    const started = await startPlanCheckout(getBrowserClient(), {
      plan,
      origin: window.location.origin,
      // Read on the press, not while rendering: the plans page stays a static page.
      search: window.location.search,
    });
    if (started.kind === "error") {
      setError(started.message);
      setBusy(false);
      return;
    }
    window.location.href = started.href;
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
