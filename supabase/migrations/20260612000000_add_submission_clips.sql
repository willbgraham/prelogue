-- Per-line actor recording.
--
-- A submission used to be ONE continuous video (`video_url`) that included the
-- dead air while the actor waited through other characters' lines. With per-line
-- recording, a submission is instead a set of gap-free clips — one per line the
-- actor reads — each tagged with its position in the script's flattened element
-- stream so it can be slotted back into an assembled table read in order.
--
-- `clips` shape: [{ "element_index": <int>, "clip_url": "<storage path>" }, ...]
-- ordered ascending by element_index. Legacy single-video takes keep `video_url`
-- set and `clips` null; per-line takes set `clips` and leave `video_url` null.

alter table public.submissions
  add column if not exists clips jsonb;

-- Per-line takes have no single video, so video_url is now optional.
alter table public.submissions
  alter column video_url drop not null;
