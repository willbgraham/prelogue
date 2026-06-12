-- Per-script TTS voice configuration for the "Read for this role" AI voices.
-- Shape (character keys are UPPER-CASED to match the parser's character names):
--   {
--     "mode": "per_character" | "single",
--     "single_voice_id": "<elevenlabs voice id | null>",
--     "narrator_voice_id": "<elevenlabs voice id>",   -- reads action / stage directions
--     "characters": { "CAGE": "<voiceId>", "RITA": "<voiceId>" },
--     "updated_at": "<iso8601>"
--   }
-- The existing RLS policy "Writers can update own scripts" (auth.uid() = writer_id)
-- already lets the script owner set this directly from the client; no new policy needed.
alter table public.scripts
  add column if not exists voice_config jsonb;
