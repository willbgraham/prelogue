// Unlock a script's full read using the writer's monthly PAGE BUDGET (their
// subscription plan) instead of the one-time $19 payment. Spending is metered by
// the script's page_count; the unlock is permanent (sets scripts.full_read_unlocked,
// which only the service role may flip — see protect_script_entitlement trigger).
//
// Body: { script_id }. Caller must own the script and have an active plan with
// enough remaining budget. Idempotent: re-unlocking an already-unlocked script
// costs nothing.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { countElements } from "../_shared/screenplay.ts";

// KEEP IN SYNC with apps/web/lib/shared/plans.ts
const PLAN_LABEL: Record<string, string> = {
  growth: "Growth",
  pro: "Pro",
  studio: "Studio",
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { script_id } = await req.json().catch(() => ({}));
    if (!script_id) return json({ error: "Missing script_id" }, 400);

    // Identify the caller.
    const authHeader = req.headers.get("Authorization") ?? "";
    const {
      data: { user },
    } = await createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    ).auth.getUser();
    if (!user) return json({ error: "Not authenticated" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: script } = await admin
      .from("scripts")
      .select("id, title, writer_id, page_count, full_read_unlocked, scenes:parsed_json->scenes")
      .eq("id", script_id)
      .single();
    if (!script) return json({ error: "Script not found" }, 404);
    if (script.writer_id !== user.id) return json({ error: "Not your script" }, 403);
    if (script.full_read_unlocked) {
      return json({ ok: true, already_unlocked: true });
    }
    // Nothing to unlock on a script we couldn't read. A subscriber once
    // unlocked a scanned PDF this way and then spent a quarter of an hour
    // trying to play and export a read that could never exist. (HTTP 200 so
    // the page can show the reason; supabase-js hides the body of a non-2xx.)
    if (countElements(script.scenes) === 0) {
      return json({
        error: "unreadable_script",
        message:
          "We couldn't read any lines from this PDF yet, so there is nothing to unlock. Upload a PDF exported from your writing app first.",
      });
    }

    const { data: profile } = await admin
      .from("users")
      .select("plan, plan_status, credits_balance")
      .eq("id", user.id)
      .single();

    const planId = (profile?.plan ?? "free") as string;
    const status = profile?.plan_status ?? null;
    const active = status === "active" || status === "trialing";
    if (!PLAN_LABEL[planId] || !active) {
      return json({ error: "no_active_plan" }, 402);
    }

    // Unlocking is just access — the real metering happens per generation, in
    // credits (see generate-voice-cues). Nothing is charged here, so a
    // subscriber can open any of their scripts and only pays for what they
    // actually voice.
    const { error: unlockErr } = await admin
      .from("scripts")
      .update({ full_read_unlocked: true, unlocked_at: new Date().toISOString() })
      .eq("id", script_id);
    if (unlockErr) return json({ error: unlockErr.message }, 500);

    return json({
      ok: true,
      plan: planId,
      plan_label: PLAN_LABEL[planId],
      credits_balance: profile?.credits_balance ?? 0,
    });
  } catch (err) {
    console.error("subscription-unlock error:", err);
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
