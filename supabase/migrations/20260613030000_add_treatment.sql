-- Optional treatment PDF for a script (producers often read the treatment
-- before the screenplay). Stored in the private `scripts` bucket; written
-- best-effort by the upload flow so this can be applied any time.
alter table public.scripts add column if not exists treatment_url text;
