-- Let admins edit any script's content, so /admin/renders → "Edit scene" can fix
-- line-parse issues on generated scenes (owned by the house account, not the admin).
-- PostgreSQL permissive policies are OR'd, so writers keep their existing
-- "Writers can update own scripts" access unchanged.
create policy "Admins can update any script" on public.scripts for update
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin))
  with check (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin));
