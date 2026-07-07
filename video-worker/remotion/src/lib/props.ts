import type { RowKind } from "./buildRows";

// One audible/visual unit in the render timeline. Fully resolved by the worker
// (signed URLs + frame numbers) so the composition needs no network/Supabase.
export type MediaRef =
  | { kind: "audio"; src: string; volume: number }
  | { kind: "video"; src: string; trimStartSec: number; trimEndSec: number; volume: number }
  | null; // silent line (no cue, no clip) — still typed out over a fixed hold

export interface Segment {
  elementIndex: number;
  startFrame: number;
  durationFrames: number;
  kind: RowKind;
  character?: string;
  text: string;
  sceneHeading?: string;
  media: MediaRef;
}

export interface DailySceneProps {
  fps: number;
  variant: "ai" | "composite";
  script: { id: string; title: string };
  // Every renderable row is a segment (buildRows order); segments ARE the script.
  segments: Segment[];
}
