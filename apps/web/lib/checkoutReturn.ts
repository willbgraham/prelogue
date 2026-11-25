// Where a buyer lands after paying for a plan, and what their script's page
// does when they land.
//
// A writer who subscribed used to be returned to the billing page. Their script
// stayed locked (a plan unlocks a script only from that script's own page, a
// long way down it), and in Nov 2026 a new subscriber uploaded his script a
// second time four minutes after paying rather than find his way back: the
// voices he had chosen stayed behind on the first copy. Now a plan checkout
// returns to the script, and the script is unlocked with the plan on arrival.
import type { SupabaseClient } from "@supabase/supabase-js";
import { isActiveStatus, isPlanId, planCredits } from "./shared/plans";
import { refusalBody } from "./shared/voiceCues";

/** A script id as it travels in a link. Nothing else is ever put into a return address. */
const SCRIPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The script a visitor came to the plans from (`?script=<id>`), if the link names one. */
export function scriptFromSearch(search: string | null | undefined): string | null {
  const id = new URLSearchParams(search ?? "").get("script");
  return id && SCRIPT_ID.test(id) ? id.toLowerCase() : null;
}

/** The plans page, remembering the script the visitor was on. */
export function pricingHref(scriptId?: string | null): string {
  return scriptId && SCRIPT_ID.test(scriptId) ? `/pricing?script=${scriptId.toLowerCase()}` : "/pricing";
}

/**
 * The script a new subscriber should come back to: the one they came from if it
 * is theirs, else the script they uploaded last that is still locked (a writer
 * who reached the plans from the menu). None if they have no script to open.
 * A lookup that fails is the same as none: it must never stop a checkout.
 */
async function scriptToReturnTo(
  client: SupabaseClient,
  userId: string,
  carried: string | null
): Promise<string | null> {
  try {
    if (carried) {
      const { data } = await client
        .from("scripts")
        .select("id")
        .eq("id", carried)
        .eq("writer_id", userId)
        .maybeSingle();
      if (data?.id) return data.id as string;
    }
    const { data } = await client
      .from("scripts")
      .select("id")
      .eq("writer_id", userId)
      .eq("full_read_unlocked", false)
      .order("created_at", { ascending: false })
      .limit(1);
    return ((data as { id: string }[] | null)?.[0]?.id as string | undefined) ?? null;
  } catch {
    return null;
  }
}

export type PlanCheckoutStart =
  | { kind: "sign-in"; href: string }
  | { kind: "checkout"; href: string; scriptId: string | null }
  | { kind: "error"; message: string };

/**
 * Start a plan's checkout. The payment page returns to the writer's script
 * (`/script/<id>?subscribed=1`) when there is one, to billing when there isn't.
 */
export async function startPlanCheckout(
  client: SupabaseClient,
  { plan, origin, search }: { plan: string; origin: string; search: string | null | undefined }
): Promise<PlanCheckoutStart> {
  const carried = scriptFromSearch(search);
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) {
    return { kind: "sign-in", href: `/sign-in?next=${encodeURIComponent(pricingHref(carried))}` };
  }
  const scriptId = await scriptToReturnTo(client, user.id, carried);
  const { data, error } = await client.functions.invoke("create-checkout-session", {
    body: {
      plan,
      success_url: scriptId
        ? `${origin}/script/${scriptId}?subscribed=1`
        : `${origin}/settings/billing?subscribed=1`,
      cancel_url: `${origin}${pricingHref(carried)}`,
    },
  });
  if (error || data?.error || !data?.url) {
    return { kind: "error", message: data?.error ?? error?.message ?? "Couldn't start checkout." };
  }
  return { kind: "checkout", href: data.url as string, scriptId };
}

/** What kind of payment the visitor has just come back from, by the page's address. */
export type CheckoutReturnKind = "subscribed" | "unlocked";
export function returnFromSearch(search: string | null | undefined): CheckoutReturnKind | null {
  const p = new URLSearchParams(search ?? "");
  if (p.get("subscribed") === "1") return "subscribed";
  if (p.get("unlocked") === "1") return "unlocked";
  return null;
}

/** The page's address with the just-paid marks taken off, so a reload doesn't repeat the welcome. */
export function withoutReturnMarks(pathname: string, search: string | null | undefined): string {
  const p = new URLSearchParams(search ?? "");
  p.delete("subscribed");
  p.delete("unlocked");
  const rest = p.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}

export type FinishOutcome =
  /** The script is unlocked. `plan`/`credits` when a plan did it and they are known. */
  | { state: "unlocked"; plan?: string | null; credits?: number | null }
  /** The payment has not reached us in the time allowed. Nothing is wrong yet. */
  | { state: "waiting" }
  /** It can't be unlocked, and waiting won't change that (a script with no readable lines). */
  | { state: "refused"; message: string };

export interface FinishOptions {
  /** How many times to look before giving up for now. */
  tries?: number;
  /** Pause between looks, ms. */
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** The page went away: stop. */
  cancelled?: () => boolean;
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A writer has just come back from subscribing: unlock this script with their
 * plan. The payment page returns the buyer a moment before, or a moment after,
 * Stripe tells us about the payment, so "no active plan" at first means "not
 * yet": look again for about half a minute before saying so.
 */
export async function finishSubscribed(
  client: SupabaseClient,
  scriptId: string,
  { tries = 16, waitMs = 2000, sleep = pause, cancelled }: FinishOptions = {}
): Promise<FinishOutcome> {
  let userId: string | null = null;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(waitMs);
    if (cancelled?.()) return { state: "waiting" };
    try {
      // Has the payment reached us? The writer's own row says which plan they are on.
      if (!userId) userId = (await client.auth.getUser()).data.user?.id ?? null;
      if (!userId) continue;
      const { data: me } = await client
        .from("users")
        .select("plan, plan_status, credits_balance")
        .eq("id", userId)
        .maybeSingle();
      if (!me || !isPlanId(me.plan) || !isActiveStatus(me.plan_status)) continue; // not yet

      const res = await client.functions.invoke("subscription-unlock", { body: { script_id: scriptId } });
      // A refusal comes back as a bare "non-2xx" error with the answer inside it.
      const said =
        (res.data as Record<string, unknown> | null) ?? (res.error ? await refusalBody(res.error) : null);
      if (said?.ok === true) {
        // The balance is told only once the plan's credits are in it: the plan is
        // marked active a moment before they are granted.
        const balance =
          typeof said.credits_balance === "number" ? said.credits_balance : (me.credits_balance as number | null);
        return {
          state: "unlocked",
          plan: me.plan as string,
          credits: typeof balance === "number" && balance >= planCredits(me.plan) ? balance : null,
        };
      }
      if (said?.error === "unreadable_script") {
        return {
          state: "refused",
          message:
            typeof said.message === "string"
              ? said.message
              : "We couldn't read any lines from this PDF yet, so there is nothing to unlock.",
        };
      }
      // "no_active_plan" after all, or no answer: look again.
    } catch {
      /* the network, or the function, for a moment: look again */
    }
  }
  return { state: "waiting" };
}

/**
 * A writer has just come back from paying for this one script: wait for the
 * payment to reach us and unlock it (Stripe tells us; the page does nothing but
 * look).
 */
export async function finishUnlocked(
  client: SupabaseClient,
  scriptId: string,
  { tries = 16, waitMs = 2000, sleep = pause, cancelled }: FinishOptions = {}
): Promise<FinishOutcome> {
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(waitMs);
    if (cancelled?.()) return { state: "waiting" };
    try {
      const { data } = await client
        .from("scripts")
        .select("full_read_unlocked")
        .eq("id", scriptId)
        .maybeSingle();
      if (data?.full_read_unlocked === true) return { state: "unlocked" };
    } catch {
      /* look again */
    }
  }
  return { state: "waiting" };
}
