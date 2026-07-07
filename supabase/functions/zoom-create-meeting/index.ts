import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Provisions a Prelogue-hosted Zoom meeting for a live reading (Layer 2). Uses a
// Server-to-Server OAuth app on the Prelogue Zoom account, so every meeting — and
// every cloud recording — is owned by Prelogue. Called by the writer (or an admin)
// when a reading is scheduled. Secrets: ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID,
// ZOOM_CLIENT_SECRET.
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

// Server-to-Server OAuth: exchange the account credentials for a short-lived token.
async function zoomToken(): Promise<string> {
  const accountId = Deno.env.get("ZOOM_ACCOUNT_ID");
  const clientId = Deno.env.get("ZOOM_CLIENT_ID");
  const clientSecret = Deno.env.get("ZOOM_CLIENT_SECRET");
  if (!accountId || !clientId || !clientSecret) throw new Error("Zoom not configured");
  const basic = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`,
    { method: "POST", headers: { Authorization: `Basic ${basic}` } }
  );
  const j = await res.json();
  if (!j.access_token) throw new Error("Zoom auth failed: " + JSON.stringify(j).slice(0, 200));
  return j.access_token as string;
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

    const { live_reading_id } = await req.json();
    if (!live_reading_id) return json({ error: "live_reading_id required" }, 400);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: reading } = await admin
      .from("live_readings")
      .select("id, writer_id, title, scheduled_at, duration_min")
      .eq("id", live_reading_id)
      .single();
    if (!reading) return json({ error: "reading not found" }, 404);

    // Only the reading's writer or an admin may provision the meeting.
    const { data: me } = await admin.from("users").select("is_admin").eq("id", user.id).single();
    if (reading.writer_id !== user.id && !me?.is_admin) return json({ error: "forbidden" }, 403);

    const token = await zoomToken();
    const res = await fetch("https://api.zoom.us/v2/users/me/meetings", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        topic: (reading.title || "Prelogue Live Reading").slice(0, 200),
        type: 2, // scheduled meeting
        start_time: reading.scheduled_at,
        duration: reading.duration_min || 60,
        settings: {
          auto_recording: "cloud", // Prelogue owns the recording
          join_before_host: true, // the reading can start without a Prelogue host present
          waiting_room: false,
          approval_type: 2, // no registration
          mute_upon_entry: false,
        },
      }),
    });
    const m = await res.json();
    if (!m.id) return json({ error: "zoom create failed", detail: JSON.stringify(m).slice(0, 300) }, 502);

    await admin
      .from("live_readings")
      .update({
        zoom_meeting_id: String(m.id),
        zoom_join_url: m.join_url,
        zoom_start_url: m.start_url, // host link — only ever shown to the writer/admin
        zoom_passcode: m.password ?? null,
      })
      .eq("id", live_reading_id);

    return json({ ok: true, join_url: m.join_url });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
