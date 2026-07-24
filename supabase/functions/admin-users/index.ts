// Admin-only people list: every signed-up user with their email (from
// auth.users — never exposed to the browser), roles, and script count, so the
// admin can reach out for feedback. Gated on public.users.is_admin.
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
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Caller must be an admin.
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
    if (!callerId) return json({ error: "unauthorized" }, 401);
    const { data: me } = await admin.from("users").select("is_admin").eq("id", callerId).single();
    if (!me?.is_admin) return json({ error: "forbidden" }, 403);

    // Profiles (display name, roles, admin flag).
    const { data: profiles } = await admin
      .from("users")
      .select("id, display_name, role, roles, is_admin, created_at");
    const profById = new Map((profiles ?? []).map((p) => [p.id, p]));

    // Scripts per writer (service role — sees private scripts the admin's
    // browser can't). Grouped so each person carries their own list.
    const { data: scripts } = await admin
      .from("scripts")
      .select("id, slug, title, writer_id, visibility, full_read_unlocked, page_count, created_at")
      .order("created_at", { ascending: false });
    const byWriter = new Map<string, any[]>();
    for (const s of scripts ?? []) {
      (byWriter.get(s.writer_id) ?? byWriter.set(s.writer_id, []).get(s.writer_id)!).push(s);
    }

    // Emails + auth timestamps, paged through the admin API.
    const users: any[] = [];
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) break;
      const batch = data?.users ?? [];
      for (const u of batch) {
        const p = profById.get(u.id);
        const theirs = byWriter.get(u.id) ?? [];
        users.push({
          id: u.id,
          email: u.email ?? null,
          display_name: p?.display_name ?? "",
          roles: (p?.roles as string[] | null) ?? (p?.role ? [p.role] : []),
          is_admin: !!p?.is_admin,
          scripts: theirs.length,
          unlocked_scripts: theirs.filter((s) => s.full_read_unlocked).length,
          scripts_list: theirs,
          created_at: u.created_at ?? p?.created_at ?? null,
          last_sign_in_at: u.last_sign_in_at ?? null,
        });
      }
      if (batch.length < 200) break;
    }
    users.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));

    return json({ users, count: users.length });
  } catch (err) {
    console.error("admin-users error:", err);
    return json({ error: "Internal error", details: String(err) }, 500);
  }
});
