-- Kill the "open for auditions" broadcast — it leaks private script titles.
--
-- A dashboard-created trigger (not in the migrations; the phrase "open for
-- auditions" appears nowhere in the repo) fires on every scripts INSERT and
-- notifies every user with the actor role that the script "is now open for
-- auditions". Casting has been invitation-only since 2026-08-04 and uploads
-- default to private, so the message is false — and it pushes private script
-- TITLES to unrelated users, against the "private by default" promise.
--
-- 1. Drop whatever notification trigger(s) sit on scripts. Found by function
--    body rather than by name, since the name was never in the repo. The two
--    repo-known triggers (slug generation, protect_script_entitlement) don't
--    touch notifications, so they survive this filter.
do $$
declare t record;
begin
  for t in
    select tg.tgname
    from pg_trigger tg
    join pg_proc p on p.oid = tg.tgfoid
    where tg.tgrelid = 'public.scripts'::regclass
      and not tg.tgisinternal
      and pg_get_functiondef(p.oid) ilike '%notifications%'
  loop
    execute format('drop trigger %I on public.scripts', t.tgname);
    raise notice 'dropped trigger %', t.tgname;
  end loop;
end $$;

-- 2. Replace it with an admin-only upload signal, honestly worded — so new
--    uploads still surface in the operator's bell, and the trigger finally
--    lives in the repo.
create or replace function public.notify_admins_new_script()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications (user_id, type, payload)
  select u.id, 'new_script',
    jsonb_build_object(
      'title', 'New Script',
      'body', coalesce(new.title, 'Untitled') || ' was uploaded',
      'script_id', new.id,
      'genre', new.genre
    )
  from public.users u
  where u.is_admin;
  return new;
end $$;

drop trigger if exists notify_admins_new_script on public.scripts;
create trigger notify_admins_new_script
  after insert on public.scripts
  for each row execute function public.notify_admins_new_script();

-- 3. Retract the leak: remove the false "open for auditions" notifications
--    from non-admin inboxes (titles of private scripts they can't open).
delete from public.notifications n
where n.type = 'new_script'
  and n.user_id not in (select id from public.users where is_admin);
