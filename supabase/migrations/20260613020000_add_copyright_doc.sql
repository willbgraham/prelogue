-- Optional proof-of-rights for a script: an uploaded copyright/registration
-- document (stored in the private `scripts` bucket) and/or a registration
-- number (US Copyright Office, WGA, etc.). Scripts with this on file show a
-- "Copyright on file" badge. Additive + nullable; written best-effort by the
-- upload flow so this can be applied any time without downtime.
alter table public.scripts add column if not exists copyright_doc_url text;
alter table public.scripts add column if not exists copyright_reg_number text;
