-- Cast MVP Database Schema
-- Run this in the Supabase SQL Editor

-- ============================================================
-- TABLES
-- ============================================================

-- Users (extends auth.users)
create table public.users (
  id uuid references auth.users(id) on delete cascade primary key,
  role text check (role in ('writer', 'actor', 'audience')),
  display_name text not null default '',
  avatar_url text,
  bio text,
  genre_specialties text[] default '{}',
  writers_choice_count integer not null default 0,
  audience_favorite_count integer not null default 0,
  created_at timestamptz not null default now()
);

-- Scripts
create table public.scripts (
  id uuid default gen_random_uuid() primary key,
  writer_id uuid references public.users(id) on delete cascade not null,
  title text not null,
  genre text not null,
  logline text not null default '',
  file_url text not null,
  parsed_json jsonb,
  status text not null default 'open' check (status in ('open', 'casting', 'assembled', 'published')),
  submission_deadline timestamptz not null,
  created_at timestamptz not null default now()
);

-- Characters
create table public.characters (
  id uuid default gen_random_uuid() primary key,
  script_id uuid references public.scripts(id) on delete cascade not null,
  name text not null,
  description text,
  line_count integer not null default 0
);

-- Submissions
create table public.submissions (
  id uuid default gen_random_uuid() primary key,
  actor_id uuid references public.users(id) on delete cascade not null,
  character_id uuid references public.characters(id) on delete cascade not null,
  script_id uuid references public.scripts(id) on delete cascade not null,
  video_url text not null,
  take_number integer not null default 1,
  is_writers_choice boolean not null default false,
  is_audience_favorite boolean not null default false,
  vote_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique(actor_id, character_id, take_number)
);

-- Assembled Reads
create table public.assembled_reads (
  id uuid default gen_random_uuid() primary key,
  script_id uuid references public.scripts(id) on delete cascade not null unique,
  video_url text,
  youtube_url text,
  view_count integer not null default 0,
  status text not null default 'processing' check (status in ('processing', 'ready', 'failed')),
  created_at timestamptz not null default now()
);

-- Votes
create table public.votes (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.users(id) on delete cascade not null,
  submission_id uuid references public.submissions(id) on delete cascade not null,
  created_at timestamptz not null default now(),
  unique(user_id, submission_id)
);

-- Comments
create table public.comments (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.users(id) on delete cascade not null,
  assembled_read_id uuid references public.assembled_reads(id) on delete cascade not null,
  scene_index integer,
  body text not null,
  created_at timestamptz not null default now()
);

-- Notifications
create table public.notifications (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.users(id) on delete cascade not null,
  type text not null,
  payload jsonb not null default '{}',
  read boolean not null default false,
  created_at timestamptz not null default now()
);

-- Push Tokens
create table public.push_tokens (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.users(id) on delete cascade not null,
  token text not null,
  platform text,
  created_at timestamptz not null default now(),
  unique(user_id, token)
);

-- ============================================================
-- INDEXES
-- ============================================================

create index idx_scripts_writer_id on public.scripts(writer_id);
create index idx_scripts_status on public.scripts(status);
create index idx_characters_script_id on public.characters(script_id);
create index idx_submissions_actor_id on public.submissions(actor_id);
create index idx_submissions_character_id on public.submissions(character_id);
create index idx_submissions_script_id on public.submissions(script_id);
create index idx_votes_user_id on public.votes(user_id);
create index idx_votes_submission_id on public.votes(submission_id);
create index idx_comments_assembled_read_id on public.comments(assembled_read_id);
create index idx_notifications_user_id_unread on public.notifications(user_id) where read = false;
create index idx_push_tokens_user_id on public.push_tokens(user_id);

-- ============================================================
-- TRIGGER FUNCTIONS
-- ============================================================

-- Auto-create public.users row when auth.users row is inserted
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.users (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', new.email, '')
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Update writers_choice_count when submissions.is_writers_choice changes
create or replace function public.handle_writers_choice()
returns trigger as $$
begin
  if old.is_writers_choice = false and new.is_writers_choice = true then
    update public.users
    set writers_choice_count = writers_choice_count + 1
    where id = new.actor_id;
  elsif old.is_writers_choice = true and new.is_writers_choice = false then
    update public.users
    set writers_choice_count = greatest(writers_choice_count - 1, 0)
    where id = old.actor_id;
  end if;
  return new;
end;
$$ language plpgsql security definer;

create trigger on_writers_choice_change
  after update of is_writers_choice on public.submissions
  for each row execute function public.handle_writers_choice();

-- Update vote_count when votes are inserted or deleted
create or replace function public.handle_vote_insert()
returns trigger as $$
begin
  update public.submissions
  set vote_count = vote_count + 1
  where id = new.submission_id;
  return new;
end;
$$ language plpgsql security definer;

create or replace function public.handle_vote_delete()
returns trigger as $$
begin
  update public.submissions
  set vote_count = greatest(vote_count - 1, 0)
  where id = old.submission_id;
  return old;
end;
$$ language plpgsql security definer;

create trigger on_vote_insert
  after insert on public.votes
  for each row execute function public.handle_vote_insert();

create trigger on_vote_delete
  after delete on public.votes
  for each row execute function public.handle_vote_delete();

-- ============================================================
-- RPC FUNCTIONS
-- ============================================================

create or replace function public.increment_view_count(read_id uuid)
returns void as $$
  update public.assembled_reads
  set view_count = view_count + 1
  where id = read_id;
$$ language sql security definer;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.users enable row level security;
alter table public.scripts enable row level security;
alter table public.characters enable row level security;
alter table public.submissions enable row level security;
alter table public.assembled_reads enable row level security;
alter table public.votes enable row level security;
alter table public.comments enable row level security;
alter table public.notifications enable row level security;
alter table public.push_tokens enable row level security;

-- Users: everyone can read, users can update their own profile
create policy "Users are viewable by everyone" on public.users
  for select using (true);

create policy "Users can update own profile" on public.users
  for update using (auth.uid() = id);

-- Scripts: everyone can read, writers can insert/update their own
create policy "Scripts are viewable by everyone" on public.scripts
  for select using (true);

create policy "Writers can insert scripts" on public.scripts
  for insert with check (auth.uid() = writer_id);

create policy "Writers can update own scripts" on public.scripts
  for update using (auth.uid() = writer_id);

-- Characters: everyone can read, system can insert (via service role in edge function)
create policy "Characters are viewable by everyone" on public.characters
  for select using (true);

create policy "Writers can insert characters for own scripts" on public.characters
  for insert with check (
    exists (
      select 1 from public.scripts
      where scripts.id = script_id and scripts.writer_id = auth.uid()
    )
  );

-- Submissions: everyone can read, actors can insert their own
create policy "Submissions are viewable by everyone" on public.submissions
  for select using (true);

create policy "Actors can insert submissions" on public.submissions
  for insert with check (auth.uid() = actor_id);

create policy "Writers can update submissions for own scripts" on public.submissions
  for update using (
    exists (
      select 1 from public.scripts
      where scripts.id = script_id and scripts.writer_id = auth.uid()
    )
  );

-- Assembled Reads: everyone can read, writers can insert for own scripts
create policy "Assembled reads are viewable by everyone" on public.assembled_reads
  for select using (true);

create policy "Writers can insert assembled reads" on public.assembled_reads
  for insert with check (
    exists (
      select 1 from public.scripts
      where scripts.id = script_id and scripts.writer_id = auth.uid()
    )
  );

create policy "System can update assembled reads" on public.assembled_reads
  for update using (true);

-- Votes: everyone can read, users can insert/delete their own
create policy "Votes are viewable by everyone" on public.votes
  for select using (true);

create policy "Users can vote" on public.votes
  for insert with check (auth.uid() = user_id);

create policy "Users can remove own vote" on public.votes
  for delete using (auth.uid() = user_id);

-- Comments: everyone can read, users can insert their own
create policy "Comments are viewable by everyone" on public.comments
  for select using (true);

create policy "Users can insert comments" on public.comments
  for insert with check (auth.uid() = user_id);

-- Notifications: users can only see their own
create policy "Users see own notifications" on public.notifications
  for select using (auth.uid() = user_id);

create policy "Users can update own notifications" on public.notifications
  for update using (auth.uid() = user_id);

create policy "System can insert notifications" on public.notifications
  for insert with check (true);

-- Push Tokens: users can manage their own
create policy "Users see own push tokens" on public.push_tokens
  for select using (auth.uid() = user_id);

create policy "Users can insert push tokens" on public.push_tokens
  for insert with check (auth.uid() = user_id);

create policy "Users can delete own push tokens" on public.push_tokens
  for delete using (auth.uid() = user_id);

-- ============================================================
-- STORAGE BUCKETS
-- ============================================================
-- Create these in the Supabase dashboard:
-- 1. "scripts" (private) - for uploaded PDF scripts
-- 2. "submissions" (private) - for actor video submissions
-- 3. "assembled-reads" (public) - for final assembled videos
-- 4. "avatars" (public) - for user profile images
