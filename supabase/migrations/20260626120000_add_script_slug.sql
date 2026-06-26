-- Name-based URLs for scripts: a `slug` derived from the title.
-- New scripts get one automatically (trigger); existing rows are backfilled.

alter table public.scripts add column if not exists slug text;

-- "Booth Nine" -> "booth-nine"; null when nothing usable remains.
create or replace function public.slugify(txt text)
returns text language sql immutable as $$
  select nullif(trim(both '-' from regexp_replace(lower(coalesce(txt, '')), '[^a-z0-9]+', '-', 'g')), '');
$$;

-- On insert, set slug from title if not provided, de-duplicating with -2, -3, …
create or replace function public.scripts_set_slug()
returns trigger language plpgsql as $$
declare base text; cand text; n int := 0;
begin
  if new.slug is null or new.slug = '' then
    base := coalesce(public.slugify(new.title), 'script');
    cand := base;
    while exists (select 1 from public.scripts where slug = cand and id <> new.id) loop
      n := n + 1;
      cand := base || '-' || n;
    end loop;
    new.slug := cand;
  end if;
  return new;
end $$;

drop trigger if exists trg_scripts_set_slug on public.scripts;
create trigger trg_scripts_set_slug
  before insert on public.scripts
  for each row execute function public.scripts_set_slug();

-- Backfill existing rows (dedupe within the backfill).
with ranked as (
  select id,
         coalesce(public.slugify(title), 'script') as base,
         row_number() over (
           partition by coalesce(public.slugify(title), 'script') order by id
         ) as rn
  from public.scripts
  where slug is null or slug = ''
)
update public.scripts s
set slug = case when r.rn = 1 then r.base else r.base || '-' || r.rn end
from ranked r
where s.id = r.id;

create unique index if not exists scripts_slug_key on public.scripts (slug);
