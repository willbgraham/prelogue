-- Viewer casting: each viewer can pick which actor reads each role in a table
-- read, change it any time, and roles surface actors by "most chosen" (a casting
-- tally, separate from thumbs-up votes).

-- Denormalized tally on the submission so the player/casting can sort by it
-- cheaply; kept accurate by a trigger on casting_choices.
alter table public.submissions add column if not exists chosen_count int not null default 0;

create table if not exists public.casting_choices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  script_id uuid not null references public.scripts(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  submission_id uuid not null references public.submissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, character_id)
);

alter table public.casting_choices enable row level security;

-- A viewer manages (and sees) only their own choices; the public tally lives on
-- submissions.chosen_count, so no need to expose others' individual picks.
create policy "users read own casting choices"
  on public.casting_choices for select using (auth.uid() = user_id);
create policy "users insert own casting choices"
  on public.casting_choices for insert with check (auth.uid() = user_id);
create policy "users update own casting choices"
  on public.casting_choices for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users delete own casting choices"
  on public.casting_choices for delete using (auth.uid() = user_id);

create index if not exists casting_choices_submission_idx on public.casting_choices (submission_id);
create index if not exists casting_choices_character_idx on public.casting_choices (character_id);

-- Keep submissions.chosen_count in sync with the casting tally.
create or replace function public.bump_chosen_count()
returns trigger language plpgsql security definer as $$
begin
  if (TG_OP = 'INSERT') then
    update public.submissions set chosen_count = chosen_count + 1 where id = NEW.submission_id;
  elsif (TG_OP = 'DELETE') then
    update public.submissions set chosen_count = greatest(0, chosen_count - 1) where id = OLD.submission_id;
  elsif (TG_OP = 'UPDATE' and NEW.submission_id is distinct from OLD.submission_id) then
    update public.submissions set chosen_count = greatest(0, chosen_count - 1) where id = OLD.submission_id;
    update public.submissions set chosen_count = chosen_count + 1 where id = NEW.submission_id;
  end if;
  return null;
end; $$;

drop trigger if exists casting_choices_count_trg on public.casting_choices;
create trigger casting_choices_count_trg
  after insert or update or delete on public.casting_choices
  for each row execute function public.bump_chosen_count();
