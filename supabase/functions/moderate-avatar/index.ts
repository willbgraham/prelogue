import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// SightEngine credentials (shared with moderate-submission).
const SE_USER = Deno.env.get("SIGHTENGINE_API_USER");
const SE_SECRET = Deno.env.get("SIGHTENGINE_API_SECRET");

const MODELS = "nudity-2.1,gore-2.0,offensive-2.0,self-harm";
const THRESHOLDS = { nudity: 0.5, gore: 0.6, offensive: 0.5, selfharm: 0.5 };

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function maxNum(obj: unknown): number {
  if (!obj || typeof obj !== "object") return 0;
  let m = 0;
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (typeof v === "number" && v > m) m = v;
  }
  return m;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!SE_USER || !SE_SECRET) return json({ error: "Moderation not configured" }, 500);
    const { path } = await req.json();
    if (!path || typeof path !== "string") return json({ error: "path required" }, 400);

    // The caller must own the uploaded file (avatars/<uid>/...).
    const authHeader = req.headers.get("Authorization") ?? "";
    const {
      data: { user },
    } = await createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    ).auth.getUser();
    if (!user) return json({ error: "Not authorized" }, 401);
    if (!path.startsWith(`${user.id}/`)) return json({ error: "Not authorized" }, 403);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: pub } = admin.storage.from("avatars").getPublicUrl(path);

    const params = new URLSearchParams({
      url: pub.publicUrl,
      models: MODELS,
      api_user: SE_USER,
      api_secret: SE_SECRET,
    });
    const r = await fetch(`https://api.sightengine.com/1.0/check.json?${params}`);
    const j = await r.json();
    // Fail closed: if we couldn't screen it, don't accept the image.
    if (j.status !== "success") {
      await admin.storage.from("avatars").remove([path]).catch(() => {});
      return json({ status: "error" });
    }

    const n = j.nudity || {};
    const scores = {
      nudity: Math.max(n.sexual_activity || 0, n.sexual_display || 0, n.erotica || 0),
      gore: j.gore?.prob ?? maxNum(j.gore),
      offensive: j.offensive?.prob ?? maxNum(j.offensive),
      selfharm: (j["self-harm"] ?? j.self_harm)?.prob ?? maxNum(j["self-harm"] ?? j.self_harm),
    };
    const reasons: string[] = [];
    if (scores.nudity >= THRESHOLDS.nudity) reasons.push("nudity");
    if (scores.gore >= THRESHOLDS.gore) reasons.push("gore");
    if (scores.offensive >= THRESHOLDS.offensive) reasons.push("offensive");
    if (scores.selfharm >= THRESHOLDS.selfharm) reasons.push("self-harm");

    if (reasons.length) {
      // Reject → delete the file so it never resolves anywhere.
      await admin.storage.from("avatars").remove([path]).catch(() => {});
      return json({ status: "rejected", reasons });
    }
    return json({ status: "approved" });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "error" }, 500);
  }
});
