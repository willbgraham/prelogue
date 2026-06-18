-- Monetization: per-script unlock ($29.99 one-time).
-- Unlocking a script grants BOTH paid features for that script:
--   1. the full AI table read (dialogue + action narration), vs the free
--      first-scene preview;
--   2. invite-only sharing (visibility = 'private').
-- The Stripe webhook flips `full_read_unlocked` on a completed one-time payment.

-- 1. Entitlement flag on the script itself (not the user — it's per-script).
alter table public.scripts
  add column if not exists full_read_unlocked boolean not null default false;
alter table public.scripts
  add column if not exists unlocked_at timestamptz;

-- Stripe customer is reused across a writer's unlock purchases. (The earlier
-- subscription migration that would have added this was never applied, so add
-- it here; harmless if it already exists.)
alter table public.users
  add column if not exists stripe_customer_id text;

-- 2. Invite list for private scripts. Owner adds an email; that person gets
--    read access once they sign in with it.
create table if not exists public.script_invites (
  id          uuid primary key default gen_random_uuid(),
  script_id   uuid not null references public.scripts(id) on delete cascade,
  email       text not null,
  invited_by  uuid references public.users(id),
  created_at  timestamptz not null default now()
);
create unique index if not exists script_invites_script_email_idx
  on public.script_invites (script_id, lower(email));
create index if not exists script_invites_email_idx
  on public.script_invites (lower(email));

alter table public.script_invites enable row level security;

drop policy if exists "owner manages invites" on public.script_invites;
create policy "owner manages invites" on public.script_invites
  for all to authenticated
  using (exists (select 1 from public.scripts s
                 where s.id = script_invites.script_id and s.writer_id = auth.uid()))
  with check (exists (select 1 from public.scripts s
                      where s.id = script_invites.script_id and s.writer_id = auth.uid()));

-- 3. Visibility gate. A SECURITY DEFINER helper resolves "may the caller view
--    this script?" without re-triggering RLS (avoids recursion). Used by the
--    RESTRICTIVE policies below — restrictive policies only ever *further*
--    restrict, so adding them can't widen access or break public/hidden reads
--    (those satisfy `visibility is distinct from 'private'`).
create or replace function public.can_view_script(p_script_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.scripts s
    where s.id = p_script_id
      and (
        s.visibility is distinct from 'private'
        or s.writer_id = auth.uid()
        or exists (
          select 1 from public.script_invites si
          where si.script_id = s.id
            and lower(si.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
        )
      )
  );
$$;
revoke all on function public.can_view_script(uuid) from public;
grant execute on function public.can_view_script(uuid) to authenticated, anon;

-- Gate reads on the script and everything reachable from it.
drop policy if exists "private_scripts_view_guard" on public.scripts;
create policy "private_scripts_view_guard" on public.scripts
  as restrictive for select to public
  using (public.can_view_script(id));

drop policy if exists "private_characters_view_guard" on public.characters;
create policy "private_characters_view_guard" on public.characters
  as restrictive for select to public
  using (public.can_view_script(script_id));

drop policy if exists "private_submissions_view_guard" on public.submissions;
create policy "private_submissions_view_guard" on public.submissions
  as restrictive for select to public
  using (
    public.can_view_script(
      (select c.script_id from public.characters c where c.id = submissions.character_id)
    )
  );
