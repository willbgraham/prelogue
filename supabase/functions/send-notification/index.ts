import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

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
    const { user_id, title, body, data, type } = await req.json();

    if (!user_id || !type) {
      return json({ error: "user_id and type required" }, 400);
    }

    // Previously unauthenticated — an open relay that let anyone push
    // arbitrary "first-party" notifications (phishing) to any user's devices.
    // Require a signed-in caller (or the service role, for internal fns); cap
    // payload sizes so it can't carry walls of spam.
    const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const isService = bearer === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!isService) {
      const {
        data: { user: caller },
      } = await createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } }
      ).auth.getUser();
      if (!caller) return json({ error: "unauthorized" }, 401);
    }
    const safeTitle = String(title ?? "").slice(0, 140);
    const safeBody = String(body ?? "").slice(0, 500);
    const safeType = String(type).slice(0, 40);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Insert in-app notification
    const { error: notifError } = await supabase.from("notifications").insert({
      user_id,
      type: safeType,
      payload: { title: safeTitle, body: safeBody, ...(data || {}) },
    });

    if (notifError) {
      console.error("Failed to insert notification:", notifError);
    }

    // 2. Get push tokens for the user
    const { data: tokens } = await supabase
      .from("push_tokens")
      .select("token")
      .eq("user_id", user_id);

    // 3. Send push notifications via Expo Push API
    if (tokens && tokens.length > 0) {
      const messages = tokens.map((t: { token: string }) => ({
        to: t.token,
        sound: "default",
        title: safeTitle || "Prelogue",
        body: safeBody,
        data: data || {},
      }));

      try {
        const pushRes = await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(messages),
        });
        const pushResult = await pushRes.json();
        console.log("Push result:", JSON.stringify(pushResult));
      } catch (pushErr) {
        console.error("Push send failed:", pushErr);
      }
    }

    return json({ success: true, push_tokens_notified: tokens?.length || 0 });
  } catch (err) {
    console.error("Notification error:", err);
    return json({ error: "Internal error", details: String(err) }, 500);
  }
});
