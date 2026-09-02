-- Emailed export links must survive re-exports.
--
-- A customer exported twice; the second export's supersede-cleanup deleted the
-- first export's file AND row, and the first "your MP3 is ready" email — sent
-- minutes earlier — now 404s (NoSuchKey). Two changes fix the class:
--
--   1. This migration: 'superseded' joins the status check, so cleanup can
--      keep old rows as breadcrumbs (files still get deleted — a 942MB MP4
--      per re-render would pile up) .
--   2. download-export fn: emailed links point there instead of at a raw
--      signed URL; it follows the breadcrumb to the script's newest ready
--      export and redirects to a fresh signed URL. Links never expire and
--      always serve the latest file.
alter table public.daily_renders
  drop constraint if exists daily_renders_status_check;

alter table public.daily_renders
  add constraint daily_renders_status_check
  check (status in ('processing', 'ready', 'failed', 'posted', 'superseded'));
