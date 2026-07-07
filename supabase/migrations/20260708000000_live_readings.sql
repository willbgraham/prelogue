-- Live Readings: a writer schedules a live (Zoom) reading of a script, actors sign
-- up for roles, the writer casts, and the recording is posted to Prelogue's YouTube.
-- Layer 1 is platform-agnostic (join_url/youtube_url can be pasted by hand); the
-- zoom_* / recording_* columns feed the Zoom + YouTube automation layers. The private
-- live-readings bucket is written by the service role (worker) and read by admins.

-- 1. Scheduled live readings (a script can have several over time).
create table if not exists public.live_readings (
  id uuid primary key default gen_random_uuid(),
  script_id uuid not null references public.scripts(id) on delete cascade,
  writer_id uuid not null references public.users(id) on delete cascade,
  title text not null,
  description text,
  scheduled_at timestamptz not null,
  duration_min int not null default 60,
  signup_deadline timestamptz,
  status text not null default 'scheduled'
    check (status in ('draft','scheduled','live','completed','canceled')),
  visibility text not null default 'public' check (visibility in ('public','unlisted')),
  -- Zoom (Layer 2)
  zoom_meeting_id text,
  zoom_join_url text,
  zoom_start_url text,
  zoom_passcode text,
  -- Recording / YouTube (Layers 2-3)
  recording_status text not null default 'none'
    check (recording_status in ('none','pending','stored','published','failed')),
  recording_path text,
  youtube_url text,
  stream_url text,
  created_at timestamptz not null default now()
);
create index if not exists live_readings_script_idx on public.live_readings(script_id);
create index if not exists live_readings_scheduled_idx on public.live_readings(scheduled_at);

-- 2. Actor sign-ups for a reading's roles.
create table if not exists public.live_reading_signups (
  id uuid primary key default gen_random_uuid(),
  live_reading_id uuid not null references public.live_readings(id) on delete cascade,
  actor_id uuid not null references public.users(id) on delete cascade,
  character_id uuid references public.characters(id) on delete set null,
  status text not null default 'signed_up'
    check (status in ('signed_up','cast','declined','waitlist')),
  note text,
  created_at timestamptz not null default now(),
  unique (live_reading_id, actor_id, character_id)
);
create index if not exists live_reading_signups_reading_idx on public.live_reading_signups(live_reading_id);
create index if not exists live_reading_signups_actor_idx on public.live_reading_signups(actor_id);

alter table public.live_readings enable row level security;
alter table public.live_reading_signups enable row level security;

-- live_readings: public rows visible to all; the writer sees their own; admins see
-- all; a signed-up actor can see an unlisted reading they're part of (for the link).
drop policy if exists "Live readings are viewable" on public.live_readings;
create policy "Live readings are viewable" on public.live_readings
  for select using (
    visibility = 'public'
    or auth.uid() = writer_id
    or exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin)
    or exists (select 1 from public.live_reading_signups s
               where s.live_reading_id = id and s.actor_id = auth.uid())
  );

drop policy if exists "Writers insert own live readings" on public.live_readings;
create policy "Writers insert own live readings" on public.live_readings
  for insert with check (
    auth.uid() = writer_id
    and exists (select 1 from public.scripts s where s.id = script_id and s.writer_id = auth.uid())
  );

drop policy if exists "Writers update own live readings" on public.live_readings;
create policy "Writers update own live readings" on public.live_readings
  for update using (auth.uid() = writer_id);

drop policy if exists "Writers delete own live readings" on public.live_readings;
create policy "Writers delete own live readings" on public.live_readings
  for delete using (auth.uid() = writer_id);

drop policy if exists "Admins manage live readings" on public.live_readings;
create policy "Admins manage live readings" on public.live_readings
  for all
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin))
  with check (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin));

-- live_reading_signups: readable by all (public cast list); actors manage their own;
-- the reading's writer updates status (cast/decline); admins all.
drop policy if exists "Signups are viewable" on public.live_reading_signups;
create policy "Signups are viewable" on public.live_reading_signups
  for select using (true);

drop policy if exists "Actors insert own signups" on public.live_reading_signups;
create policy "Actors insert own signups" on public.live_reading_signups
  for insert with check (auth.uid() = actor_id);

drop policy if exists "Actors update own signups" on public.live_reading_signups;
create policy "Actors update own signups" on public.live_reading_signups
  for update using (auth.uid() = actor_id);

drop policy if exists "Actors delete own signups" on public.live_reading_signups;
create policy "Actors delete own signups" on public.live_reading_signups
  for delete using (auth.uid() = actor_id);

drop policy if exists "Writers manage signups for own readings" on public.live_reading_signups;
create policy "Writers manage signups for own readings" on public.live_reading_signups
  for update using (
    exists (select 1 from public.live_readings lr
            where lr.id = live_reading_id and lr.writer_id = auth.uid())
  );

drop policy if exists "Admins manage signups" on public.live_reading_signups;
create policy "Admins manage signups" on public.live_reading_signups
  for all
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin))
  with check (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin));

-- 3. Private bucket for imported recordings (admins read via signed URL; the worker
--    writes with the service role, which bypasses RLS).
insert into storage.buckets (id, name, public)
  values ('live-readings', 'live-readings', false)
  on conflict (id) do nothing;

drop policy if exists "Admins read live reading recordings" on storage.objects;
create policy "Admins read live reading recordings" on storage.objects
  for select
  using (bucket_id = 'live-readings' and exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin));
