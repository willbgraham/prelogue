-- Private invite sharing becomes a SUBSCRIPTION feature (2026-08-04 decision).
-- The $19 one-time unlock buys the full read of that script only; creating new
-- script invites now requires an active plan. Existing invites are grandfathered
-- (they keep granting access and the owner can still see/remove them) — we only
-- gate the creation of NEW invites.
--
-- Replaces the single "owner manages invites" FOR ALL policy from
-- 20260618100000_per_script_unlock.sql with per-command policies.

drop policy if exists "owner manages invites" on public.script_invites;

-- Owners can always see and revoke their invites.
create policy "owner views invites" on public.script_invites
  for select to authenticated
  using (exists (select 1 from public.scripts s
                 where s.id = script_invites.script_id and s.writer_id = auth.uid()));

create policy "owner removes invites" on public.script_invites
  for delete to authenticated
  using (exists (select 1 from public.scripts s
                 where s.id = script_invites.script_id and s.writer_id = auth.uid()));

-- Creating a NEW invite requires owning the script AND an active subscription
-- (plan_status matches the app's isActiveStatus: active or trialing).
create policy "subscribers create invites" on public.script_invites
  for insert to authenticated
  with check (
    exists (select 1 from public.scripts s
            where s.id = script_invites.script_id and s.writer_id = auth.uid())
    and exists (select 1 from public.users u
                where u.id = auth.uid() and u.plan_status in ('active', 'trialing'))
  );
