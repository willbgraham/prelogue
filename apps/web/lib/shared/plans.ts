// Subscription tiers, metered by PAGES PER MONTH. Unlocking a script's full read
// spends its page_count from your monthly budget; the unlock is permanent and the
// budget resets each billing period. The one-time $19 per-script unlock
// (OwnerUnlock / create-checkout-session) stays for occasional writers.
//
// KEEP IN SYNC with the Deno edge functions, which each carry their own copy of
// these numbers (they can't import from apps/web):
//   supabase/functions/create-checkout-session/index.ts
//   supabase/functions/subscription-unlock/index.ts
//   supabase/functions/stripe-webhook/index.ts

export type PlanId = "growth" | "pro" | "studio";

export type Plan = {
  id: PlanId;
  label: string;
  price_cents: number;
  pages: number; // pages of scripts you can unlock per month
  blurb: string;
  highlight?: boolean;
};

export const PLANS: Record<PlanId, Plan> = {
  // Page allowances are sized so every tier stays profitable even when fully
  // used: generation costs ~2,400 ElevenLabs credits/page (~$0.40), measured on
  // real scripts. Unlocking is permanent and replays/edits are free, so most
  // writers use their allowance once and then cost nothing.
  growth: {
    id: "growth",
    label: "Growth",
    price_cents: 1900,
    pages: 50,
    blurb: "A feature script a month, or a handful of shorts.",
  },
  pro: {
    id: "pro",
    label: "Pro",
    price_cents: 3900,
    pages: 150,
    blurb: "A feature plus rewrites, for working writers.",
    highlight: true,
  },
  studio: {
    id: "studio",
    label: "Studio",
    price_cents: 5900,
    pages: 300,
    blurb: "Three features a month: a writers' room's worth.",
  },
};

export const PLAN_ORDER: PlanId[] = ["growth", "pro", "studio"];

// Every paid tier includes the whole toolkit; tiers differ only by page budget.
export const PLAN_FEATURES = [
  "Full AI table reads: every line of dialogue and narration",
  "900+ voices, per-line emotion, speed and tone controls",
  "Scene background music and ambience",
  "MP4 and MP3 downloads of any unlocked read",
  "Private, invite-only sharing (plans only)",
  "Real actors can record your roles; host live table reads",
];

export const isPlanId = (v: unknown): v is PlanId =>
  v === "growth" || v === "pro" || v === "studio";

export const planPages = (plan: string | null | undefined): number =>
  isPlanId(plan) ? PLANS[plan].pages : 0;

export const planLabel = (plan: string | null | undefined): string =>
  isPlanId(plan) ? PLANS[plan].label : "Free";

export const isActiveStatus = (status: string | null | undefined): boolean =>
  status === "active" || status === "trialing";

export const dollars = (cents: number) => `$${Math.round(cents / 100)}`;
