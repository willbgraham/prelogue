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

// Per-script unlock price, in cents. Override with STRIPE_UNLOCK_PRICE_CENTS.
const UNLOCK_PRICE_CENTS = Number(Deno.env.get("STRIPE_UNLOCK_PRICE_CENTS") ?? "1900");

/**
 * Creates a Stripe Checkout session to UNLOCK ONE SCRIPT (one-time payment).
 * Unlocking grants that script its full AI table read + invite-only sharing.
 * The client opens the returned URL in an external browser; on payment the
 * stripe-webhook function flips scripts.full_read_unlocked via the script_id we
 * stash in the session metadata. Body: { script_id }.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!Deno.env.get("STRIPE_SECRET_KEY")) {
      return json({ error: "Stripe not configured (STRIPE_SECRET_KEY)" }, 500);
    }

    const { script_id, success_url, cancel_url } = await req.json().catch(() => ({}));
    if (!script_id) return json({ error: "Missing script_id" }, 400);

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

    // The buyer must own the script, and it can't already be unlocked.
    const { data: script } = await admin
      .from("scripts")
      .select("id, title, writer_id, full_read_unlocked")
      .eq("id", script_id)
      .single();
    if (!script) return json({ error: "Script not found" }, 404);
    if (script.writer_id !== user.id) return json({ error: "Not your script" }, 403);
    if (script.full_read_unlocked) return json({ error: "Script is already unlocked" }, 409);

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

    // Caller-supplied URLs (the web app passes its own) win over env defaults,
    // so web checkout returns to prelogue.studio without affecting mobile.
    const successUrl =
      success_url ?? Deno.env.get("STRIPE_SUCCESS_URL") ?? `${Deno.env.get("SUPABASE_URL")}`;
    const cancelUrl =
      cancel_url ?? Deno.env.get("STRIPE_CANCEL_URL") ?? `${Deno.env.get("SUPABASE_URL")}`;

    // One-time payment. Price is set inline so there's no Stripe dashboard
    // product to maintain. Promo codes stay on for launch discounts.
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: UNLOCK_PRICE_CENTS,
            product_data: {
              name: "Full script unlock — Prelogue",
              description: `Full AI table read + invite-only sharing for "${script.title}"`,
            },
          },
        },
      ],
      payment_intent_data: { metadata: { user_id: user.id, script_id } },
      metadata: { user_id: user.id, script_id },
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
