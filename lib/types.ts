export type UserRole = "writer" | "actor" | "audience";

export type ScriptStatus = "open" | "casting" | "assembled" | "published";

export type AssemblyStatus = "processing" | "ready" | "failed";

export type NotificationType =
  | "new_script"
  | "new_submission"
  | "writers_choice"
  | "assembly_ready"
  | "audience_vote"
  | "new_comment";

export interface User {
  id: string;
  /** The user's currently active role (drives all role-gated UI). */
  role: UserRole | null;
  /** All roles the user has; they can switch their active `role` among these. */
  roles: UserRole[] | null;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  /** URL handle for the public profile (/u/{username}). */
  username?: string | null;
  website?: string | null;
  /** Social links keyed by platform: { x, instagram, tiktok, youtube }. */
  links?: Record<string, string> | null;
  genre_specialties: string[] | null;
  writers_choice_count: number;
  audience_favorite_count: number;
  /** Billing: 'free' (preview only) or 'pro' (full AI voicing). */
  plan?: "free" | "pro" | string;
  /** Stripe subscription status: active | trialing | past_due | canceled | ... */
  plan_status?: string | null;
  plan_renews_at?: string | null;
  created_at: string;
}

/** True when the writer's plan unlocks full AI-voice generation. */
export function hasFullVoiceAccess(user?: Pick<User, "plan" | "plan_status"> | null): boolean {
  if (!user) return false;
  return (
    user.plan === "pro" ||
    user.plan_status === "active" ||
    user.plan_status === "trialing"
  );
}

export interface Script {
  id: string;
  writer_id: string;
  title: string;
  genre: string;
  logline: string;
  file_url: string;
  parsed_json: ParsedScript | null;
  voice_config: VoiceConfig | null;
  status: ScriptStatus;
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

/** One gap-free clip of a per-line submission. */
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
  vote_count: number;
  created_at: string;
  // Joined
  actor?: User;
  character?: Character;
}

export interface AssembledRead {
  id: string;
  script_id: string;
  video_url: string | null;
  youtube_url: string | null;
  view_count: number;
  status: AssemblyStatus;
  created_at: string;
  // Joined
  script?: Script;
}

export interface Vote {
  id: string;
  user_id: string;
  submission_id: string;
  created_at: string;
}

export interface Comment {
  id: string;
  user_id: string;
  assembled_read_id: string;
  scene_index: number | null;
  body: string;
  created_at: string;
  // Joined
  user?: User;
}

export interface Notification {
  id: string;
  user_id: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  read: boolean;
  created_at: string;
}
