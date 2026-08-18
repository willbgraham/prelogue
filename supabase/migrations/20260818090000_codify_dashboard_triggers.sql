-- Codify the four dashboard-created triggers (audit 2026-08-18).
--
-- These have existed in prod for months but in no migration file — created by
-- hand in the dashboard, invisible to the repo. Definitions below are verbatim
-- from pg_get_functiondef. All four were audited: each notifies exactly one
-- legitimate recipient (or just syncs counts); no broadcasts.
--
-- Prod already has all of this, so running it there is a no-op made of
-- CREATE OR REPLACE + drop/recreate inside one transaction. Its real value is
-- that a rebuild-from-migrations now produces the database that actually runs.

-- ── 1. New submission → notify the script's writer ("New Audition") ──
CREATE OR REPLACE FUNCTION public.notify_new_submission()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  INSERT INTO public.notifications (user_id, type, payload)
  SELECT
    s.writer_id,
    'new_submission',
    jsonb_build_object(
      'title', 'New Audition',
      'body', u.display_name || ' submitted for ' || c.name || ' in ' || s.title,
      'script_id', NEW.script_id,
      'character_id', NEW.character_id,
      'submission_id', NEW.id
    )
  FROM public.scripts s
  JOIN public.characters c ON c.id = NEW.character_id
  JOIN public.users u ON u.id = NEW.actor_id
  WHERE s.id = NEW.script_id;
  RETURN NEW;
END;
$function$;

drop trigger if exists on_new_submission on public.submissions;
create trigger on_new_submission
  after insert on public.submissions
  for each row execute function public.notify_new_submission();

-- ── 2. Writer casts an actor → notify that actor ("Writer's Choice!") ──
CREATE OR REPLACE FUNCTION public.notify_writers_choice()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  IF NEW.is_writers_choice = true AND (OLD.is_writers_choice IS NULL OR OLD.is_writers_choice = false) THEN
    -- Get script title and character name
    INSERT INTO public.notifications (user_id, type, payload)
    SELECT
      NEW.actor_id,
      'writers_choice',
      jsonb_build_object(
        'title', 'Writer''s Choice!',
        'body', 'You were selected as Writer''s Choice for ' || c.name || ' in ' || s.title,
        'script_id', NEW.script_id,
        'character_id', NEW.character_id
      )
    FROM public.characters c
    JOIN public.scripts s ON s.id = c.script_id
    WHERE c.id = NEW.character_id;
  END IF;
  RETURN NEW;
END;
$function$;

drop trigger if exists on_writers_choice_notify on public.submissions;
create trigger on_writers_choice_notify
  after update on public.submissions
  for each row execute function public.notify_writers_choice();

-- ── 3. Audience vote → refresh favorite flag; milestone-notify the actor ──
CREATE OR REPLACE FUNCTION public.notify_audience_vote()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  -- Update audience_favorite if this submission has the most votes for its character
  UPDATE public.submissions s
  SET is_audience_favorite = (
    s.vote_count = (
      SELECT MAX(s2.vote_count) FROM public.submissions s2 WHERE s2.character_id = s.character_id
    )
    AND s.vote_count > 0
  )
  WHERE s.character_id = (SELECT character_id FROM public.submissions WHERE id = NEW.submission_id);

  -- Notify actor every 5 votes
  IF (SELECT vote_count FROM public.submissions WHERE id = NEW.submission_id) % 5 = 0 THEN
    INSERT INTO public.notifications (user_id, type, payload)
    SELECT
      sub.actor_id,
      'audience_vote',
      jsonb_build_object(
        'title', 'Audience Votes!',
        'body', 'Your submission has ' || sub.vote_count || ' votes!',
        'submission_id', NEW.submission_id
      )
    FROM public.submissions sub
    WHERE sub.id = NEW.submission_id;
  END IF;
  RETURN NEW;
END;
$function$;

drop trigger if exists on_audience_vote on public.votes;
create trigger on_audience_vote
  after insert on public.votes
  for each row execute function public.notify_audience_vote();

-- ── 4. Audience-favorite flag flips → keep the actor's profile count in sync ──
CREATE OR REPLACE FUNCTION public.update_audience_favorite_count()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  IF NEW.is_audience_favorite = true AND (OLD.is_audience_favorite IS NULL OR OLD.is_audience_favorite = false) THEN
    UPDATE public.users SET audience_favorite_count = audience_favorite_count + 1 WHERE id = NEW.actor_id;
  ELSIF OLD.is_audience_favorite = true AND NEW.is_audience_favorite = false THEN
    UPDATE public.users SET audience_favorite_count = GREATEST(audience_favorite_count - 1, 0) WHERE id = OLD.actor_id;
  END IF;
  RETURN NEW;
END;
$function$;

drop trigger if exists on_audience_favorite_change on public.submissions;
create trigger on_audience_favorite_change
  after update on public.submissions
  for each row execute function public.update_audience_favorite_count();
