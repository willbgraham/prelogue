-- Admin People panel needs each user's email, which lives in auth.users.
-- PostgREST only exposes the public schema, and GoTrue's admin listUsers API
-- 500s on this project ("Database error finding users"), so the admin-users
-- edge function reads emails through this SECURITY DEFINER function instead.
--
-- Locked down: executable only by service_role (the edge function's key).

create or replace function public.admin_list_user_emails()
returns table (id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz)
language sql
security definer
set search_path = auth, public
as $$
  select u.id, u.email::text, u.created_at, u.last_sign_in_at
  from auth.users u
$$;

revoke all on function public.admin_list_user_emails() from public, anon, authenticated;
grant execute on function public.admin_list_user_emails() to service_role;
