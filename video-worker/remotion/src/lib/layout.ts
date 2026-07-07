import { measureText } from "@remotion/layout-utils";
import { MONO } from "../fonts";
import type { Segment } from "./props";

// Deterministic pre-measure of the scrolling script. Each row is absolutely
// positioned at a computed `top`, so headless Chrome can't reflow it mid-render
// (which would desync the scroll). Courier is monospace, so wrapped-line counts
// from measureText are predictable; a small slack keeps containers ≥ the paint.
export const PAD_X = 90;
export const CONTENT_W = 1080 - PAD_X * 2; // 900
export const FONT_SIZE = 30;
export const LINE_H = 44;
export const LABEL_H = 40;
export const HEADING_H = 46;
export const ROW_GAP = 30;
export const ROW_PAD_TOP = 8;

function wrappedLines(text: string): number {
  const t = (text || "").trim();
  if (!t) return 1;
  const { width } = measureText({ text: t, fontFamily: MONO, fontSize: FONT_SIZE });
  return Math.max(1, Math.ceil(width / (CONTENT_W * 0.9)));
}

export interface RowLayout {
  top: number;
  height: number;
  hasHeading: boolean;
  hasLabel: boolean;
}

export function computeLayout(segments: Segment[]): { rows: RowLayout[]; total: number } {
  const rows: RowLayout[] = [];
  let top = 0;
  for (const s of segments) {
    const hasHeading = !!s.sceneHeading; // buildRows already attaches once per scene
    const hasLabel = s.kind !== "narrator" && !!s.character;
    const textLines = wrappedLines(s.text);
    const height =
      ROW_PAD_TOP + (hasHeading ? HEADING_H : 0) + (hasLabel ? LABEL_H : 0) + textLines * LINE_H;
    rows.push({ top, height, hasHeading, hasLabel });
    top += height + ROW_GAP;
  }
  return { rows, total: top };
}
