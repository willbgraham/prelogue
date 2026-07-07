-- Automated daily social-video pipeline: admin gating + a render-tracking table.
-- The private `daily-renders` storage bucket and the "Prelogue Originals" house
-- account are created via the service role (scripts/seed-infra.js), not here.

-- 1. Admin flag (gates /admin). Grant it to the owner.
alter table public.users add column if not exists is_admin boolean not null default false;
update public.users u
  set is_admin = true
  from auth.users a
  where a.id = u.id and lower(a.email) = 'willg1@gmail.com';

-- 2. One row per rendered social video (both variants, many per script).
create table if not exists public.daily_renders (
  id uuid primary key default gen_random_uuid(),
  script_id uuid not null references public.scripts(id) on delete cascade,
  variant text not null default 'ai' check (variant in ('ai', 'composite')),
  status text not null default 'processing' check (status in ('processing', 'ready', 'failed', 'posted')),
  video_path text,        -- path in the private daily-renders bucket
  caption text,           -- editable social caption
  title text,
  duration_frames integer,
  fps integer not null default 30,
  error text,
  created_at timestamptz not null default now(),
  rendered_at timestamptz
);

alter table public.daily_renders enable row level security;

-- Admins only (the worker uses the service role, which bypasses RLS).
drop policy if exists "Admins manage daily renders" on public.daily_renders;
create policy "Admins manage daily renders" on public.daily_renders
  for all
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin))
  with check (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin));

-- 3. Admins can read the private daily-renders bucket (signed previews/downloads).
drop policy if exists "Admins read daily renders" on storage.objects;
create policy "Admins read daily renders" on storage.objects
  for select
  using (bucket_id = 'daily-renders' and exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin));
