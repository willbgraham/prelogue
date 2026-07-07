-- Admin moderation queue: admins review PENDING reads and approve/reject any of them.
-- (Manual moderation while SightEngine video is on the free plan; see moderate-submission.)

-- 1. Let admins SEE non-approved submissions. The restrictive gate otherwise hides any
--    read that isn't approved or the viewer's own — including the pending queue.
drop policy if exists "Approved submissions only" on public.submissions;
create policy "Approved submissions only" on public.submissions
  as restrictive for select
  using (
    moderation_status = 'approved'
    or actor_id = auth.uid()
    or exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin)
  );

-- 2. Let admins update any submission's moderation status (writers can already update
--    submissions on their own scripts; this adds a cross-script admin override).
drop policy if exists "Admins update any submission" on public.submissions;
create policy "Admins update any submission" on public.submissions
  for update
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin))
  with check (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin));
