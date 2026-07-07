-- Fix: the live_readings and live_reading_signups RLS policies referenced each
-- other with direct subqueries (readings' SELECT reaches into signups so a
-- signed-up actor can see an unlisted reading; signups' writer-UPDATE reaches into
-- readings). Postgres flags the mutual reference as "infinite recursion detected in
-- policy" (42P17) — it surfaced when a writer tried to cast (update a signup).
-- Break the cycle with SECURITY DEFINER lookups that bypass the other table's RLS.

create or replace function public.lr_writer_id(p_reading uuid)
  returns uuid
  language sql
  security definer
  stable
  set search_path = public
as $$
  select writer_id from public.live_readings where id = p_reading;
$$;

create or replace function public.has_live_signup(p_reading uuid)
  returns boolean
  language sql
  security definer
  stable
  set search_path = public
as $$
  select exists (
    select 1 from public.live_reading_signups
    where live_reading_id = p_reading and actor_id = auth.uid()
  );
$$;

grant execute on function public.lr_writer_id(uuid) to authenticated, anon;
grant execute on function public.has_live_signup(uuid) to authenticated, anon;

-- Readings: signed-up actors can still see an unlisted reading — now via the
-- definer helper, so this no longer reaches into live_reading_signups' RLS.
drop policy if exists "Live readings are viewable" on public.live_readings;
create policy "Live readings are viewable" on public.live_readings
  for select using (
    visibility = 'public'
    or auth.uid() = writer_id
    or exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin)
    or public.has_live_signup(id)
  );

-- Sign-ups: the reading's writer can still manage them — now via the definer
-- helper, so this no longer reaches into live_readings' RLS.
drop policy if exists "Writers manage signups for own readings" on public.live_reading_signups;
create policy "Writers manage signups for own readings" on public.live_reading_signups
  for update using (public.lr_writer_id(live_reading_id) = auth.uid());
