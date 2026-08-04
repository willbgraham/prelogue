-- Part A — CRITICAL: the screenplay-PDF leak is STILL open after
-- 20260804100000. That migration tried to *find and drop* the over-broad
-- policy, but the offending grant on the `scripts` bucket didn't match the
-- pattern (it was created in the dashboard, so it isn't in any migration and
-- we can't see its definition from here). Verified after that migration ran:
-- anon still downloads a real writer's PDF with HTTP 200.
--
-- Fix properly this time: a RESTRICTIVE policy. Restrictive policies are ANDed
-- with every permissive policy, so this denies private-bucket reads regardless
-- of what permissive grants exist now or get added in the dashboard later.
-- `daily-renders` and `live-readings` are already anon-proof (verified) and are
-- served through service-role signed URLs, so they're left as-is.

drop policy if exists "private_object_read_guard" on storage.objects;
create policy "private_object_read_guard" on storage.objects
  as restrictive for select to anon, authenticated
  using (
    case bucket_id
      -- scripts: generated read assets are public (anonymous demo playback
      -- signs these); a writer's own {uid}/… uploads are theirs alone.
      when 'scripts' then (
        name like 'voice-cues/%'
        or name like 'ambience/%'
        or auth.uid()::text = (storage.foldername(name))[1]
      )
      -- submissions: approved clips play publicly; actors keep their own
      -- folder; writers/admins resolved by the helper (20260804100000).
      when 'submissions' then (
        auth.uid()::text = (storage.foldername(name))[1]
        or public.submission_object_visible(name)
      )
      else true
    end
  );

-- Part B — Role invites: the writer invites a specific actor to read a part.
-- Private-by-default means actors can no longer browse for roles, so casting is
-- now invitation-only: writer picks a character → invites by email → the actor
-- gets access to that script to record → the writer reviews the takes and picks
-- one (submissions.is_writers_choice, which already drives the read).
create table if not exists public.role_invites (
  id           uuid primary key default gen_random_uuid(),
  script_id    uuid not null references public.scripts(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  email        text not null,
  invited_by   uuid references public.users(id),
  note         text,
  status       text not null default 'invited'
               check (status in ('invited', 'declined', 'recorded')),
  created_at   timestamptz not null default now()
);
create unique index if not exists role_invites_char_email_idx
  on public.role_invites (character_id, lower(email));
create index if not exists role_invites_email_idx on public.role_invites (lower(email));
create index if not exists role_invites_script_idx on public.role_invites (script_id);

alter table public.role_invites enable row level security;

-- Writer of the script manages invites for it.
drop policy if exists "writer manages role invites" on public.role_invites;
create policy "writer manages role invites" on public.role_invites
  for all to authenticated
  using (exists (select 1 from public.scripts s
                 where s.id = role_invites.script_id and s.writer_id = auth.uid()))
  with check (exists (select 1 from public.scripts s
                      where s.id = role_invites.script_id and s.writer_id = auth.uid()));

-- The invited actor can see their own invitations (matched on their email).
drop policy if exists "actor sees own role invites" on public.role_invites;
create policy "actor sees own role invites" on public.role_invites
  for select to authenticated
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- An invited actor must be able to open the (private) script to read it.
-- Extends the same helper that powers invites + approved listen requests.
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
        or exists (
          select 1 from public.listen_requests lr
          where lr.script_id = s.id
            and lr.requester_id = auth.uid()
            and lr.status = 'approved'
        )
        or exists (
          select 1 from public.role_invites ri
          where ri.script_id = s.id
            and lower(ri.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
        )
      )
  );
$$;

-- Part C — Listen requests carry an optional note ("Producer, Blue Hour Films"),
-- so the writer can judge who's asking instead of seeing a bare email.
alter table public.listen_requests add column if not exists note text;
