-- Contact / feedback form (public page at /contact).
-- Anyone can send a message; only admins can read them.

create table if not exists public.contact_messages (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  email      text not null,
  topic      text not null default 'question',
  message    text not null,
  user_id    uuid references public.users(id) on delete set null,  -- set when signed in
  handled    boolean not null default false,
  notified_at timestamptz,   -- set by the send-contact fn once emailed
  created_at timestamptz not null default now(),
  constraint contact_name_len    check (char_length(name) between 1 and 120),
  constraint contact_email_len   check (char_length(email) between 3 and 200),
  constraint contact_message_len check (char_length(message) between 1 and 5000)
);
-- Safe to re-run if the table was already created before notified_at existed.
alter table public.contact_messages add column if not exists notified_at timestamptz;

create index if not exists contact_messages_created_idx
  on public.contact_messages (created_at desc);

alter table public.contact_messages enable row level security;

-- Anyone (including signed-out visitors) may submit. Column checks above bound
-- the payload; `handled` can't be pre-set and user_id must be your own.
drop policy if exists "anyone can send a message" on public.contact_messages;
create policy "anyone can send a message" on public.contact_messages
  for insert to anon, authenticated
  with check (
    handled = false
    and (user_id is null or user_id = auth.uid())
  );

-- Only admins read or triage.
drop policy if exists "admins read messages" on public.contact_messages;
create policy "admins read messages" on public.contact_messages
  for select to authenticated
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin));

drop policy if exists "admins update messages" on public.contact_messages;
create policy "admins update messages" on public.contact_messages
  for update to authenticated
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin));
