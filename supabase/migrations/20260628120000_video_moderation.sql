-- Automated video moderation gate (SightEngine).
-- New actor reads upload as 'pending' and stay hidden from everyone but the
-- uploader until their clips pass moderation. Existing reads are grandfathered
-- to 'approved' so nothing already-live disappears.
alter table public.submissions
  add column if not exists moderation_status text not null default 'pending',
  add column if not exists moderation_meta jsonb;

alter table public.submissions drop constraint if exists submissions_moderation_status_check;
alter table public.submissions
  add constraint submissions_moderation_status_check
  check (moderation_status in ('pending', 'approved', 'rejected'));

-- Grandfather everything that already existed (don't retroactively hide reads).
update public.submissions set moderation_status = 'approved'
  where moderation_status = 'pending';

-- Restrictive gate: ANDs with the existing permissive SELECT policies, so a
-- submission is only visible to other users once approved. The uploading actor
-- always sees their own (any status) so they can watch its review state.
drop policy if exists "Approved submissions only" on public.submissions;
create policy "Approved submissions only" on public.submissions
  as restrictive for select
  using (moderation_status = 'approved' or actor_id = auth.uid());
