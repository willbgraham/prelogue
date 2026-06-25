"use client";

import { useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";

/** Owner-only $19 one-time unlock (full narration + invite-only). Web checkout
 *  redirects to Stripe and returns to prelogue.studio (via the success_url). */
export function OwnerUnlock({ scriptId, unlocked }: { scriptId: string; unlocked: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (unlocked) {
    return (
      <div className="mt-8 inline-flex items-center gap-2 rounded-lg bg-forest/10 px-4 py-2 text-sm font-medium text-forest">
        ✓ Full read unlocked
      </div>
    );
  }

  async function unlock() {
    setBusy(true);
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
      setBusy(false);
      return;
    }
    window.location.href = data.url;
  }

  return (
    <div className="mt-8 rounded-xl border border-tan bg-ivory p-5">
      <div className="font-slab text-lg">Unlock the full read</div>
      <p className="mt-1 text-sm text-taupe">
        Listeners currently hear a short preview. Unlock to voice the entire script with full
        narration and share it privately, invite-only. One-time — yours forever.
      </p>
      {error && <p className="mt-2 text-sm text-brick">{error}</p>}
      <button
        onClick={unlock}
        disabled={busy}
        className="mt-3 rounded-lg bg-brick px-5 py-2.5 font-medium text-white disabled:opacity-60"
      >
        {busy ? "Starting checkout…" : "Unlock full read · $19"}
      </button>
    </div>
  );
}
