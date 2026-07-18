// Writer MP4 export: render the script's table read as a downloadable video,
// reusing the daily-render pipeline (render-one.yml → video-worker → the
// daily-renders bucket + daily_renders table).
//
//   action "dispatch" → trigger a GitHub Actions render for the script
//   action "status"   → latest render row + a signed download URL when ready
//
// Gates: caller must be the script's writer; the script must have the full
// read unlocked (the MP4 IS the full read — same $19 gate as generation); and
// page_count is capped so renders fit the Actions job comfortably.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MAX_PAGES = 15;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { script_id, action } = await req.json();
    if (!script_id || (action !== "dispatch" && action !== "status")) {
      return json({ error: "script_id and action (dispatch|status) required" }, 400);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Writer gate.
    const authHeader = req.headers.get("Authorization");
    let callerId: string | null = null;
    if (authHeader) {
      const {
        data: { user },
      } = await createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } }
      ).auth.getUser();
      callerId = user?.id ?? null;
    }
    const { data: script, error: scriptErr } = await admin
      .from("scripts")
      .select("writer_id, full_read_unlocked, page_count, title")
      .eq("id", script_id)
      .single();
    if (scriptErr || !script) return json({ error: "Script not found" }, 404);
    if (!callerId || callerId !== script.writer_id) {
      return json({ error: "Only the writer can export this read" }, 403);
    }

    if (action === "status") {
      const { data: render } = await admin
        .from("daily_renders")
        .select("id, status, video_path, error, created_at, rendered_at")
        .eq("script_id", script_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!render) return json({ render: null });
      let url: string | null = null;
      if (render.video_path && (render.status === "ready" || render.status === "posted")) {
        const { data: signed } = await admin.storage
          .from("daily-renders")
          .createSignedUrl(render.video_path, 3600);
        url = signed?.signedUrl ?? null;
      }
      return json({
        render: {
          id: render.id,
          status: render.status,
          error: render.error,
          created_at: render.created_at,
          rendered_at: render.rendered_at,
          url,
        },
      });
    }

    // action === "dispatch"
    if (!script.full_read_unlocked) {
      return json({ error: "Unlock the full read to export it as a video" }, 402);
    }
    if ((script.page_count ?? 0) > MAX_PAGES) {
      return json(
        { error: `MP4 export currently supports scripts up to ${MAX_PAGES} pages` },
        400
      );
    }

    const ghPat = Deno.env.get("GH_PAT");
    if (!ghPat) return json({ error: "Export isn't configured (no GH_PAT)" }, 500);
    const repo = Deno.env.get("GH_REPO") || "willbgraham/prelogue";
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/render-one.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ghPat}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "prelogue-export",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: { script_id: String(script_id), variant: "ai" },
        }),
      }
    );
    if (res.status !== 204) {
      const detail = await res.text().catch(() => "");
      console.error(`export dispatch failed ${res.status}: ${detail.slice(0, 200)}`);
      return json({ error: `Couldn't start the render (${res.status})` }, 502);
    }
    return json({ dispatched: true });
  } catch (err) {
    console.error("export-read error:", err);
    return json({ error: "Internal error", details: String(err) }, 500);
  }
});
