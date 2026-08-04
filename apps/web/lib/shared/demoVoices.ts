/**
 * Voices an ANONYMOUS demo visitor may actually apply.
 *
 * The demo is deliberately open — anyone can re-cast it — but every *new*
 * (voice, line) pair costs ElevenLabs credits, and the ads point straight at
 * it. These voices are pre-generated for the demo script, so picking one is a
 * cache hit and costs nothing, no matter how much demo traffic arrives.
 *
 * The picker still SHOWS the whole 900+ library (that's the pitch); the rest
 * are locked with a nudge to sign up. Signed-in writers get everything on
 * their own scripts.
 *
 * KEEP IN SYNC with the copies in supabase/functions/generate-voice-cues and
 * preview-voice-line, which enforce this server-side (a client-side lock is
 * trivially bypassed).
 */
export const DEMO_VOICE_ALLOWLIST: string[] = [
  // Booth Nine's own cast + narrator (the default read everyone hears).
  "yRkCcID7C7SG09Wb6tIg", // narrator
  "4YWIJNXODjo9x7Nz4BhO", // VERA
  "SOYHLrjzK2X1ezoPC6cr", // DANNY
  "jmovCppyUT0hdwQb6rmj", // MARISOL
  // Curated alternates, pre-warmed so swaps are free.
  "vOIRno85PgKv4YKFyUlz", // Mike — warm, neutral
  "hLygPNd2gK6Azddorc5W", // Alex — warm conversational
  "VC6vCXhVaI8BZefRtXZV", // Malcolm Gooding — cinematic gravitas
  "MDrnb4sU30RxVQwLWmU3", // Michael — confident storyteller
  "H7Fc5Qy614JJMoitlc8A", // Doug
  "eR8vsPZKHCfpn1pfTMTZ", // Anthony
  "TAXL9Duy50pxAXIMCYbu", // Hanna — calm, British
  "Q86KUByuoHsuv9sOa4NX", // Maria Oren
  "UrdIUsVuyr5QSUJdS5hu", // Katie — girl next door
  "d8WcCpplp8meHt10UhL8", // Emily — bright & energetic
  "6de0u4cGYWDeBlsfrX39", // Kathryn — warm & strong
  "QyCGbzzEtSqHWJ8rNRMK", // Alexandria — documentary
];

export const isDemoVoiceAllowed = (id?: string | null) =>
  !!id && DEMO_VOICE_ALLOWLIST.includes(id);
