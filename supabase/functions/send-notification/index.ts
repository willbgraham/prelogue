import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user_id, title, body, data, type } = await req.json();

    if (!user_id || !type) {
      return new Response(
        JSON.stringify({ error: "user_id and type required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Insert in-app notification
    const { error: notifError } = await supabase.from("notifications").insert({
      user_id,
      type,
      payload: { title, body, ...(data || {}) },
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
        title: title || "Cast",
        body: body || "",
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

    return new Response(
      JSON.stringify({
        success: true,
        push_tokens_notified: tokens?.length || 0,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Notification error:", err);
    return new Response(
      JSON.stringify({ error: "Internal error", details: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
