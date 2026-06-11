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
  role: UserRole | null;
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
  writer_id: string;
  title: string;
  genre: string;
  logline: string;
  file_url: string;
  parsed_json: ParsedScript | null;
  status: ScriptStatus;
  submission_deadline: string;
  created_at: string;
  // Joined
  writer?: User;
  characters?: Character[];
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

export interface Submission {
  id: string;
  actor_id: string;
  character_id: string;
  script_id: string;
  video_url: string;
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
