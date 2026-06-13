import Stripe from "https://esm.sh/stripe@16.12.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  httpClient: Stripe.createFetchHttpClient(),
  apiVersion: "2024-06-20",
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/**
 * Creates a Stripe Checkout session for the writer "Pro" subscription and
 * returns its URL. The client opens that URL in an external browser (App Store
 * compliant in the US as of 2026), completes payment, and the stripe-webhook
 * function flips the user's plan. Includes a 7-day trial with a card required
 * up front (so the trial can't be farmed for free generation).
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const priceId = Deno.env.get("STRIPE_PRICE_ID");
    if (!Deno.env.get("STRIPE_SECRET_KEY") || !priceId) {
      return json({ error: "Stripe not configured (STRIPE_SECRET_KEY / STRIPE_PRICE_ID)" }, 500);
    }

    // Identify the caller from their Supabase auth token.
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: profile } = await admin
      .from("users")
      .select("stripe_customer_id, display_name")
      .eq("id", user.id)
      .single();

    // Reuse the writer's Stripe customer or create one.
    let customerId = profile?.stripe_customer_id as string | null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        name: profile?.display_name ?? undefined,
        metadata: { user_id: user.id },
      });
      customerId = customer.id;
      await admin.from("users").update({ stripe_customer_id: customerId }).eq("id", user.id);
    }

    const successUrl = Deno.env.get("STRIPE_SUCCESS_URL") ?? `${Deno.env.get("SUPABASE_URL")}`;
    const cancelUrl = Deno.env.get("STRIPE_CANCEL_URL") ?? `${Deno.env.get("SUPABASE_URL")}`;

    // No free trial: "trying it" is the free first-scene preview (no card).
    // Checkout is an immediate paid subscription; card is collected only here,
    // when the writer chooses to unlock full scripts. Promo codes stay enabled
    // so you can still run a discounted first month if you want.
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { metadata: { user_id: user.id } },
      client_reference_id: user.id,
      allow_promotion_codes: true,
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return json({ url: checkoutSession.url });
  } catch (err: any) {
    console.error("create-checkout-session error:", err);
    return json({ error: String(err?.message ?? err) }, 500);
  }
});
