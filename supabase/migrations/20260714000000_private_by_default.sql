-- Tool first: new scripts are private unless the writer publishes them.
-- (RLS enforcement already exists — can_view_script + the restrictive view
-- guards from 20260618100000; this just flips the default for new rows.
-- Existing scripts keep whatever visibility the writer chose.)

alter table public.scripts alter column visibility set default 'private';
