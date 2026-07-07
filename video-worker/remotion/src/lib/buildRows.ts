import type { ParsedScript } from "./types";

// VERBATIM copy of apps/web/lib/shared/buildRows.ts — the global element indexing
// MUST match generate-voice-cues + the voice-cue manifest, or audio/clips
// misalign in the render. Do not "improve" it; keep it in sync with the source.

export type RowKind = "actor" | "cue" | "narrator" | "line";

export interface ScriptRow {
  /**
   * Global index in the flattened scenes[].elements[] stream. EVERY element
   * (incl. character/parenthetical) consumes an index so this stays aligned
   * with the server's `generate-voice-cues` numbering and the voice manifest's
   * `element_index`. Only `dialogue` + `action` become rows (and audio).
   */
  elementIndex: number;
  kind: RowKind;
  character?: string;
  text: string;
  sceneHeading?: string;
}

export function buildRows(
  parsed: ParsedScript | null | undefined,
  opts: { actorName?: string } = {}
): ScriptRow[] {
  if (!parsed?.scenes) return [];
  const actorUpper = opts.actorName ? opts.actorName.toUpperCase() : null;
  const rows: ScriptRow[] = [];
  let globalIdx = 0;

  for (const scene of parsed.scenes) {
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
          kind,
          character: el.character_name,
          text: el.text,
          sceneHeading: rowHeading,
        });
      } else if (el.type === "action") {
        rows.push({ elementIndex: idx, kind: "narrator", text: el.text, sceneHeading: rowHeading });
      }
      // character / parenthetical: index consumed, no row (matches the server).
    }
  }
  return rows;
}
