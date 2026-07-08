import Link from "next/link";
import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = {
  title: "Pricing - Prelogue",
  description:
    "Free to browse and listen. Unlock a full AI table read of your script for $19 one-time — no subscription.",
};

const DEMO_SCRIPT_SLUG = "booth-nine";

const FREE = [
  "Browse and listen to public table reads",
  "Hear the opening scene of any script with AI voices",
  "Pick voices from the full library and preview them",
  "Record your own reads as an actor by webcam",
];

const UNLOCK = [
  "The complete AI table read — every line of dialogue and narration",
  "Private, invite-only sharing — only people you invite can view",
  "Free replays forever once it's generated",
  "No subscription — pay once per script",
];

export default function Pricing() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <SiteHeader />

      <section className="mt-12 max-w-2xl">
        <h1 className="font-slab text-4xl leading-tight sm:text-5xl">
          Simple, one-time pricing
        </h1>
        <p className="mt-4 text-taupe">
          Listening is free. Pay once — only for the scripts you want performed
          in full. No subscriptions, no per-minute charges.
        </p>
      </section>

      <section className="mt-12 grid gap-5 lg:grid-cols-2">
        {/* Free */}
        <div className="rounded-2xl border border-tan bg-ivory p-8">
          <div className="font-mono text-xs uppercase tracking-wider text-muted">
            For everyone
          </div>
          <h2 className="mt-2 font-slab text-2xl">Free</h2>
          <div className="mt-1 font-slab text-4xl">$0</div>
          <ul className="mt-6 space-y-3">
            {FREE.map((f) => (
              <li key={f} className="flex gap-3 text-sm text-taupe">
                <span className="text-forest">✓</span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
          <Link
            href={`/script/${DEMO_SCRIPT_SLUG}`}
            className="mt-7 inline-flex rounded-xl border border-tan px-5 py-3 font-medium text-taupe hover:bg-elevated"
          >
            ▶ Try the demo scene
          </Link>
        </div>

        {/* Full Script Unlock */}
        <div className="rounded-2xl border-2 border-brick bg-elevated p-8">
          <div className="font-mono text-xs uppercase tracking-wider text-brick">
            For writers
          </div>
          <h2 className="mt-2 font-slab text-2xl">Full Script Unlock</h2>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-slab text-4xl">$19</span>
            <span className="text-sm text-muted">one-time, per script</span>
          </div>
          <ul className="mt-6 space-y-3">
            {UNLOCK.map((f) => (
              <li key={f} className="flex gap-3 text-sm text-ink">
                <span className="text-brick">✓</span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
          <Link
            href="/studio/upload"
            className="mt-7 inline-flex rounded-xl bg-brick px-5 py-3 font-medium text-white"
          >
            Upload a script
          </Link>
        </div>
      </section>

      <p className="mt-8 text-center text-sm text-muted">
        Prices in USD. The unlock covers one script and is a one-time payment —
        replays never cost extra.
      </p>
    </main>
  );
}
