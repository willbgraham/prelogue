-- Writer script controls.
--
-- 1. `visibility` lets a writer hide a script from the public lists (Discover /
--    Browse) without deleting it. Values:
--      'public'  — listed everywhere (default, current behaviour)
--      'hidden'  — unlisted; reachable by direct link / owner, just not surfaced
--      'private' — invite-only (reserved for the paid tier; enforced later)
alter table public.scripts
  add column if not exists visibility text not null default 'public';

-- 2. Owner-driven delete. A writer can't delete an actor's submission or the
--    casting tallies through normal RLS, so deleting a script with reads would
--    fail / orphan rows. This SECURITY DEFINER function checks ownership first,
--    then removes the child rows (in FK-safe order) and the script itself.
create or replace function public.delete_script(p_script_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_char_ids uuid[];
begin
  if not exists (
    select 1 from public.scripts
    where id = p_script_id and writer_id = auth.uid()
  ) then
    raise exception 'Not authorized to delete this script';
  end if;

  select array_agg(id) into v_char_ids
  from public.characters where script_id = p_script_id;

  if v_char_ids is not null then
    -- casting tallies first (their trigger touches submissions, which still exist here)
    if to_regclass('public.casting_choices') is not null then
      delete from public.casting_choices where character_id = any(v_char_ids);
    end if;
    delete from public.submissions where character_id = any(v_char_ids);
  end if;

  delete from public.characters where script_id = p_script_id;
  delete from public.scripts   where id = p_script_id;
end;
$$;

-- Only signed-in users may call it; the body still enforces per-row ownership.
revoke all on function public.delete_script(uuid) from public;
grant execute on function public.delete_script(uuid) to authenticated;
