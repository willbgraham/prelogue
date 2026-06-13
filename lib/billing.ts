import * as WebBrowser from "expo-web-browser";
import { supabase } from "./supabase";

/**
 * Starts the writer "Pro" subscription checkout. Invokes the
 * create-checkout-session edge function and opens Stripe Checkout in an
 * external browser (App Store-compliant link-out in the US as of 2026).
 *
 * The stripe-webhook function is the source of truth for plan status, so after
 * the browser closes the caller should refetch the user's profile to pick up
 * the new plan.
 */
export async function startWriterCheckout(): Promise<{ ok: boolean; error?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke("create-checkout-session", {
      body: {},
    });
    if (error) return { ok: false, error: error.message ?? String(error) };
    if (data?.error) return { ok: false, error: data.error };
    if (!data?.url) return { ok: false, error: "No checkout URL returned." };

    await WebBrowser.openBrowserAsync(data.url);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
