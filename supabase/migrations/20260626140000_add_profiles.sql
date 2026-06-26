-- Public profiles. users already has display_name, avatar_url, bio, and is
-- "viewable by everyone". This adds a URL handle (username), a website, and
-- social links (jsonb), plus an update policy so users can edit their profile.

alter table public.users
  add column if not exists username text,
  add column if not exists website  text,
  add column if not exists links    jsonb not null default '{}'::jsonb;

-- Username handle from display_name (reuse slugify from the scripts migration),
-- de-duplicated with -2, -3, …. Only set when blank, so it stays stable.
create or replace function public.users_set_username()
returns trigger language plpgsql as $$
declare base text; cand text; n int := 0;
begin
  if new.username is null or new.username = '' then
    base := coalesce(public.slugify(new.display_name), 'user');
    cand := base;
    while exists (select 1 from public.users where username = cand and id <> new.id) loop
      n := n + 1; cand := base || '-' || n;
    end loop;
    new.username := cand;
  end if;
  return new;
end $$;

drop trigger if exists trg_users_set_username on public.users;
create trigger trg_users_set_username
  before insert on public.users
  for each row execute function public.users_set_username();

-- Backfill existing users (dedupe within the backfill).
with ranked as (
  select id,
         coalesce(public.slugify(display_name), 'user') as base,
         row_number() over (
           partition by coalesce(public.slugify(display_name), 'user') order by created_at
         ) as rn
  from public.users
  where username is null or username = ''
)
update public.users u
set username = case when r.rn = 1 then r.base else r.base || '-' || r.rn end
from ranked r
where u.id = r.id;

create unique index if not exists users_username_key on public.users (username);

-- Let a user edit their own profile (avatar, bio, website, links, username).
drop policy if exists "Users update own profile" on public.users;
create policy "Users update own profile" on public.users
  for update using (auth.uid() = id) with check (auth.uid() = id);
