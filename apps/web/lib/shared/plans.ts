// Subscription tiers, metered in CREDITS.
//
// 1 credit = 1,000 characters of generated speech. Measured on real scripts:
// a 10-page short ≈ 7 credits, a 33-page script ≈ 32, a 105-page feature ≈ 88.
//
// Credits meter GENERATION, not unlocks — re-casting a script costs the same as
// the first pass, so this is what actually bounds cost. Grants are sized so
// that even 100% consumption stays comfortably profitable on every plan and
// every top-up pack, which is the whole point: no usage pattern can lose money.
//
// KEEP IN SYNC with the Deno edge functions, which each carry their own copy
// (they can't import from apps/web):
//   supabase/functions/create-checkout-session/index.ts
//   supabase/functions/stripe-webhook/index.ts
//   supabase/functions/generate-voice-cues/index.ts
//   supabase/functions/preview-voice-line/index.ts

export type PlanId = "growth" | "pro" | "studio";

export type Plan = {
  id: PlanId;
  label: string;
  price_cents: number;
  credits: number;
  blurb: string;
  highlight?: boolean;
};

/** Characters of speech per credit. */
export const CHARS_PER_CREDIT = 1000;

/** Credits a script costs to voice once, from its spoken character count. */
export const creditsForChars = (chars: number) => Math.max(1, Math.ceil(chars / CHARS_PER_CREDIT));

/** Rough credits for a script by page count (~850 spoken chars/page). */
export const creditsForPages = (pages: number) => Math.max(1, Math.ceil((pages * 850) / CHARS_PER_CREDIT));

export const PLANS: Record<PlanId, Plan> = {
  growth: {
    id: "growth",
    label: "Growth",
    price_cents: 1900,
    credits: 100,
    blurb: "A feature script a month, with room to re-cast a few roles.",
  },
  pro: {
    id: "pro",
    label: "Pro",
    price_cents: 3900,
    credits: 225,
    blurb: "Two features a month, or one you keep re-casting until it sings.",
    highlight: true,
  },
  studio: {
    id: "studio",
    label: "Studio",
    price_cents: 5900,
    credits: 375,
    blurb: "Four features a month: a writers' room's worth of listening.",
  },
};

export const PLAN_ORDER: PlanId[] = ["growth", "pro", "studio"];

/** One-off credit packs, for when a month's allowance runs out. */
export type TopUpId = "small" | "medium" | "large";
export const TOPUPS: Record<TopUpId, { id: TopUpId; credits: number; price_cents: number }> = {
  small: { id: "small", credits: 100, price_cents: 1500 },
  medium: { id: "medium", credits: 250, price_cents: 3500 },
  large: { id: "large", credits: 600, price_cents: 7900 },
};
export const TOPUP_ORDER: TopUpId[] = ["small", "medium", "large"];

/** Credits granted by the one-time per-script unlock. */
export const ONE_TIME_UNLOCK_CREDITS = 150;

// Every paid tier includes the whole toolkit; tiers differ only by credits.
export const PLAN_FEATURES = [
  "Full AI table reads: every line of dialogue and narration",
  "900+ voices, per-line emotion, speed and tone controls",
  "Scene background music and ambience",
  "MP4 and MP3 downloads of any read you've voiced",
  "Private, invite-only sharing (plans only)",
  "Real actors can record your roles; host live table reads",
];

export const isPlanId = (v: unknown): v is PlanId =>
  v === "growth" || v === "pro" || v === "studio";

export const planCredits = (plan: string | null | undefined): number =>
  isPlanId(plan) ? PLANS[plan].credits : 0;

export const planLabel = (plan: string | null | undefined): string =>
  isPlanId(plan) ? PLANS[plan].label : "Free";

export const isActiveStatus = (status: string | null | undefined): boolean =>
  status === "active" || status === "trialing";

export const dollars = (cents: number) => `$${Math.round(cents / 100)}`;
