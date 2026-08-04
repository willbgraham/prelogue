-- Pre-ads security hardening (2026-08-04 sweep). Each block closes a verified
-- hole; service_role (edge fns, webhook, worker) bypasses RLS so server paths
-- keep working.

-- 1. CRITICAL: users UPDATE policy has no column scope, so any user could set
--    their own is_admin=true and unlock the entire admin surface. Fold is_admin
--    into the existing billing-column guard trigger.
create or replace function public.protect_plan_columns()
returns trigger
language plpgsql
security definer
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    new.plan := old.plan;
    new.plan_status := old.plan_status;
    new.stripe_customer_id := old.stripe_customer_id;
    new.stripe_subscription_id := old.stripe_subscription_id;
    new.plan_renews_at := old.plan_renews_at;
    new.plan_pages_used := old.plan_pages_used;
    new.is_admin := old.is_admin;
  end if;
  return new;
end;
$$;
-- (trigger protect_plan_columns_trg already installed; body replaced above.)

-- 2. CRITICAL: "System can insert notifications" was `with check (true)` — anon
--    could write phishing notifications into anyone's inbox. Clients never
--    insert cross-user rows directly (they go through the send-notification
--    fn, which uses the service role), so self-only is safe.
drop policy if exists "System can insert notifications" on public.notifications;
create policy "Users can insert own notifications" on public.notifications
  for insert with check (auth.uid() = user_id);

-- 3. HIGH: anyone could UPDATE any assembled_reads row (policy `using (true)`).
drop policy if exists "System can update assembled reads" on public.assembled_reads;
create policy "Writers update own assembled reads" on public.assembled_reads
  for update using (exists (
    select 1 from public.scripts s
    where s.id = assembled_reads.script_id and s.writer_id = auth.uid()
  ));

-- 4. MEDIUM: comments could be inserted pre-approved (insert policy predates
--    the approved column). Force every non-service insert into the queue.
create or replace function public.force_comment_pending()
returns trigger
language plpgsql
security definer
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    new.approved := false;
  end if;
  return new;
end;
$$;
drop trigger if exists force_comment_pending_trg on public.comments;
create trigger force_comment_pending_trg
  before insert on public.comments
  for each row execute function public.force_comment_pending();

-- 5. HIGH: actors could insert submissions pre-approved (skipping SightEngine).
--    Non-service writes always enter moderation as pending.
create or replace function public.protect_submission_moderation()
returns trigger
language plpgsql
security definer
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    if tg_op = 'INSERT' then
      new.moderation_status := 'pending';
      new.moderation_meta := null;
    else
      new.moderation_status := old.moderation_status;
      new.moderation_meta := old.moderation_meta;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists protect_submission_moderation_trg on public.submissions;
create trigger protect_submission_moderation_trg
  before insert or update on public.submissions
  for each row execute function public.protect_submission_moderation();

-- 6. HIGH: live_readings rows exposed zoom_start_url + zoom_passcode (the HOST
--    link — meeting takeover) to any reader. No client reads these columns
--    (verified), so revoke them outright; the service role keeps access.
revoke select (zoom_start_url, zoom_passcode) on public.live_readings from anon, authenticated;

-- 6b. CRITICAL: anonymous users could LIST and DOWNLOAD every writer's uploaded
--     screenplay PDF from the private `scripts` bucket (verified: HTTP 200 on a
--     real writer's file with only the public anon key). The bucket itself is
--     private and the migration-defined policies are correctly owner-scoped, so
--     a broad SELECT policy was added out-of-band (dashboard) to make anonymous
--     demo playback work — it granted the whole bucket instead of just the
--     generated-audio prefixes.
--
--     Drop any over-broad anon/public SELECT policy on the scripts bucket, then
--     re-grant exactly what playback needs: voice-cues/* and ambience/*.
--     Writers keep owner-scoped access to their own {uid}/ files via
--     "Writers read own script files" (20260629130000), which is preserved.
do $$
declare p record; n int := 0;
begin
  for p in
    select policyname,
           coalesce(roles::text, '') as r,
           coalesce(qual::text, '') || coalesce(with_check::text, '') as def
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
  loop
    if p.def like '%''scripts''%'
       and p.policyname not in ('Writers upload own script files', 'Writers read own script files')
       and (p.r like '%anon%' or p.r like '%public%')
       and p.def not like '%voice-cues%'
    then
      execute format('drop policy %I on storage.objects', p.policyname);
      raise notice 'dropped over-broad scripts-bucket policy: %', p.policyname;
      n := n + 1;
    end if;
  end loop;
  raise notice 'over-broad scripts-bucket policies dropped: %', n;
end $$;

drop policy if exists "Read generated read assets" on storage.objects;
create policy "Read generated read assets" on storage.objects
  for select to anon, authenticated
  using (
    bucket_id = 'scripts'
    and (name like 'voice-cues/%' or name like 'ambience/%')
  );

-- 6c. HIGH: the whole `submissions` bucket was world-readable
--     (20260627010000: `for select using (bucket_id = 'submissions')`), so
--     anyone could list and download every actor's audition video — including
--     ones still pending moderation or already rejected, which the DB-level
--     restrictive policy is supposed to hide.
--
--     Scope it: a clip is anonymously readable only if it belongs to an
--     APPROVED submission (that's what public table reads play). Actors keep
--     their own folder, writers see clips on their own scripts (they must
--     review pending takes), and admins see everything.
create or replace function public.submission_object_visible(p_name text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    -- approved clip → public (anonymous demo playback depends on this)
    exists (
      select 1 from public.submissions s
      where s.moderation_status = 'approved'
        and (
          s.video_url = p_name
          or exists (
            select 1 from jsonb_array_elements(coalesce(s.clips, '[]'::jsonb)) c
            where c ->> 'clip_url' = p_name
          )
        )
    )
    -- or the writer of the script it was submitted to (reviews pending takes)
    or exists (
      select 1
      from public.submissions s
      join public.characters ch on ch.id = s.character_id
      join public.scripts sc on sc.id = ch.script_id
      where sc.writer_id = auth.uid()
        and (
          s.video_url = p_name
          or exists (
            select 1 from jsonb_array_elements(coalesce(s.clips, '[]'::jsonb)) c
            where c ->> 'clip_url' = p_name
          )
        )
    )
    -- or an admin (moderation queue)
    or exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin);
$$;
revoke all on function public.submission_object_visible(text) from public;
grant execute on function public.submission_object_visible(text) to anon, authenticated;

drop policy if exists "Public read submission clips" on storage.objects;
drop policy if exists "Read submission clips" on storage.objects;
create policy "Read submission clips" on storage.objects
  for select to anon, authenticated
  using (
    bucket_id = 'submissions'
    and (
      -- the actor's own folder ({uid}/…) is always theirs
      auth.uid()::text = (storage.foldername(name))[1]
      or public.submission_object_visible(name)
    )
  );

-- 7. Server-side budget for DEMO voice generation. The public demo lets anyone
--    (by design) re-cast voices, but the only cap was localStorage — curl
--    could drain ElevenLabs credits. Edge fns tally generated characters here
--    and refuse demo generation past a daily ceiling. Service-role only.
create table if not exists public.demo_tts_usage (
  day date primary key,
  chars bigint not null default 0
);
alter table public.demo_tts_usage enable row level security;
-- no policies: only the service role (bypasses RLS) may read/write.
