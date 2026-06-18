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

/** Mark a script's full read as unlocked (idempotent). */
async function unlockScript(scriptId: string) {
  if (!scriptId) return;
  await admin
    .from("scripts")
    .update({ full_read_unlocked: true, unlocked_at: new Date().toISOString() })
    .eq("id", scriptId);
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
      // One-time per-script unlock. Honor only fully-paid sessions.
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const scriptId = s.metadata?.script_id as string | undefined;
        if (scriptId && (s.payment_status === "paid" || s.payment_status === "no_payment_required")) {
          await unlockScript(scriptId);
        }
        break;
      }
      // Belt-and-suspenders: also unlock when the payment intent succeeds
      // (covers async payment methods that settle after checkout).
      case "payment_intent.succeeded": {
        const pi = event.data.object as Stripe.PaymentIntent;
        const scriptId = pi.metadata?.script_id as string | undefined;
        if (scriptId) await unlockScript(scriptId);
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
