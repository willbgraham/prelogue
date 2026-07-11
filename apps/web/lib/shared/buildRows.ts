import type { ParsedScript } from "./types";

export type RowKind = "actor" | "cue" | "narrator" | "line";

export interface ScriptRow {
  /**
   * Global index in the flattened scenes[].elements[] stream. EVERY element
   * (incl. character/parenthetical) consumes an index so this stays aligned
   * with the server's `generate-voice-cues` numbering and the voice manifest's
   * `element_index`. Only `dialogue` + `action` become rows (and audio).
   */
  elementIndex: number;
  /** 0-based index of the scene this row belongs to (ambience keys off it). */
  sceneIndex: number;
  kind: RowKind;
  character?: string;
  text: string;
  sceneHeading?: string;
}

/**
 * Flatten a parsed script into ordered rows — the single source of truth shared
 * by the web player and recorder (replaces the duplicated `buildRows` in the two
 * mobile screens). Indexing MUST match the edge function exactly:
 *  - walk scenes in order, every element increments the global index;
 *  - emit a row only for `dialogue` and `action`;
 *  - `character`/`parenthetical` are skipped but still consume an index;
 *  - a scene heading attaches to the first *renderable* element of that scene.
 *
 * `opts.actorName` selects the recorder view: that actor's dialogue → "actor",
 * other dialogue → "cue". Omit it for the player view: all dialogue → "line".
 * Action is always "narrator".
 */
export function buildRows(
  parsed: ParsedScript | null | undefined,
  opts: { actorName?: string } = {}
): ScriptRow[] {
  if (!parsed?.scenes) return [];
  const actorUpper = opts.actorName ? opts.actorName.toUpperCase() : null;
  const rows: ScriptRow[] = [];
  let globalIdx = 0;
  let sceneIdx = -1;

  for (const scene of parsed.scenes) {
    sceneIdx++;
    const heading = scene.heading?.trim();
    let headingPending = !!heading;
    for (const el of scene.elements ?? []) {
      const idx = globalIdx++;
      const renderable = el.type === "dialogue" || el.type === "action";
      let rowHeading: string | undefined;
      if (headingPending && renderable) {
        rowHeading = heading;
        headingPending = false;
      }

      if (el.type === "dialogue") {
        const kind: RowKind = actorUpper
          ? (el.character_name || "").toUpperCase() === actorUpper
            ? "actor"
            : "cue"
          : "line";
        rows.push({
          elementIndex: idx,
          sceneIndex: sceneIdx,
          kind,
          character: el.character_name,
          text: el.text,
          sceneHeading: rowHeading,
        });
      } else if (el.type === "action") {
        rows.push({
          elementIndex: idx,
          sceneIndex: sceneIdx,
          kind: "narrator",
          text: el.text,
          sceneHeading: rowHeading,
        });
      }
      // character / parenthetical: index consumed, no row (matches the server).
    }
  }
  return rows;
}
