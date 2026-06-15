-- UGC moderation (App Store Guideline 1.2): report objectionable content and
-- block abusive users.

create table if not exists public.content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.users(id) on delete cascade,
  kind text not null check (kind in ('submission', 'script', 'user')),
  target_id uuid not null,
  reason text,
  created_at timestamptz not null default now()
);
alter table public.content_reports enable row level security;
-- Reporters can file reports; review happens server-side / in the dashboard.
create policy "users file own reports" on public.content_reports
  for insert with check (auth.uid() = reporter_id);

create table if not exists public.user_blocks (
  id uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references public.users(id) on delete cascade,
  blocked_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (blocker_id, blocked_id)
);
alter table public.user_blocks enable row level security;
create policy "users read own blocks" on public.user_blocks
  for select using (auth.uid() = blocker_id);
create policy "users create own blocks" on public.user_blocks
  for insert with check (auth.uid() = blocker_id);
create policy "users remove own blocks" on public.user_blocks
  for delete using (auth.uid() = blocker_id);

create index if not exists user_blocks_blocker_idx on public.user_blocks (blocker_id);
create index if not exists content_reports_target_idx on public.content_reports (kind, target_id);
