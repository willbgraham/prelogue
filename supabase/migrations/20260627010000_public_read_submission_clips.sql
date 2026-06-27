-- Actor recordings are meant to be watched in table reads. Submissions are
-- already table-level "viewable by everyone", so allow reading their storage
-- objects too (via signed URLs) — otherwise the web/mobile players can't play
-- the spliced-in clips for anyone but the uploader.
drop policy if exists "Public read submission clips" on storage.objects;
create policy "Public read submission clips"
  on storage.objects for select
  using (bucket_id = 'submissions');
