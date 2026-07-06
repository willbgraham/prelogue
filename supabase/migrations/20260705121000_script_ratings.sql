-- 1–5 star ratings on scripts, one per user. Aggregates are denormalized onto
-- scripts (like submissions.vote_count) so Discover + the script page read them
-- directly with no per-row aggregation.
create table if not exists public.script_ratings (
  script_id uuid not null references public.scripts(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  stars smallint not null check (stars between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (script_id, user_id)
);

alter table public.scripts
  add column if not exists rating_avg numeric(3, 2) not null default 0,
  add column if not exists rating_count integer not null default 0;

-- Keep scripts.rating_avg / rating_count in sync. SECURITY DEFINER so the rater
-- (who doesn't own the script) can still update the aggregate; it only ever
-- writes the two rating columns, so it never touches protected plan columns.
create or replace function public.sync_script_rating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := coalesce(new.script_id, old.script_id);
begin
  update public.scripts s set
    rating_count = (select count(*) from public.script_ratings where script_id = v_id),
    rating_avg = coalesce((select round(avg(stars), 2) from public.script_ratings where script_id = v_id), 0)
  where s.id = v_id;
  return null;
end;
$$;

drop trigger if exists trg_sync_script_rating on public.script_ratings;
create trigger trg_sync_script_rating
  after insert or update or delete on public.script_ratings
  for each row execute function public.sync_script_rating();

alter table public.script_ratings enable row level security;

drop policy if exists "Ratings are viewable by everyone" on public.script_ratings;
create policy "Ratings are viewable by everyone" on public.script_ratings
  for select using (true);

drop policy if exists "Users insert own rating" on public.script_ratings;
create policy "Users insert own rating" on public.script_ratings
  for insert with check (user_id = auth.uid());

drop policy if exists "Users update own rating" on public.script_ratings;
create policy "Users update own rating" on public.script_ratings
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "Users delete own rating" on public.script_ratings;
create policy "Users delete own rating" on public.script_ratings
  for delete using (user_id = auth.uid());
