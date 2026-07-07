// Minimal parsed-script shape needed by buildRows — copied from
// apps/web/lib/shared/types.ts. Kept in lockstep so the Remotion render walks
// elements with the SAME global indexing as generate-voice-cues / the manifest.

export interface SceneElement {
  type: "character" | "dialogue" | "action" | "parenthetical";
  character_name?: string;
  text: string;
}

export interface ParsedScene {
  heading: string;
  scene_index: number;
  elements: SceneElement[];
}

export interface ParsedScript {
  scenes: ParsedScene[];
  characters?: unknown[];
}
