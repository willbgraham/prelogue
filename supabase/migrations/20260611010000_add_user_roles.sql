-- Multi-role support: a user can be a writer AND an actor (and/or audience).
-- `roles` is the set the user has; the existing `role` column stays as the
-- user's *active* role (what they're currently acting as), so all existing
-- `profile.role === '...'` checks keep working unchanged.
alter table public.users
  add column if not exists roles text[];

-- Backfill existing users so their current role is in the set.
update public.users
  set roles = array[role]
  where role is not null and roles is null;
