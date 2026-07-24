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

    // Base list = public.users profiles (always available). We key off this so
    // names + scripts show even if the auth admin API is misbehaving.
    const { data: profiles } = await admin
      .from("users")
      .select("id, display_name, role, roles, is_admin, created_at");

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

    // Emails + auth timestamps. Prefer a SECURITY DEFINER RPC that reads
    // auth.users directly (GoTrue's admin listUsers 500s on this project);
    // fall back to listUsers, then to no email — the page stays useful either way.
    const emailById = new Map<string, { email: string | null; created_at: string | null; last: string | null }>();
    let emailSource = "none";
    const { data: rpcRows, error: rpcErr } = await admin.rpc("admin_list_user_emails");
    if (!rpcErr && Array.isArray(rpcRows)) {
      emailSource = "rpc";
      for (const r of rpcRows as any[]) {
        emailById.set(r.id, { email: r.email ?? null, created_at: r.created_at ?? null, last: r.last_sign_in_at ?? null });
      }
    } else {
      try {
        for (let page = 1; page <= 20; page++) {
          const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
          if (error) break;
          emailSource = "listUsers";
          const batch = data?.users ?? [];
          for (const u of batch) emailById.set(u.id, { email: u.email ?? null, created_at: u.created_at ?? null, last: u.last_sign_in_at ?? null });
          if (batch.length < 200) break;
        }
      } catch (_) {
        /* both paths failed — emails stay null */
      }
    }

    const users = (profiles ?? []).map((p) => {
      const theirs = byWriter.get(p.id) ?? [];
      const e = emailById.get(p.id);
      return {
        id: p.id,
        email: e?.email ?? null,
        display_name: p.display_name ?? "",
        roles: (p.roles as string[] | null) ?? (p.role ? [p.role] : []),
        is_admin: !!p.is_admin,
        scripts: theirs.length,
        unlocked_scripts: theirs.filter((s) => s.full_read_unlocked).length,
        scripts_list: theirs,
        created_at: e?.created_at ?? p.created_at ?? null,
        last_sign_in_at: e?.last ?? null,
      };
    });
    users.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));

    return json({ users, count: users.length, email_source: emailSource });
  } catch (err) {
    console.error("admin-users error:", err);
    return json({ error: "Internal error", details: String(err) }, 500);
  }
});
