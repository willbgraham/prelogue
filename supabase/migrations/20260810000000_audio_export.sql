-- Audio-only export.
--
-- MP4 export is page-capped because Remotion renders roughly 1:1 with the
-- video's runtime and the Actions job dies at 60 minutes. Audio export has no
-- such ceiling: the voice clips already exist in storage, so the worker just
-- ffmpeg-concats them (a 101-page feature stitched in about a minute). To let
-- those exports live in daily_renders alongside the video ones, the variant
-- check has to admit 'audio'.
alter table public.daily_renders
  drop constraint if exists daily_renders_variant_check;

alter table public.daily_renders
  add constraint daily_renders_variant_check
  check (variant in ('ai', 'composite', 'audio'));
