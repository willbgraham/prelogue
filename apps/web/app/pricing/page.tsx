import Link from "next/link";
import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { SubscribeButton } from "@/components/SubscribeButton";
import { PLANS, PLAN_ORDER, PLAN_FEATURES, dollars } from "@/lib/shared/plans";

export const metadata: Metadata = {
  title: "Pricing - Prelogue Studio",
  description:
    "Plans from $19/mo with monthly voice credits, or unlock a single script for $19 one-time. Listening is always free.",
};

const DEMO_SCRIPT_SLUG = "booth-nine";

const FREE = [
  "Browse and listen to public table reads",
  "Play the full demo scene and try voices, emotions, and casting",
  "Pick voices from the full library and preview them",
  "Record your own reads as an actor by webcam",
];

export default function Pricing() {
  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <SiteHeader />

      <section className="mt-12 max-w-2xl">
        <h1 className="font-slab text-4xl leading-tight sm:text-5xl">
          Pricing that scales with your writing
        </h1>
        <p className="mt-4 text-taupe">
          Listening is free. Pick a monthly plan and spend credits voicing whatever you like, or
          pay once for a single script. Every plan includes the whole studio: 900+ voices, per-line
          emotion, scene music, and MP4 export.
        </p>
      </section>

      {/* Subscription tiers */}
      <section className="mt-10 grid gap-5 lg:grid-cols-3">
        {PLAN_ORDER.map((id) => {
          const p = PLANS[id];
          return (
            <div
              key={id}
              className={`relative rounded-2xl border bg-ivory p-8 ${
                p.highlight ? "border-2 border-brick bg-elevated" : "border-tan"
              }`}
            >
              {p.highlight && (
                <span className="absolute -top-3 left-8 rounded-full bg-brick px-3 py-1 text-xs font-medium text-white">
                  Most popular
                </span>
              )}
              <div className="font-mono text-xs uppercase tracking-wider text-muted">{p.label}</div>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="font-slab text-4xl">{dollars(p.price_cents)}</span>
                <span className="text-sm text-muted">/mo</span>
              </div>
              <div className="mt-1 text-sm font-medium text-brick">
                {p.credits} credits / month
              </div>
              <p className="mt-3 text-sm text-taupe">{p.blurb}</p>
              <SubscribeButton
                plan={id}
                label={`Choose ${p.label}`}
                className={`mt-6 w-full rounded-xl px-5 py-3 font-medium ${
                  p.highlight
                    ? "bg-brick text-white"
                    : "border border-brick text-brick hover:bg-brick/5"
                }`}
              />
            </div>
          );
        })}
      </section>

      <section className="mt-6 rounded-2xl border border-tan bg-ivory p-6">
        <div className="font-mono text-xs uppercase tracking-wider text-muted">
          Every plan includes
        </div>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {PLAN_FEATURES.map((f) => (
            <li key={f} className="flex gap-3 text-sm text-taupe">
              <span className="text-forest">✓</span>
              <span>{f}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-muted">
          One credit voices about 1,000 characters of speech: a 10-page short is roughly 7 credits,
          a 100-page feature about 85. You only spend credits when new audio is generated —
          replays, edits, re-listening and downloads are always free, and re-selecting a voice
          you&rsquo;ve already used costs nothing. Credits refill every billing cycle, and you can
          add more anytime.
        </p>
      </section>

      {/* Free + one-time */}
      <h2 className="mt-14 font-slab text-2xl">Not ready for a plan?</h2>
      <section className="mt-5 grid gap-5 lg:grid-cols-2">
        <div className="rounded-2xl border border-tan bg-ivory p-8">
          <div className="font-mono text-xs uppercase tracking-wider text-muted">For everyone</div>
          <h3 className="mt-2 font-slab text-2xl">Free</h3>
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

        <div className="rounded-2xl border border-tan bg-ivory p-8">
          <div className="font-mono text-xs uppercase tracking-wider text-muted">
            One script only
          </div>
          <h3 className="mt-2 font-slab text-2xl">Single unlock</h3>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-slab text-4xl">$19</span>
            <span className="text-sm text-muted">one-time, per script</span>
          </div>
          <p className="mt-4 text-sm text-taupe">
            Just one script to perform? Unlock its full read once and keep it forever, with no
            subscription. Includes MP4 and MP3 downloads and free replays. Private invite sharing
            comes with plans.
          </p>
          <Link
            href="/studio/upload"
            className="mt-7 inline-flex rounded-xl bg-brick px-5 py-3 font-medium text-white"
          >
            Upload a script
          </Link>
        </div>
      </section>

      <p className="mt-8 text-center text-sm text-muted">
        Prices in USD. Cancel anytime from your billing settings. One-time unlocks are permanent and
        never count against a plan.
      </p>
    </main>
  );
}
