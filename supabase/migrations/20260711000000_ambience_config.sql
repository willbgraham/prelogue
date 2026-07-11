-- Scene background music / ambience (ElevenLabs Music + Sound Effects).
-- Per-scene generated beds live in the private `scripts` bucket under
-- ambience/{script_id}/…; this column holds the writer's config (which scene
-- plays what, master enable, volume). Kept OUT of voice_config: the voice
-- picker rebuilds that JSON from known keys on apply, and voice generation
-- hashes/overrides shouldn't involve ambience at all.
--
-- No new RLS needed: "Writers can update own scripts" covers writer saves,
-- and the public script SELECT policies expose the column for playback.

alter table public.scripts add column if not exists ambience_config jsonb;
