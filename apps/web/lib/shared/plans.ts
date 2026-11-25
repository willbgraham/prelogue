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
    // 150, not 100: a feature needs 88 to 175 credits to voice once (a 121-page
    // script needed 120), and the one-time unlock at the same $19 includes at
    // least 150. At 100 a new subscriber was asked for a top-up minutes after
    // paying, to hear the script he had subscribed for (Nov 2026).
    credits: 150,
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

// The one-time per-script unlock includes the credits to voice that script: one
// full read of it and a quarter again for re-casting, never less than 150 (what
// every unlock included before it was sized) and never more than 400 (about $16
// of speech against the $19 paid). A flat 150 left a description-heavy feature
// short: one needed 175, and its writer had to buy a top-up to finish.
// KEEP IN SYNC with supabase/functions/_shared/credits.ts, which fixes the
// figure at checkout and grants it.
export const UNLOCK_MIN_CREDITS = 150;
export const UNLOCK_MAX_CREDITS = 400;

/** Credits the one-time unlock includes for a script with this many spoken characters. */
export const unlockCreditsForChars = (chars: number): number => {
  const read = chars > 0 && isFinite(chars) ? Math.ceil(chars / CHARS_PER_CREDIT) : 0;
  const sized = read + Math.ceil(read / 4);
  return Math.min(UNLOCK_MAX_CREDITS, Math.max(UNLOCK_MIN_CREDITS, sized));
};

/**
 * Credits a first full read is likely to use, for telling a writer what their
 * script takes. A little over the plain character count because each
 * generation run is charged in whole credits: measured on six features voiced
 * once, 4–10% over (175 charged for 166,622 characters; 98 for 90,297).
 */
export const readCreditsEstimate = (chars: number): number =>
  chars > 0 && isFinite(chars) ? Math.ceil((chars * 1.07) / CHARS_PER_CREDIT) : 0;

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
