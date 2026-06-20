import * as WebBrowser from "expo-web-browser";
import { supabase } from "./supabase";

export const UNLOCK_PRICE_LABEL = "$19";

/**
 * Starts the one-time checkout to UNLOCK ONE SCRIPT's full AI table read +
 * invite-only sharing. Invokes create-checkout-session and opens Stripe
 * Checkout in an external browser (App Store-compliant link-out in the US).
 *
 * The stripe-webhook function is the source of truth — it flips
 * scripts.full_read_unlocked on payment — so after the browser closes the
 * caller should re-fetch the script to pick up the unlocked state.
 */
export async function startScriptUnlock(
  scriptId: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke("create-checkout-session", {
      body: { script_id: scriptId },
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
