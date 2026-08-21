import Stripe from "https://esm.sh/stripe@16.12.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendCapiEvent } from "../_shared/metaCapi.ts";

// NOTE: deploy this function with JWT verification DISABLED — Stripe calls it
// directly (no Supabase auth). e.g. `supabase functions deploy stripe-webhook
// --no-verify-jwt`, or set verify_jwt = false for it in config.toml.

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  httpClient: Stripe.createFetchHttpClient(),
  apiVersion: "2024-06-20",
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Subscription tiers. KEEP IN SYNC with apps/web/lib/shared/plans.ts.
const PLANS: Record<string, { price_cents: number; credits: number }> = {
  growth: { price_cents: 1900, credits: 100 },
  pro: { price_cents: 3900, credits: 225 },
  studio: { price_cents: 5900, credits: 375 },
};
const TOPUPS: Record<string, number> = { small: 100, medium: 250, large: 600 };
const ONE_TIME_UNLOCK_CREDITS = 150;

/** Grant credits (service role → the SECURITY DEFINER helper). */
async function grantCredits(
  userId: string,
  credits: number,
  reason: string,
  ref: string | null,
  topUpTo = false
) {
  if (!userId || credits <= 0) return;
  await admin.rpc("grant_credits", {
    p_user: userId,
    p_credits: credits,
    p_reason: reason,
    p_ref: ref,
    p_set_to_at_least: topUpTo,
  });
}

/** Mark a script's full read as unlocked (idempotent). */
async function unlockScript(scriptId: string) {
  if (!scriptId) return;
  await admin
    .from("scripts")
    .update({ full_read_unlocked: true, unlocked_at: new Date().toISOString() })
    .eq("id", scriptId);
}

/** Resolve our user id from a subscription/invoice: prefer stashed metadata,
 *  fall back to the Stripe customer id we saved on the user row. */
async function findUserId(
  metaUserId: string | undefined | null,
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null
): Promise<string | null> {
  if (metaUserId) return metaUserId;
  const custId = typeof customer === "string" ? customer : customer?.id;
  if (!custId) return null;
  const { data } = await admin
    .from("users")
    .select("id")
    .eq("stripe_customer_id", custId)
    .single();
  return data?.id ?? null;
}

/** Which tier is this subscription — from metadata, else matched by price. */
function planFromSub(sub: Stripe.Subscription): string | null {
  const m = sub.metadata?.plan;
  if (m && PLANS[m]) return m;
  const amt = sub.items?.data?.[0]?.price?.unit_amount ?? null;
  const hit = Object.entries(PLANS).find(([, p]) => p.price_cents === amt);
  return hit ? hit[0] : null;
}

/** Sync a subscription onto the user row. resetUsage=true on a fresh period
 *  (creation / renewal) so the monthly page budget starts clean. */
async function applySubscription(sub: Stripe.Subscription, resetUsage: boolean) {
  const userId = await findUserId(sub.metadata?.user_id, sub.customer);
  if (!userId) return;
  const planId = planFromSub(sub);
  const patch: Record<string, unknown> = {
    plan: planId ?? "free",
    plan_status: sub.status,
    stripe_subscription_id: sub.id,
    plan_renews_at: sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null,
  };
  if (resetUsage) patch.plan_pages_used = 0;
  await admin.from("users").update(patch).eq("id", userId);

  // Fresh period → top the balance up TO the plan allowance (not stacking, so
  // idle months don't accumulate an unbounded liability).
  if (resetUsage && planId && PLANS[planId]) {
    await grantCredits(userId, PLANS[planId].credits, "plan_grant", sub.id, true);
  }
}

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!sig || !secret) return new Response("Missing signature/secret", { status: 400 });

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, secret, undefined, cryptoProvider);
  } catch (err: any) {
    return new Response(`Webhook signature error: ${String(err?.message ?? err)}`, { status: 400 });
  }

  try {
    switch (event.type) {
      // One-time per-script unlock. Subscription checkouts also fire this event
      // but carry no script_id, so they're ignored here (handled below).
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.mode === "subscription") break;
        const paid = s.payment_status === "paid" || s.payment_status === "no_payment_required";
        if (!paid) break;

        // Paid amount in whole currency units. 100%-off coupons complete with
        // amount 0 — those must NOT reach Meta as Purchases, or delivery would
        // optimize toward people who convert on freebies.
        const paidValue = (s.amount_total ?? 0) / 100;
        const buyerEmail = s.customer_details?.email ?? null;

        // Credit top-up pack.
        const topup = s.metadata?.topup as string | undefined;
        if (topup && TOPUPS[topup]) {
          const uid = await findUserId(s.metadata?.user_id, s.customer);
          if (uid) await grantCredits(uid, TOPUPS[topup], "topup", s.id);
          if (paidValue > 0) {
            await sendCapiEvent({
              eventName: "Purchase",
              eventId: s.id, // stable across Stripe retries → Meta dedups
              email: buyerEmail,
              userId: uid,
              value: paidValue,
              currency: s.currency ?? "USD",
              contentName: "credit_topup",
            });
          }
          break;
        }

        // One-time per-script unlock: unlocks the script AND grants the credits
        // needed to actually voice it (otherwise they'd have paid for access
        // with no way to generate).
        const scriptId = s.metadata?.script_id as string | undefined;
        if (scriptId) {
          await unlockScript(scriptId);
          const uid = await findUserId(s.metadata?.user_id, s.customer);
          if (uid) await grantCredits(uid, ONE_TIME_UNLOCK_CREDITS, "unlock_grant", scriptId);
          if (paidValue > 0) {
            await sendCapiEvent({
              eventName: "Purchase",
              eventId: s.id,
              email: buyerEmail,
              userId: uid,
              value: paidValue,
              currency: s.currency ?? "USD",
              contentName: "script_unlock",
            });
          }
        }
        break;
      }
      // Belt-and-suspenders for async one-time payment methods.
      case "payment_intent.succeeded": {
        const pi = event.data.object as Stripe.PaymentIntent;
        const scriptId = pi.metadata?.script_id as string | undefined;
        if (scriptId) await unlockScript(scriptId);
        break;
      }

      // Subscription lifecycle → users.plan / plan_status / budget.
      case "customer.subscription.created": {
        const sub = event.data.object as Stripe.Subscription;
        await applySubscription(sub, true);
        // Once per subscription (sub.id dedups retries). Value = tier price.
        const planId = planFromSub(sub);
        if (planId && PLANS[planId]) {
          const uid = await findUserId(sub.metadata?.user_id, sub.customer);
          let email: string | null = null;
          if (uid) {
            const { data: au } = await admin.auth.admin.getUserById(uid);
            email = au?.user?.email ?? null;
          }
          await sendCapiEvent({
            eventName: "Subscribe",
            eventId: sub.id,
            email,
            userId: uid,
            value: PLANS[planId].price_cents / 100,
            currency: "USD",
            contentName: planId,
          });
        }
        break;
      }
      case "customer.subscription.updated":
        // Status / tier / renewal-date change; don't wipe mid-cycle usage.
        await applySubscription(event.data.object as Stripe.Subscription, false);
        break;
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const userId = await findUserId(sub.metadata?.user_id, sub.customer);
        if (userId) {
          await admin
            .from("users")
            .update({ plan: "free", plan_status: "canceled", stripe_subscription_id: null })
            .eq("id", userId);
        }
        break;
      }
      // Renewal (and first) payment → reset the monthly page budget.
      case "invoice.paid": {
        const inv = event.data.object as Stripe.Invoice;
        // `invoice.subscription` on API 2024-06-20; newer versions nest it under
        // `parent.subscription_details.subscription`. Handle both.
        const rawSub =
          (inv as any).subscription ??
          (inv as any).parent?.subscription_details?.subscription ??
          null;
        const subId = typeof rawSub === "string" ? rawSub : rawSub?.id;
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          await applySubscription(sub, true);
        }
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object as Stripe.Invoice;
        const userId = await findUserId(undefined, inv.customer);
        if (userId) await admin.from("users").update({ plan_status: "past_due" }).eq("id", userId);
        break;
      }
      default:
        break;
    }
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("stripe-webhook handler error:", err);
    return new Response("handler error", { status: 500 });
  }
});
