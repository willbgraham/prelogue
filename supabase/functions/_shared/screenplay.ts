/**
 * Screenplay text → scenes / characters. Pure logic, no I/O and no Deno APIs,
 * so it runs the same in the edge functions and in a plain Node test.
 *
 * Two halves:
 *   1. linesFromItems  — rebuild one PDF page's text lines from pdf.js items
 *                        (used by extract-script-text, page by page).
 *   2. parseLines      — classify the whole document's lines into scenes,
 *                        dialogue, action… (used by parse-script).
 *
 * The split exists because text extraction is the CPU-heavy part and an edge
 * function gets 2 seconds of CPU. Extraction therefore runs in time-boxed
 * slices in its own function; classification is cheap and runs once at the end.
 */

export type ElementType = "character" | "dialogue" | "action" | "parenthetical";
export interface SceneElement {
  type: ElementType;
  character_name?: string;
  text: string;
}
export interface ParsedScene {
  heading: string;
  scene_index: number;
  elements: SceneElement[];
}
export interface Line {
  text: string;
  x: number;
}
export interface ParsedCharacter {
  name: string;
  description: string;
  lines: { scene_index: number; text: string }[];
  line_count: number;
}
export type IndentGrid = { actionX: number; dialogueX: number; cueX: number; tol: number };

const HEADING_RE = /^(INT\.|EXT\.|INT\.\/EXT\.|I\/E\.)/;
const TRANSITION_RE = /^(CUT TO|FADE|SMASH|DISSOLVE|MATCH CUT|HARD CUT|BACK TO|TITLE)/;
// Page numbers ("12." / "12") and continuation markers — layout artifacts, never content.
const ARTIFACT_RE = /^(\d{1,4}\.?|\(?(CONTINUED|MORE)\)?:?\.?)$/i;
const CUE_EXCLUDE_RE =
  /^(INT\.|EXT\.|CUT TO|FADE|SMASH|THE |BACK |SOUND|SUPER|CLOSE|ANGLE|CONT|END |TITLE|BEAT|NOW|LATER|MOMENTS?|CONTINUOUS|MEANWHILE|POV|INSERT|OMITTED)/;
// Cue shape: digits/&/# allowed after the first letter ("COP 2", "MAN #1"),
// up to three stacked extensions ("(O.S.) (CONT'D)"), curly apostrophes OK.
const CUE_RE = /^([A-Z][A-Z0-9\s.'’&#-]{0,30}?)(?:\s*\(.{1,24}\)){0,3}$/;
// Legacy (text-only fallback) cue shape — kept as-is for PDFs without geometry.
const LEGACY_CUE_RE =
  /^([A-Z][A-Z\s.'-]{1,28}?)(\s*\((?:V\.O\.|O\.S\.|CONT'D|RADIO|ON RADIO|O\.C\.)\s*\))?$/;
const ALL_CAPS_RE = /^[A-Z][A-Z\s.'-]+$/;

/**
 * Rebuild one page's text lines (with their left x-position) from pdf.js text
 * items. pdf.js hands back fragments — sometimes whole runs, sometimes one
 * glyph each (PDFs made with macOS "Print → Save as PDF") — so we join
 * fragments and break whenever `hasEOL` is set or the y-coordinate shifts.
 * Large vertical gaps become blank lines (block separators) so dialogue blocks
 * end correctly. Always ends with one blank line: the page boundary.
 */
// deno-lint-ignore no-explicit-any
export function linesFromItems(rawItems: any[]): Line[] {
  // deno-lint-ignore no-explicit-any
  const items = (rawItems as any[]).filter((it) => typeof it.str === "string");
  const out: Line[] = [];

  const pageLines: { text: string; y: number; x: number }[] = [];
  let cur = "";
  let curY: number | null = null;
  let curX: number | null = null;

  for (const it of items) {
    const y = Array.isArray(it.transform) ? (it.transform[5] as number) : null;
    const x = Array.isArray(it.transform) ? (it.transform[4] as number) : null;
    if (curY !== null && y !== null && Math.abs(y - curY) > 2) {
      pageLines.push({ text: cur, y: curY, x: curX ?? 0 });
      cur = "";
      curY = null;
      curX = null;
    }
    if (curY === null && y !== null) {
      curY = y;
      curX = x;
    }
    cur += it.str;
    if (it.hasEOL) {
      pageLines.push({ text: cur, y: curY ?? y ?? 0, x: curX ?? x ?? 0 });
      cur = "";
      curY = null;
      curX = null;
    }
  }
  if (cur) pageLines.push({ text: cur, y: curY ?? 0, x: curX ?? 0 });

  // Typical line gap (median) → anything notably larger is a blank line.
  const gaps: number[] = [];
  for (let i = 1; i < pageLines.length; i++) {
    const g = pageLines[i - 1].y - pageLines[i].y;
    if (g > 0) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 12;

  for (let i = 0; i < pageLines.length; i++) {
    if (i > 0) {
      const gap = pageLines[i - 1].y - pageLines[i].y;
      if (gap > typical * 1.6) out.push({ text: "", x: 0 });
    }
    out.push({ text: pageLines[i].text, x: pageLines[i].x });
  }
  out.push({ text: "", x: 0 }); // page boundary
  return out;
}

/**
 * How many readable elements a stored parse holds (pass scripts.parsed_json's
 * `scenes`). Zero means there is nothing to voice, unlock or export — a scan
 * that slipped through before scans were refused, or a parse that never ran.
 */
export function countElements(scenes: unknown): number {
  if (!Array.isArray(scenes)) return 0;
  let n = 0;
  for (const s of scenes) {
    const els = (s as { elements?: unknown } | null)?.elements;
    if (Array.isArray(els)) n += els.length;
  }
  return n;
}

/** Letters, digits and punctuation on a set of lines — whitespace doesn't count. */
export function inkChars(lines: Line[]): number {
  let n = 0;
  for (const l of lines) n += l.text.replace(/\s+/g, "").length;
  return n;
}

/**
 * Infer the document's indent grid. Standard screenplay format encodes element
 * type in indentation: action at the left margin, dialogue ~1" deeper, cues
 * deeper still. When these three columns are detectable we classify by
 * position (far more reliable than text shape); otherwise return null and the
 * caller falls back to the legacy text-only heuristics.
 */
export function inferIndents(lines: Line[]): IndentGrid | null {
  const buckets = new Map<number, { n: number; cueish: number }>();
  for (const l of lines) {
    const t = l.text.trim();
    if (!t || ARTIFACT_RE.test(t)) continue;
    const x = Math.round(l.x / 4) * 4;
    if (!buckets.has(x)) buckets.set(x, { n: 0, cueish: 0 });
    const b = buckets.get(x)!;
    b.n++;
    if (CUE_RE.test(t) && t.length <= 34 && !CUE_EXCLUDE_RE.test(t)) b.cueish++;
  }
  const sig = [...buckets.entries()].filter(([, b]) => b.n >= 8);
  if (sig.length < 3) return null;
  sig.sort((a, b) => a[0] - b[0]);
  const actionX = sig[0][0];
  const cueCand = sig
    .filter(([x, b]) => x > actionX + 48 && b.cueish / b.n > 0.6)
    .sort((a, b) => b[1].n - a[1].n)[0];
  if (!cueCand) return null;
  const cueX = cueCand[0];
  const diaCand = sig
    .filter(([x]) => x > actionX + 24 && x < cueX - 24)
    .sort((a, b) => b[1].n - a[1].n)[0];
  if (!diaCand) return null;
  return { actionX, dialogueX: diaCand[0], cueX, tol: 14 };
}

/** Indent-aware classification (used when the PDF's geometry is clean). */
export function classifyGeometric(lines: Line[], grid: IndentGrid): ParsedScene[] {
  const { dialogueX, cueX, tol } = grid;
  const near = (x: number, target: number) => Math.abs(x - target) <= tol;
  const scenes: ParsedScene[] = [];
  let current: ParsedScene = { heading: "", scene_index: 0, elements: [] };
  scenes.push(current);
  let currentChar: string | null = null;

  // Title page ends at the first real screenplay content — a slugline, FADE
  // IN, or a character cue at the cue indent (cold opens can precede sluglines).
  const contentStart = lines.findIndex((l) => {
    const t = l.text.trim();
    if (HEADING_RE.test(t) || /^FADE IN/.test(t)) return true;
    return l.x >= cueX - tol && CUE_RE.test(t) && t.length <= 40 && !CUE_EXCLUDE_RE.test(t);
  });

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.text.trim();
    if (!line) continue;
    if (ARTIFACT_RE.test(line)) continue; // page numbers, (CONTINUED), (MORE)
    if (contentStart >= 0 && i < contentStart) continue; // title page
    // A page number occasionally glues onto the next line's text when a PDF
    // item carries no transform; strip a leading "NN. " header artifact.
    const deglued = line.replace(/^\d{1,3}\.\s+(?=[A-Z"'(])/, "");
    const clean = deglued.length >= 2 ? deglued : line;

    if (HEADING_RE.test(line)) {
      current = { heading: line, scene_index: scenes.length, elements: [] };
      scenes.push(current);
      currentChar = null;
      continue;
    }
    if (TRANSITION_RE.test(line) && !near(raw.x, dialogueX)) {
      currentChar = null;
      continue;
    }

    // Character cue: cue indent + cue shape. No repeat-count requirement —
    // the indent is strong evidence, so one-scene characters register too.
    if (raw.x >= cueX - tol && clean.length <= 40) {
      const m = clean.match(CUE_RE);
      if (m && !CUE_EXCLUDE_RE.test(m[1].trim()) && !/^\d/.test(m[1].trim()) && m[1].trim().length >= 2) {
        currentChar = m[1].trim();
        current.elements.push({ type: "character", character_name: currentChar, text: currentChar });
        continue;
      }
    }
    // Parenthetical: starts with ( at dialogue-or-deeper indent.
    if (clean.startsWith("(") && raw.x > dialogueX - tol && currentChar) {
      current.elements.push({ type: "parenthetical", character_name: currentChar, text: clean });
      continue;
    }
    // Dialogue: dialogue indent with a live speaker. Page breaks don't end the
    // block — artifacts/blanks are skipped, the indent carries the attribution.
    if (near(raw.x, dialogueX) && currentChar) {
      current.elements.push({ type: "dialogue", character_name: currentChar, text: clean });
      continue;
    }
    // Everything else is action; action ends any dialogue block.
    currentChar = null;
    current.elements.push({ type: "action", text: clean });
  }
  return scenes;
}

/** Legacy text-only classification (fallback for PDFs without usable geometry). */
export function classifyLegacy(lines: Line[]): ParsedScene[] {
  const texts = lines.map((l) => l.text);
  const potentialChars = new Map<string, number>();
  for (let i = 0; i < texts.length; i++) {
    const line = texts[i].trim();
    const match = line.match(LEGACY_CUE_RE);
    if (!match) continue;
    const name = match[1].trim();
    if (name.length < 2 || CUE_EXCLUDE_RE.test(name) || /^\d/.test(name)) continue;
    let nextLine = "";
    for (let j = i + 1; j < Math.min(i + 4, texts.length); j++) {
      nextLine = texts[j].trim();
      if (nextLine) break;
    }
    if (nextLine && !/^(INT\.|EXT\.)/.test(nextLine)) {
      potentialChars.set(name, (potentialChars.get(name) || 0) + 1);
    }
  }
  const confirmedChars = new Set<string>();
  for (const [name, count] of potentialChars) {
    if (count >= 2) confirmedChars.add(name);
  }

  const scenes: ParsedScene[] = [];
  let current: ParsedScene = { heading: "", scene_index: 0, elements: [] };
  scenes.push(current);
  let currentChar: string | null = null;
  let inDialogue = false;
  let dialogueCount = 0;

  for (let i = 0; i < texts.length; i++) {
    const line = texts[i].trim();

    if (HEADING_RE.test(line)) {
      current = { heading: line, scene_index: scenes.length, elements: [] };
      scenes.push(current);
      currentChar = null;
      inDialogue = false;
      continue;
    }
    if (!line) {
      if (inDialogue && dialogueCount > 0) {
        inDialogue = false;
        currentChar = null;
      }
      continue;
    }
    if (ARTIFACT_RE.test(line)) continue; // page numbers etc. — never content
    if (TRANSITION_RE.test(line)) {
      inDialogue = false;
      currentChar = null;
      continue;
    }

    const cue = line.match(LEGACY_CUE_RE);
    if (cue && confirmedChars.has(cue[1].trim())) {
      currentChar = cue[1].trim();
      inDialogue = true;
      dialogueCount = 0;
      current.elements.push({ type: "character", character_name: currentChar, text: currentChar });
      continue;
    }

    if (inDialogue && currentChar) {
      if (line.startsWith("(")) {
        current.elements.push({ type: "parenthetical", character_name: currentChar, text: line });
        continue;
      }
      if (ALL_CAPS_RE.test(line)) {
        inDialogue = false;
        currentChar = null;
        current.elements.push({ type: "action", text: line });
        continue;
      }
      current.elements.push({ type: "dialogue", character_name: currentChar, text: line });
      dialogueCount++;
      continue;
    }

    current.elements.push({ type: "action", text: line });
  }
  return scenes;
}

export interface ParseResult {
  mode: "geometric" | "legacy";
  grid: IndentGrid | null;
  scenes: ParsedScene[];
  /** Every speaking character, most lines first. */
  characters: ParsedCharacter[];
  totalElements: number;
  counts: Record<ElementType, number>;
}

/** Classify a whole document's lines into the shape stored in scripts.parsed_json. */
export function parseLines(lines: Line[]): ParseResult {
  // Prefer indent-aware classification (standard screenplay format encodes
  // element type in indentation); fall back to text heuristics otherwise.
  const grid = inferIndents(lines);
  const mode = grid ? "geometric" : "legacy";
  const scenes = grid ? classifyGeometric(lines, grid) : classifyLegacy(lines);

  // Per-character dialogue index (built uniformly from the classified stream).
  const charDialogue: Record<string, { scene_index: number; text: string }[]> = {};
  const charLineCount: Record<string, number> = {};
  for (const scene of scenes) {
    for (const el of scene.elements) {
      if (el.type !== "dialogue" || !el.character_name) continue;
      charLineCount[el.character_name] = (charLineCount[el.character_name] || 0) + 1;
      (charDialogue[el.character_name] ??= []).push({
        scene_index: scene.scene_index,
        text: el.text,
      });
    }
  }

  // Merge consecutive same-speaker lines into one chunk so the narrator (and
  // each character) reads a continuous block instead of pausing/hard-cutting
  // on every wrapped line. Capped so a single TTS stays reasonable.
  const MERGE_CAP = 2500;
  for (const scene of scenes) {
    const merged: SceneElement[] = [];
    for (const el of scene.elements) {
      const last = merged[merged.length - 1];
      const sameRun =
        !!last &&
        last.type === el.type &&
        (el.type === "action" ||
          (el.type === "dialogue" && last.character_name === el.character_name));
      if (sameRun && last!.text.length + el.text.length + 1 <= MERGE_CAP) {
        last!.text = `${last!.text} ${el.text}`;
      } else {
        merged.push({ ...el });
      }
    }
    scene.elements = merged;
  }

  const counts: Record<ElementType, number> = { dialogue: 0, action: 0, character: 0, parenthetical: 0 };
  let totalElements = 0;
  for (const s of scenes) {
    for (const el of s.elements) {
      counts[el.type] = (counts[el.type] || 0) + 1;
      totalElements++;
    }
  }

  const characters: ParsedCharacter[] = Object.entries(charLineCount)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({
      name,
      description: "",
      lines: charDialogue[name] || [],
      line_count: count,
    }));

  return { mode, grid, scenes, characters, totalElements, counts };
}
