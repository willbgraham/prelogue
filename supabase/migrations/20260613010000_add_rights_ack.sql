-- Record that the writer attested to owning/controlling the rights to a script
-- at upload time (legal cover for UGC). Additive + nullable; the upload flow
-- writes it best-effort so this can be applied any time without downtime.
alter table public.scripts add column if not exists rights_acknowledged_at timestamptz;
