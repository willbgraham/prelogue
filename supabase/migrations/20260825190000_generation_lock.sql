-- Per-script generation mutex — closes a real double-billing race.
--
-- Two concurrent generate-voice-cues runs for the same script (script page +
-- studio open at once, a double click, a retry overlapping) each computed the
-- same cache-miss list, each generated the same clips against ElevenLabs, and
-- each debited the writer. Observed in prod 2026-08-25: a paying customer's
-- ledger showed 21 debits in near-identical pairs — 148 credits spent on a
-- ~74-credit script, leaving her 2 credits with 12 lines still ungenerated.
-- The storage writes dedupe (content-addressed upsert); the money didn't.
--
-- The lock is claimed for the duration of ONE generation call (~a batch of 80
-- clips). A second caller gets a 409 and the client waits and retries — by
-- then the first run's clips are in the cache, so the second run's miss list
-- shrinks instead of duplicating. claimed_at doubles as a staleness marker so
-- a crashed run self-clears after 4 minutes.
create table if not exists public.generation_locks (
  script_id  uuid primary key references public.scripts(id) on delete cascade,
  claimed_at timestamptz not null default now()
);

-- RLS on, no policies: only the service role (which bypasses RLS) touches it.
alter table public.generation_locks enable row level security;

create or replace function public.claim_generation_lock(p_script uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  -- A lock older than 4 minutes belongs to a crashed/timed-out run; steal it.
  delete from public.generation_locks
   where script_id = p_script
     and claimed_at < now() - interval '4 minutes';
  insert into public.generation_locks (script_id)
  values (p_script)
  on conflict (script_id) do nothing;
  return found;
end $$;

create or replace function public.release_generation_lock(p_script uuid)
returns void
language sql security definer set search_path = public as $$
  delete from public.generation_locks where script_id = p_script;
$$;

-- Service-role only: these move a mutex that gates billing.
revoke execute on function public.claim_generation_lock(uuid) from public, anon, authenticated;
revoke execute on function public.release_generation_lock(uuid) from public, anon, authenticated;
