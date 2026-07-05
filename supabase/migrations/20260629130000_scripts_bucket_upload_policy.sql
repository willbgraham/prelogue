-- Client uploads to the private `scripts` bucket were never possible: the bucket
-- had no INSERT policy (until now it was only written by service-role functions —
-- voice-cues audio — and seeded scripts). Real writers uploading a PDF hit RLS
-- deny → "Upload failed". Let signed-in users write/read files under their own
-- folder ({uid}/…: screenplay PDFs, copyright docs, treatments). Additive — the
-- service-role-written voice-cues/audio paths are unaffected.
drop policy if exists "Writers upload own script files" on storage.objects;
create policy "Writers upload own script files" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'scripts' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "Writers read own script files" on storage.objects;
create policy "Writers read own script files" on storage.objects
  for select to authenticated
  using (bucket_id = 'scripts' and auth.uid()::text = (storage.foldername(name))[1]);
