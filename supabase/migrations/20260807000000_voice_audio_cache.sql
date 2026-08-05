-- An index of every generated voice clip, so "have I already made this?" is one
-- query instead of listing a storage folder.
--
-- Why: the existence check used storage.list(), which caps at 1000 objects per
-- call and shares one folder per voice across every script. The default
-- narrator already holds 1,500+ clips, so cached audio looked missing and was
-- regenerated — real ElevenLabs spend, and (once credits shipped) writers
-- charged twice for audio they already had. Pagination fixed the correctness;
-- this fixes the shape: O(1) lookups that don't degrade as the cache grows.

create table if not exists public.voice_audio_cache (
  key        text primary key,     -- "{voice_id}/{sha1(text)}{settings_tag}"
  voice_id   text not null,
  path       text not null,        -- storage path in the `scripts` bucket
  chars      int,                  -- characters generated (cost analytics)
  created_at timestamptz not null default now()
);
create index if not exists voice_audio_cache_voice_idx
  on public.voice_audio_cache (voice_id);

alter table public.voice_audio_cache enable row level security;
-- No policies: only the service role (edge functions) reads or writes this.

-- Backfill from what's already in storage. storage.objects is a real table, so
-- every clip ever generated is indexed here in one pass — without this, every
-- existing script would look uncached and be regenerated (and re-billed) once.
-- Paths are voice-cues/audio/{voice_id}/{hash}{tag}.mp3
insert into public.voice_audio_cache (key, voice_id, path, created_at)
select
  split_part(o.name, '/', 3) || '/' || regexp_replace(split_part(o.name, '/', 4), '\.mp3$', ''),
  split_part(o.name, '/', 3),
  o.name,
  coalesce(o.created_at, now())
from storage.objects o
where o.bucket_id = 'scripts'
  and o.name like 'voice-cues/audio/%/%'
  and o.name like '%.mp3'
on conflict (key) do nothing;
