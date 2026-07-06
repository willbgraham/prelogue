-- ScriptRevolution-style listing metadata for scripts. Poster art already exists
-- as scripts.cover_image_url (mobile set it; the web upload just never collected
-- it), so this only adds the new fields. All nullable — existing rows stay valid.
-- Re-runnable (add column if not exists + drop/recreate the check constraints).
alter table public.scripts
  add column if not exists synopsis text,
  add column if not exists more_details text,
  add column if not exists format text,
  add column if not exists page_count integer,
  add column if not exists age_rating text,
  add column if not exists listing_status text;

-- Sale/availability status (distinct from the workflow `status` column, which is
-- open/casting/assembled/published).
alter table public.scripts drop constraint if exists scripts_listing_status_check;
alter table public.scripts add constraint scripts_listing_status_check
  check (listing_status is null or listing_status in
    ('free', 'for_sale', 'under_option', 'seeking_finance', 'in_development', 'produced', 'sold'));

alter table public.scripts drop constraint if exists scripts_format_check;
alter table public.scripts add constraint scripts_format_check
  check (format is null or format in ('feature', 'tv_pilot', 'web_series', 'short', 'episode'));

alter table public.scripts drop constraint if exists scripts_age_rating_check;
alter table public.scripts add constraint scripts_age_rating_check
  check (age_rating is null or age_rating in ('everyone', '13', '17'));
