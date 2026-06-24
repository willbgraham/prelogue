import { describe, it, expect } from "vitest";
import { buildRows } from "./buildRows";
import type { ParsedScript } from "./types";

// Booth Nine's element sequence (mirrors supabase/seed/booth-nine-demo.sql).
// 20 elements; the 12 voiced ones (dialogue + action) must land on exactly
// these global indices so the web rows align with generate-voice-cues' manifest.
const boothNine: ParsedScript = {
  scenes: [
    {
      heading: "INT. THE BLUE HOUR DINER - 2:14 A.M.",
      scene_index: 0,
      elements: [
        { type: "action", text: "Rain needles the window..." }, // 0
        { type: "character", character_name: "DANNY", text: "DANNY" }, // 1
        { type: "dialogue", character_name: "DANNY", text: "I want out." }, // 2
        { type: "character", character_name: "VERA", text: "VERA" }, // 3
        { type: "dialogue", character_name: "VERA", text: "Mm. And people in hell want ice water." }, // 4
        { type: "character", character_name: "DANNY", text: "DANNY" }, // 5
        { type: "dialogue", character_name: "DANNY", text: "I'll pay it back. All of it." }, // 6
        { type: "character", character_name: "VERA", text: "VERA" }, // 7
        { type: "dialogue", character_name: "VERA", text: "You signed, Danny." }, // 8
        { type: "action", text: "MARISOL appears with a coffee pot." }, // 9
        { type: "character", character_name: "MARISOL", text: "MARISOL" }, // 10
        { type: "dialogue", character_name: "MARISOL", text: "Freshen that up, sweetheart?" }, // 11
        { type: "character", character_name: "VERA", text: "VERA" }, // 12
        { type: "dialogue", character_name: "VERA", text: "Please. He's buying." }, // 13
        { type: "action", text: "Vera slides a single brass key across the table." }, // 14
        { type: "character", character_name: "VERA", text: "VERA" }, // 15
        { type: "dialogue", character_name: "VERA", text: "Booth nine. Midnight tomorrow." }, // 16
        { type: "action", text: "She stands and walks out into the rain." }, // 17
        { type: "character", character_name: "DANNY", text: "DANNY" }, // 18
        { type: "dialogue", character_name: "DANNY", text: "...That's not a booth number." }, // 19
      ],
    },
  ],
  characters: [],
};

const VOICED_INDICES = [0, 2, 4, 6, 8, 9, 11, 13, 14, 16, 17, 19];
const ACTION_INDICES = [0, 9, 14, 17];

describe("buildRows element-index alignment (Booth Nine)", () => {
  it("player view: emits exactly the 12 voiced elements on the right indices", () => {
    const rows = buildRows(boothNine);
    expect(rows.map((r) => r.elementIndex)).toEqual(VOICED_INDICES);
    // character/parenthetical never produce rows
    expect(rows).toHaveLength(12);
    // action → narrator; dialogue → line (no actorName)
    for (const r of rows) {
      const expected = ACTION_INDICES.includes(r.elementIndex) ? "narrator" : "line";
      expect(r.kind).toBe(expected);
    }
  });

  it("attaches the scene heading to the first renderable element only", () => {
    const rows = buildRows(boothNine);
    expect(rows[0].sceneHeading).toBe("INT. THE BLUE HOUR DINER - 2:14 A.M.");
    expect(rows.slice(1).every((r) => r.sceneHeading === undefined)).toBe(true);
  });

  it("recorder view: tags the actor's dialogue vs cue vs narrator, same indices", () => {
    const rows = buildRows(boothNine, { actorName: "Danny" }); // case-insensitive
    expect(rows.map((r) => r.elementIndex)).toEqual(VOICED_INDICES);
    const byIdx = Object.fromEntries(rows.map((r) => [r.elementIndex, r.kind]));
    expect(byIdx[2]).toBe("actor"); // DANNY
    expect(byIdx[6]).toBe("actor");
    expect(byIdx[19]).toBe("actor");
    expect(byIdx[4]).toBe("cue"); // VERA
    expect(byIdx[11]).toBe("cue"); // MARISOL
    expect(byIdx[9]).toBe("narrator"); // action
  });

  it("returns [] for empty/missing parsed scripts", () => {
    expect(buildRows(null)).toEqual([]);
    expect(buildRows({ scenes: [], characters: [] })).toEqual([]);
  });
});
