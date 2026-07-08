-- Newsletter / updates email list. Anyone can subscribe (public insert); only
-- admins can read the list. Emails are lower-cased + unique by the client.
create table if not exists public.subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  source text,
  created_at timestamptz not null default now()
);

alter table public.subscribers enable row level security;

drop policy if exists "Anyone can subscribe" on public.subscribers;
create policy "Anyone can subscribe" on public.subscribers
  for insert with check (true);

drop policy if exists "Admins read subscribers" on public.subscribers;
create policy "Admins read subscribers" on public.subscribers
  for select using (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin));
