import Stripe from "https://esm.sh/stripe@16.12.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

/** Map a Stripe subscription onto the user's plan columns. */
async function applySubscription(
  sub: Stripe.Subscription,
  userId?: string,
  customerId?: string
) {
  const status = sub.status; // active | trialing | past_due | canceled | unpaid | incomplete...
  const paid = status === "active" || status === "trialing";
  const update = {
    plan: paid ? "pro" : "free",
    plan_status: status,
    stripe_subscription_id: sub.id,
    plan_renews_at: sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null,
  };

  if (userId) {
    await admin.from("users").update(update).eq("id", userId);
  } else if (customerId) {
    await admin.from("users").update(update).eq("stripe_customer_id", customerId);
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
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const userId = s.client_reference_id || (s.metadata?.user_id as string | undefined);
        const customerId = typeof s.customer === "string" ? s.customer : s.customer?.id;
        const subId = typeof s.subscription === "string" ? s.subscription : s.subscription?.id;
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          await applySubscription(sub, userId, customerId);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
        await applySubscription(sub, sub.metadata?.user_id as string | undefined, customerId);
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
