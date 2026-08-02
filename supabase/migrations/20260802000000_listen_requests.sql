-- Request-to-listen showcase ("screener requests").
--
-- A writer can list their script publicly on Discover (poster, genre, logline,
-- writer name/avatar) while the script itself — text AND audio — stays locked
-- until they approve each listener individually. Listeners request access with
-- an account that carries a name + LinkedIn or IMDb.
--
-- Mechanics: showcase = visibility 'private' (so the existing can_view_script
-- restrictive guards protect parsed_json/characters/etc from non-approved
-- callers, API included) + listen_gated = true (so it still appears publicly
-- via the SECURITY DEFINER listing functions below, which expose only the
-- public card fields). Approval extends can_view_script, which unlocks the
-- row for the requester; generate-voice-cues enforces the same rule for audio.

-- 1. The showcase flag. Writer-controlled (their own choice; existing
--    "Writers can update own scripts" policy covers it).
alter table public.scripts
  add column if not exists listen_gated boolean not null default false;

-- 2. Listen requests.
create table if not exists public.listen_requests (
  id           uuid primary key default gen_random_uuid(),
  script_id    uuid not null references public.scripts(id) on delete cascade,
  requester_id uuid not null references public.users(id) on delete cascade,
  -- Snapshot of the requester's account email so the writer can reach them
  -- (they're asking the writer for access; sharing contact info is the point).
  email        text,
  status       text not null default 'pending' check (status in ('pending','approved','denied')),
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);
create unique index if not exists listen_requests_script_requester_idx
  on public.listen_requests (script_id, requester_id);
create index if not exists listen_requests_script_idx on public.listen_requests (script_id);

alter table public.listen_requests enable row level security;

-- Requesters create their own (always pending) and can see/withdraw their own.
drop policy if exists "requester creates own" on public.listen_requests;
create policy "requester creates own" on public.listen_requests
  for insert to authenticated
  with check (requester_id = auth.uid() and status = 'pending');

drop policy if exists "requester sees own" on public.listen_requests;
create policy "requester sees own" on public.listen_requests
  for select to authenticated
  using (requester_id = auth.uid());

drop policy if exists "requester withdraws own" on public.listen_requests;
create policy "requester withdraws own" on public.listen_requests
  for delete to authenticated
  using (requester_id = auth.uid());

-- The script's writer reviews and decides.
drop policy if exists "writer sees script requests" on public.listen_requests;
create policy "writer sees script requests" on public.listen_requests
  for select to authenticated
  using (exists (select 1 from public.scripts s
                 where s.id = listen_requests.script_id and s.writer_id = auth.uid()));

drop policy if exists "writer decides script requests" on public.listen_requests;
create policy "writer decides script requests" on public.listen_requests
  for update to authenticated
  using (exists (select 1 from public.scripts s
                 where s.id = listen_requests.script_id and s.writer_id = auth.uid()))
  with check (exists (select 1 from public.scripts s
                      where s.id = listen_requests.script_id and s.writer_id = auth.uid()));

-- 3. Approved requesters can view the (private) script: extend can_view_script.
--    Same body as 20260618100000 plus the listen_requests branch. All the
--    restrictive guards that call this function pick the change up automatically.
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
      )
  );
$$;

-- 4. Public listing projections for gated scripts. SECURITY DEFINER on purpose:
--    the script row itself is private, but these expose ONLY the showcase card
--    fields (never parsed_json, voice_config, or file paths).
create or replace function public.get_discover_listings()
returns table (
  id uuid, slug text, title text, genre text, logline text,
  cover_image_url text, page_count int, format text, listing_status text,
  writer_id uuid, writer_name text, writer_username text, writer_avatar text,
  created_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select s.id, s.slug, s.title, s.genre, s.logline,
         s.cover_image_url, s.page_count, s.format, s.listing_status,
         u.id, u.display_name, u.username, u.avatar_url,
         s.created_at
  from public.scripts s
  join public.users u on u.id = s.writer_id
  where s.listen_gated = true and s.status = 'open'
  order by s.created_at desc
$$;
grant execute on function public.get_discover_listings() to anon, authenticated;

create or replace function public.get_script_listing(p_handle text)
returns table (
  id uuid, slug text, title text, genre text, logline text, synopsis text,
  cover_image_url text, page_count int, format text, listing_status text,
  writer_id uuid, writer_name text, writer_username text, writer_avatar text
)
language sql
security definer
stable
set search_path = public
as $$
  select s.id, s.slug, s.title, s.genre, s.logline, s.synopsis,
         s.cover_image_url, s.page_count, s.format, s.listing_status,
         u.id, u.display_name, u.username, u.avatar_url
  from public.scripts s
  join public.users u on u.id = s.writer_id
  where s.listen_gated = true
    and (s.slug = p_handle or s.id::text = p_handle)
  limit 1
$$;
grant execute on function public.get_script_listing(text) to anon, authenticated;
