-- Demo script: "Booth Nine" — an original opening scene (we own it outright, so
-- zero copyright / App Store risk). Seeds it as a PUBLIC, already-UNLOCKED demo
-- so anyone browsing can hear the AI voices perform it.
--
-- Run in the Supabase SQL editor (project musxcjuginhergnzikht). Safe to re-run —
-- it deletes the prior demo rows first (fixed id). Voices are pre-cast from the
-- ElevenLabs premade library; a writer can re-cast them in the casting dashboard.

delete from public.characters where script_id = 'b0078900-0000-4000-8000-000000000009';
delete from public.scripts    where id        = 'b0078900-0000-4000-8000-000000000009';

insert into public.scripts
  (id, writer_id, title, genre, logline, file_url, status, submission_deadline, visibility, full_read_unlocked, unlocked_at, voice_config, parsed_json)
values (
  'b0078900-0000-4000-8000-000000000009',
  (select id from auth.users where lower(email) = 'willg1@gmail.com'),
  'Booth Nine',
  'Thriller',
  'A man who signed the wrong contract has one night to get out of it.',
  'demo/booth-nine.pdf',
  'open',
  '2099-12-31',
  'public',
  true,
  now(),
  $vc$ {
    "mode": "per_character",
    "narrator_voice_id": "nPczCjzI2devNBz1zQrb",
    "single_voice_id": null,
    "characters": {
      "DANNY": "guZ5txGiatiDmC3jrjOO",
      "VERA": "yAzQgxpUXjWpNLJtO3yf",
      "MARISOL": "Xjf4ERpibIUB0qlQbAA7"
    }
  } $vc$::jsonb,
  $pj$ {
    "scenes": [
      {
        "heading": "INT. THE BLUE HOUR DINER - 2:14 A.M.",
        "scene_index": 0,
        "elements": [
          {"type":"action","text":"Rain needles the window. A neon sign stutters pink across empty booths. DANNY (28, wired, three coffees deep) sits across from VERA (40s, unhurried — the calm of someone who has never once been late)."},
          {"type":"character","character_name":"DANNY","text":"DANNY"},
          {"type":"dialogue","character_name":"DANNY","text":"I want out."},
          {"type":"character","character_name":"VERA","text":"VERA"},
          {"type":"dialogue","character_name":"VERA","text":"Mm. And people in hell want ice water."},
          {"type":"character","character_name":"DANNY","text":"DANNY"},
          {"type":"dialogue","character_name":"DANNY","text":"I'll pay it back. All of it. Just — not this. Not tonight."},
          {"type":"character","character_name":"VERA","text":"VERA"},
          {"type":"dialogue","character_name":"VERA","text":"You signed, Danny. You even initialed the part that said \"no.\""},
          {"type":"action","text":"MARISOL (60s, warm, gloriously unaware) appears with a coffee pot."},
          {"type":"character","character_name":"MARISOL","text":"MARISOL"},
          {"type":"dialogue","character_name":"MARISOL","text":"Freshen that up, sweetheart?"},
          {"type":"character","character_name":"VERA","text":"VERA"},
          {"type":"dialogue","character_name":"VERA","text":"Please. He's buying."},
          {"type":"action","text":"Vera slides a single brass key across the table. Danny doesn't touch it."},
          {"type":"character","character_name":"VERA","text":"VERA"},
          {"type":"dialogue","character_name":"VERA","text":"Booth nine. Midnight tomorrow. Don't be early."},
          {"type":"action","text":"She stands, tucks a folded bill under his cup, and walks out into the rain. The bell over the door goes quiet. Danny finally picks up the key — and reads what's stamped on it."},
          {"type":"character","character_name":"DANNY","text":"DANNY"},
          {"type":"dialogue","character_name":"DANNY","text":"...That's not a booth number."}
        ]
      }
    ],
    "characters": [
      {"name":"VERA","description":"","lines":[],"line_count":4},
      {"name":"DANNY","description":"","lines":[],"line_count":3},
      {"name":"MARISOL","description":"","lines":[],"line_count":1}
    ]
  } $pj$::jsonb
);

insert into public.characters (script_id, name, description, line_count) values
  ('b0078900-0000-4000-8000-000000000009', 'VERA',    null, 4),
  ('b0078900-0000-4000-8000-000000000009', 'DANNY',   null, 3),
  ('b0078900-0000-4000-8000-000000000009', 'MARISOL', null, 1);
