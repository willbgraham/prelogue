// Unlock a script's full read using the writer's monthly PAGE BUDGET (their
// subscription plan) instead of the one-time $19 payment. Spending is metered by
// the script's page_count; the unlock is permanent (sets scripts.full_read_unlocked,
// which only the service role may flip — see protect_script_entitlement trigger).
//
// Body: { script_id }. Caller must own the script and have an active plan with
// enough remaining budget. Idempotent: re-unlocking an already-unlocked script
// costs nothing.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// KEEP IN SYNC with apps/web/lib/shared/plans.ts
const PLANS: Record<string, { pages: number; label: string }> = {
  growth: { pages: 50, label: "Growth" },
  pro: { pages: 150, label: "Pro" },
  studio: { pages: 300, label: "Studio" },
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
      .select("id, title, writer_id, page_count, full_read_unlocked")
      .eq("id", script_id)
      .single();
    if (!script) return json({ error: "Script not found" }, 404);
    if (script.writer_id !== user.id) return json({ error: "Not your script" }, 403);
    if (script.full_read_unlocked) {
      return json({ ok: true, already_unlocked: true });
    }

    const { data: profile } = await admin
      .from("users")
      .select("plan, plan_status, plan_pages_used, plan_renews_at")
      .eq("id", user.id)
      .single();

    const planId = (profile?.plan ?? "free") as string;
    const plan = PLANS[planId];
    const status = profile?.plan_status ?? null;
    const active = status === "active" || status === "trialing";
    if (!plan || !active) {
      return json({ error: "no_active_plan" }, 402);
    }

    const allowance = plan.pages;
    // Belt-and-suspenders: if the period end has passed but the renewal webhook
    // hasn't reset usage yet, treat the budget as fresh.
    const renews = profile?.plan_renews_at ? new Date(profile.plan_renews_at).getTime() : 0;
    const periodOver = renews > 0 && Date.now() > renews;
    const used = periodOver ? 0 : Math.max(0, profile?.plan_pages_used ?? 0);

    // Scripts nearly always carry a page_count from the parser; floor a missing
    // one so a null can't be spent for free.
    const pages = Math.max(1, script.page_count ?? 30);

    if (used + pages > allowance) {
      return json(
        {
          error: "over_budget",
          plan: planId,
          plan_label: plan.label,
          used,
          allowance,
          remaining: Math.max(0, allowance - used),
          page_count: pages,
        },
        409
      );
    }

    // Unlock first (the thing the writer paid for), then meter. If the meter
    // write somehow fails, the writer keeps the unlock — we never charge budget
    // without granting access.
    const { error: unlockErr } = await admin
      .from("scripts")
      .update({ full_read_unlocked: true, unlocked_at: new Date().toISOString() })
      .eq("id", script_id);
    if (unlockErr) return json({ error: unlockErr.message }, 500);

    const newUsed = used + pages;
    await admin.from("users").update({ plan_pages_used: newUsed }).eq("id", user.id);

    return json({
      ok: true,
      plan: planId,
      plan_label: plan.label,
      used: newUsed,
      allowance,
      remaining: Math.max(0, allowance - newUsed),
      page_count: pages,
    });
  } catch (err) {
    console.error("subscription-unlock error:", err);
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
