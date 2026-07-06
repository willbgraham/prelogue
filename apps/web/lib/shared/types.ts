// Shared data contracts — ported from the mobile app's lib/types.ts (pure TS,
// no React Native deps). This is the canonical copy the web app imports; the
// mobile app keeps its own copy for now (TODO: dedupe mobile onto this package).

export type UserRole = "writer" | "actor" | "audience";
export type ScriptStatus = "open" | "casting" | "assembled" | "published";
export type ScriptVisibility = "public" | "hidden" | "private";

export interface User {
  id: string;
  role: UserRole | null;
  roles: UserRole[] | null;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  genre_specialties: string[] | null;
  writers_choice_count: number;
  audience_favorite_count: number;
  created_at: string;
}

export interface Script {
  id: string;
  slug?: string | null;
  writer_id: string;
  title: string;
  genre: string;
  logline: string;
  file_url: string;
  parsed_json: ParsedScript | null;
  voice_config: VoiceConfig | null;
  status: ScriptStatus;
  visibility?: ScriptVisibility;
  full_read_unlocked?: boolean;
  unlocked_at?: string | null;
  cover_image_url?: string | null;
  synopsis?: string | null;
  more_details?: string | null;
  /** Sale/availability status — see LISTING_STATUSES (distinct from `status`). */
  listing_status?: string | null;
  /** Feature | tv_pilot | web_series | short | episode — see FORMATS. */
  format?: string | null;
  page_count?: number | null;
  /** everyone | 13 | 17 — see AGE_RATINGS. */
  age_rating?: string | null;
  submission_deadline: string;
  created_at: string;
  // Joined
  writer?: User;
  characters?: Character[];
}

/** Writer-chosen TTS voices for a script. Character keys are UPPER-CASED. */
export interface VoiceConfig {
  mode: "per_character" | "single";
  single_voice_id?: string | null;
  narrator_voice_id?: string | null;
  characters?: Record<string, string>;
  updated_at?: string;
}

/** A voice option from the ElevenLabs catalog (via the list-voices function). */
export interface VoiceCatalogItem {
  voice_id: string;
  name: string;
  category: string | null;
  labels: Record<string, string>;
  preview_url: string | null;
  /** Present only for shared-library voices that must be added before use. */
  public_owner_id?: string | null;
}

export interface ParsedScript {
  scenes: ParsedScene[];
  characters: ParsedCharacter[];
}

export interface ParsedScene {
  heading: string;
  scene_index: number;
  elements: SceneElement[];
}

export interface SceneElement {
  type: "character" | "dialogue" | "action" | "parenthetical";
  character_name?: string;
  text: string;
}

export interface ParsedCharacter {
  name: string;
  description: string;
  lines: { scene_index: number; text: string }[];
  line_count: number;
}

export interface Character {
  id: string;
  script_id: string;
  name: string;
  description: string | null;
  line_count: number;
  // Joined
  script?: Script;
  submissions?: Submission[];
}

/** One clip of a per-line submission. */
export interface SubmissionClip {
  /** Global index in the script's flattened scenes[].elements[] stream. */
  element_index: number;
  /** Storage path in the private `submissions` bucket. */
  clip_url: string;
}

export interface Submission {
  id: string;
  actor_id: string;
  character_id: string;
  script_id: string;
  /** Legacy single continuous take. Null for per-line clip submissions. */
  video_url: string | null;
  /** Per-line clips (ordered by element_index). Null for legacy single-video takes. */
  clips: SubmissionClip[] | null;
  take_number: number;
  is_writers_choice: boolean;
  is_audience_favorite: boolean;
  chosen_count?: number;
  is_preferred_take?: boolean;
  vote_count: number;
  created_at: string;
  // Joined
  actor?: User;
  character?: Character;
}
