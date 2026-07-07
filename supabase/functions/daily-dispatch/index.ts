import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Admin-only bridge from the web app to the video worker: "generate now" or
// "re-render". Verifies the caller is an admin, then POSTs the worker.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const {
      data: { user },
    } = await createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    }).auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: u } = await admin.from("users").select("is_admin").eq("id", user.id).single();
    if (!u?.is_admin) return json({ error: "forbidden" }, 403);

    const worker = Deno.env.get("VIDEO_WORKER_URL");
    if (!worker) return json({ error: "VIDEO_WORKER_URL not configured" }, 500);

    const { action, script_id, variant, submission_ids } = await req.json();
    const path = action === "generate" ? "/daily" : "/render-scene";
    const body = action === "generate" ? {} : { script_id, variant: variant || "ai", submission_ids };

    const res = await fetch(worker + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cron-secret": Deno.env.get("CRON_SECRET") || "" },
      body: JSON.stringify(body),
    });
    return json({ dispatched: true, worker_status: res.status });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
