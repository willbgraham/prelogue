-- Tracks writer-designed ElevenLabs voices so design-voice can (a) cap how many
-- exist per script and (b) recycle the finite account voice slot when a role's
-- designed voice is replaced. All writes happen via the edge function (service
-- role); writers may read their own scripts' designed voices.
create table if not exists public.designed_voices (
  id uuid primary key default gen_random_uuid(),
  script_id uuid references public.scripts(id) on delete cascade not null,
  character text,                 -- UPPER character name, or '__narrator__'
  voice_id text not null,         -- the ElevenLabs voice_id
  voice_name text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_designed_voices_script on public.designed_voices(script_id);

alter table public.designed_voices enable row level security;
drop policy if exists "Writers view own designed voices" on public.designed_voices;
create policy "Writers view own designed voices" on public.designed_voices
  for select using (
    exists (select 1 from public.scripts s where s.id = script_id and s.writer_id = auth.uid())
  );
