import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Admin-only bridge from the web app to the render pipeline. Verifies the caller
// is an admin, optionally saves a new voice_config on the script, then triggers a
// render — via the long-running video worker if VIDEO_WORKER_URL is set, otherwise
// via a GitHub Actions workflow_dispatch (the default, free host).
//   action "generate" → a brand-new daily scene (daily-scene.yml)
//   action "render"   → re-render script_id, optionally with a new voice_config
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

    const { action, script_id, variant, submission_ids, voice_config } = await req.json();

    // Persist a voice change before re-rendering. The house-account script isn't
    // writable via the caller's RLS, so use the service-role client (admin verified).
    if (voice_config && script_id) {
      const { error: upErr } = await admin.from("scripts").update({ voice_config }).eq("id", script_id);
      if (upErr) return json({ error: "voice save failed: " + upErr.message }, 500);
    }

    // Preferred path: a long-running video worker, if one is configured.
    const worker = Deno.env.get("VIDEO_WORKER_URL");
    if (worker) {
      const path = action === "generate" ? "/daily" : "/render-scene";
      const body = action === "generate" ? {} : { script_id, variant: variant || "ai", submission_ids };
      const res = await fetch(worker + path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-cron-secret": Deno.env.get("CRON_SECRET") || "" },
        body: JSON.stringify(body),
      });
      return json({ dispatched: true, via: "worker", worker_status: res.status });
    }

    // Default path: trigger a GitHub Actions workflow_dispatch (free render host).
    const ghPat = Deno.env.get("GH_PAT");
    const repo = Deno.env.get("GH_REPO") || "willbgraham/prelogue";
    if (!ghPat) return json({ error: "no VIDEO_WORKER_URL and no GH_PAT configured" }, 500);
    const workflow = action === "generate" ? "daily-scene.yml" : "render-one.yml";
    const inputs =
      action === "generate" ? {} : { script_id: String(script_id), variant: variant || "ai" };
    const ghRes = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ghPat}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "prelogue-admin",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ref: "main", inputs }),
      },
    );
    if (ghRes.status !== 204) {
      const txt = await ghRes.text();
      return json({ error: `github dispatch failed (${ghRes.status}): ${txt}` }, 502);
    }
    return json({ dispatched: true, via: "github", workflow });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
