-- Writer pre-moderation of comments. Comments hang off assembled_reads; the
-- moderator is the read's script writer.
alter table public.comments add column if not exists approved boolean not null default false;

-- Grandfather existing comments so nothing already posted disappears.
update public.comments set approved = true where approved = false;

-- A comment is visible if it's approved, it's yours, or you're the writer of the
-- script behind this read (so writers see the pending queue on their own reads).
drop policy if exists "Comments are viewable by everyone" on public.comments;
drop policy if exists "Approved comments are visible" on public.comments;
create policy "Approved comments are visible" on public.comments
  for select using (
    approved
    or user_id = auth.uid()
    or exists (
      select 1
      from public.assembled_reads ar
      join public.scripts s on s.id = ar.script_id
      where ar.id = comments.assembled_read_id and s.writer_id = auth.uid()
    )
  );

-- The read's writer may approve (update) and remove (delete) comments.
drop policy if exists "Writers moderate comments" on public.comments;
create policy "Writers moderate comments" on public.comments
  for update using (
    exists (
      select 1
      from public.assembled_reads ar
      join public.scripts s on s.id = ar.script_id
      where ar.id = comments.assembled_read_id and s.writer_id = auth.uid()
    )
  );
drop policy if exists "Writers delete comments" on public.comments;
create policy "Writers delete comments" on public.comments
  for delete using (
    exists (
      select 1
      from public.assembled_reads ar
      join public.scripts s on s.id = ar.script_id
      where ar.id = comments.assembled_read_id and s.writer_id = auth.uid()
    )
  );
