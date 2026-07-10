-- Character descriptions: writers describe each character so actors browsing
-- roles know who they'd be playing. The characters.description column has
-- existed since the initial schema — what's missing is an UPDATE policy, so
-- the studio editor can actually save.

drop policy if exists "Writers can update characters for own scripts" on public.characters;
create policy "Writers can update characters for own scripts" on public.characters
  for update using (
    exists (
      select 1 from public.scripts
      where scripts.id = script_id and scripts.writer_id = auth.uid()
    )
  );

-- Seed the Booth Nine demo cast (no-ops if a description was already written).
update public.characters set description =
  '28. Wired, sleepless, three coffees deep. He signed something he shouldn''t have and has one night to talk his way out of it — bargaining hard and cracking at the edges.'
  where script_id = 'b0078900-0000-4000-8000-000000000009' and name = 'DANNY' and description is null;

update public.characters set description =
  '40s. The collector. Unhurried and immaculate — the calm of someone who has never once been late. She never raises her voice; every quiet line is leverage.'
  where script_id = 'b0078900-0000-4000-8000-000000000009' and name = 'VERA' and description is null;

update public.characters set description =
  '60s. The graveyard-shift waitress — warm, chatty, endlessly refilling cups. The warmth is real, and it''s also a mask: when the bell over the door goes still, you finally learn what booth nine means.'
  where script_id = 'b0078900-0000-4000-8000-000000000009' and name = 'MARISOL' and description is null;
