-- Let actors delete their own recorded reads (from "Edit profile → Your reads").
-- Dependents (votes, casting_choices, comments via assembled_reads) cascade.
drop policy if exists "Actors can delete own submissions" on public.submissions;
create policy "Actors can delete own submissions" on public.submissions
  for delete using (auth.uid() = actor_id);
