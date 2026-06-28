import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/**
 * Permanently delete the calling user's account + content. Required by App Store
 * Guideline 5.1.1(v). Verifies the caller from their JWT, then uses the service
 * role to remove their data and their auth account.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const uid = user.id;

    // Recycle any ElevenLabs voice slots this user's designed voices held, before
    // the rows cascade away with their scripts.
    const EL_KEY = Deno.env.get("ELEVENLABS_API_KEY");
    if (EL_KEY) {
      try {
        const { data: dv } = await admin
          .from("designed_voices")
          .select("voice_id")
          .eq("created_by", uid);
        for (const row of dv ?? []) {
          await fetch(`https://api.elevenlabs.io/v1/voices/${row.voice_id}`, {
            method: "DELETE",
            headers: { "xi-api-key": EL_KEY },
          }).catch(() => {});
        }
      } catch {
        /* ignore */
      }
    }

    // Best-effort content cleanup (FK cascades handle most children); ignore
    // per-table errors so a missing table never blocks the actual deletion.
    for (const op of [
      admin.from("scripts").delete().eq("writer_id", uid),
      admin.from("submissions").delete().eq("actor_id", uid),
      admin.from("casting_choices").delete().eq("user_id", uid),
      admin.from("push_tokens").delete().eq("user_id", uid),
      admin.from("users").delete().eq("id", uid),
    ]) {
      try {
        await op;
      } catch {
        /* ignore */
      }
    }

    // The auth account is what makes deletion "real" for Apple.
    const { error } = await admin.auth.admin.deleteUser(uid);
    if (error) return json({ error: error.message }, 500);

    return json({ success: true });
  } catch (e: any) {
    console.error("delete-account error:", e);
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
