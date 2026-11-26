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
  /**
   * Set on the line (or lines side by side) that sit highest or lowest on a
   * page: the page's number, negative for the lowest. This is where a running
   * head or foot lives; see dropRunningHeads.
   */
  edge?: number;
  /**
   * How far down the page this line sits from the line above it, in points.
   * Unset on a page's first line, on blank separators, and on lines that did
   * not come from a page (pasted text, a scan). It is what tells a wrapped
   * line from the start of a new paragraph; see paragraphLines.
   */
  gap?: number;
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
// The width a page turned over is mirrored across: US Letter, in points. Only
// the distances between its margins matter, and mirroring keeps those.
const TURNED_WIDTH = 612;

/**
 * Rebuild one page's text lines (with their left x-position) from pdf.js text
 * items. pdf.js hands back fragments — sometimes whole runs, sometimes one
 * glyph each (PDFs made with macOS "Print → Save as PDF") — so we join
 * fragments and break whenever `hasEOL` is set or the y-coordinate shifts.
 * Large vertical gaps become blank lines (block separators) so dialogue blocks
 * end correctly. Always ends with one blank line: the page boundary.
 *
 * Given the page's number, the lines that sit highest and lowest on the page
 * are marked with it (`edge`), by where they are and not by where the file
 * lists them: a footer is often the first thing in a page's text.
 */
// deno-lint-ignore no-explicit-any
export function linesFromItems(rawItems: any[], page?: number): Line[] {
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

  // A page scanned upside down and turned the right way up by its viewer keeps
  // its text where the scan had it: each line HIGHER than the one before, and
  // the left margin on the right. Read as it stands, the indents come out
  // mirrored (action furthest in, names furthest out) and nothing is ever a
  // "line further down". When nearly every step goes up the page, turn it over.
  const steps = pageLines.filter((l) => l.text.trim());
  let up = 0;
  let down = 0;
  for (let i = 1; i < steps.length; i++) {
    const d = steps[i - 1].y - steps[i].y;
    if (d > 2) down++;
    else if (d < -2) up++;
  }
  if (up >= 8 && up >= down * 4) {
    for (const l of pageLines) {
      l.x = TURNED_WIDTH - l.x;
      l.y = -l.y;
    }
  }

  // Typical line gap (median) → anything notably larger is a blank line.
  const gaps: number[] = [];
  for (let i = 1; i < pageLines.length; i++) {
    const g = pageLines[i - 1].y - pageLines[i].y;
    if (g > 0) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 12;

  // The highest and the lowest row of text on the page (a row can be two
  // pieces side by side: a title at one margin, the page number at the other).
  let top = -Infinity;
  let bottom = Infinity;
  if (page && page > 0) {
    for (const l of pageLines) {
      if (!l.text.trim()) continue;
      if (l.y > top) top = l.y;
      if (l.y < bottom) bottom = l.y;
    }
  }
  const SAME_ROW = 2; // the tolerance lines are joined by, above
  const edgeOf = (l: { text: string; y: number }): number | undefined => {
    if (!page || page <= 0 || !l.text.trim()) return undefined;
    if (top - l.y <= SAME_ROW) return page;
    // A page with a single row has only a "highest".
    if (l.y - bottom <= SAME_ROW && top - bottom > SAME_ROW) return -page;
    return undefined;
  };

  // The line above, for Line.gap: the last one with ink in it. Some PDFs mark
  // the end of a paragraph with an empty piece of text placed on the NEXT
  // line's row, and measured from that every paragraph would start 0pt down.
  let inkY: number | null = null;
  for (let i = 0; i < pageLines.length; i++) {
    if (i > 0) {
      const gap = pageLines[i - 1].y - pageLines[i].y;
      if (gap > typical * 1.6) out.push({ text: "", x: 0 });
    }
    const edge = edgeOf(pageLines[i]);
    const line: Line = edge
      ? { text: pageLines[i].text, x: pageLines[i].x, edge }
      : { text: pageLines[i].text, x: pageLines[i].x };
    if (pageLines[i].text.trim()) {
      if (inkY !== null) line.gap = Math.round((inkY - pageLines[i].y) * 10) / 10;
      inkY = pageLines[i].y;
    }
    out.push(line);
  }
  out.push({ text: "", x: 0 }); // page boundary
  return out;
}

/**
 * Take a document's running heads and feet out of its lines.
 *
 * A writer's PDF can carry a line on every page that is not script: "MY TITLE
 * • 12", "Draft 3 - 12.", the page number beside the title. A bare page number
 * was always dropped (ARTIFACT_RE); anything with words in it was read as
 * action, and so the narrator spoke it — once a page, sometimes in the middle
 * of a sentence that ran over the page break. (Nov 2026: a 26-page script's
 * footer, "<TITLE> • <page>", was narrated 24 times in the read its writer had
 * just paid for.)
 *
 * What marks such a line: it is the highest or lowest row of text on its page
 * (`edge`, set by linesFromItems), the same words come back on most pages, and
 * a number in it climbs with the page. All three are required. A character's
 * name is the first line of many pages too, and a script may count "ROUND 1",
 * "ROUND 2": neither sits at the edge of most pages with a number that follows
 * the page count, so neither is touched.
 *
 * Not caught: a head with no page number in its row (a title alone). It can't
 * be told from a line of the script without more to go on.
 */
export function dropRunningHeads(lines: Line[]): { lines: Line[]; dropped: number } {
  // The rows at the edges: page and side → the lines that make up the row.
  const rows = new Map<number, number[]>();
  for (let i = 0; i < lines.length; i++) {
    const e = lines[i].edge;
    if (!e || !lines[i].text.trim()) continue;
    if (!rows.has(e)) rows.set(e, []);
    rows.get(e)!.push(i);
  }
  const pagesWithText = new Set([...rows.keys()].map((e) => Math.abs(e))).size;
  if (pagesWithText < 3) return { lines, dropped: 0 };

  // Rows by their wording with the numbers taken out: "MY TITLE • #".
  const byShape = new Map<string, { page: number; nums: number[]; idx: number[] }[]>();
  for (const [e, idx] of rows) {
    // A row that is only a page number is left to the rule that has always
    // dropped it, so a script with nothing but page numbers reads exactly as
    // it did (the older text-only reader looks a few lines ahead, and what it
    // finds there would shift).
    if (idx.every((i) => ARTIFACT_RE.test(lines[i].text.trim()))) continue;
    const text = idx
      .map((i) => lines[i])
      .sort((a, b) => a.x - b.x)
      .map((l) => l.text.trim())
      .join(" ");
    const nums = (text.match(/\d+/g) ?? []).map(Number);
    if (!nums.length || text.length > 120) continue;
    const shape = text.replace(/\d+/g, "#").replace(/\s+/g, " ");
    if (!byShape.has(shape)) byShape.set(shape, []);
    byShape.get(shape)!.push({ page: Math.abs(e), nums, idx });
  }

  const drop = new Set<number>();
  for (const seen of byShape.values()) {
    // On enough pages to be the document's doing, not a coincidence of the text…
    const pages = new Set(seen.map((r) => r.page)).size;
    if (pages < 3 || pages < Math.ceil(pagesWithText * 0.4)) continue;
    // …and one of its numbers keeps step with the page.
    seen.sort((a, b) => a.page - b.page);
    let follows = false;
    for (let k = 0; k < seen[0].nums.length && !follows; k++) {
      let steps = 0;
      let inStep = 0;
      for (let j = 1; j < seen.length; j++) {
        const turned = seen[j].page - seen[j - 1].page;
        if (turned <= 0) continue; // the head and the foot of one page alike
        steps++;
        if (seen[j].nums[k] - seen[j - 1].nums[k] === turned) inStep++;
      }
      follows = steps >= 2 && inStep >= Math.ceil(steps * 0.8);
    }
    if (!follows) continue;
    for (const r of seen) for (const i of r.idx) drop.add(i);
  }
  if (!drop.size) return { lines, dropped: 0 };
  return { lines: lines.filter((_, i) => !drop.has(i)), dropped: drop.size };
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

/**
 * Pasted script text → the same lines a PDF page yields.
 *
 * For a writer with no usable PDF: the script lives in Google Docs or Word, or
 * is a Fountain file, or the only PDF is one we can't read. There is no page
 * geometry in pasted text, but where the paste kept its indentation (a "text
 * with layout" export) the leading spaces stand in for it: one space is one
 * tenth of an inch in screenplay Courier, so they convert straight to the
 * x-positions the parser classifies by. Without indentation everything sits
 * at the margin and the parser falls back to reading by shape (a name in
 * capitals on its own line, then what they say).
 *
 * Fountain's markup is taken off, since read aloud it's noise: the title block,
 * [[notes]], boneyard comments, # sections, = synopses, forcing characters and
 * emphasis marks.
 */
export function linesFromText(raw: string): { lines: Line[]; pages: number; inkByPage: number[] } {
  const LEFT = 108; // 1.5" left margin, in points
  const CHAR_W = 7.2; // one character of 12pt Courier
  const TAB = 8;
  const LINES_PER_PAGE = 56;

  let text = raw.replace(/\r\n?/g, "\n").replace(/[\u00a0\u2007\u202f]/g, " ");
  text = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\[\[[\s\S]*?\]\]/g, "");
  let rows = text.split("\n");

  // Fountain title page: "Key: value" lines from the very top to the first blank.
  if (/^\s*(title|credit|author|authors|source|draft date|contact|copyright|notes)\s*:/i.test(rows[0] ?? "")) {
    const end = rows.findIndex((r) => !r.trim());
    rows = end >= 0 ? rows.slice(end + 1) : [];
  }

  const pagesOfLines: Line[][] = [[]];
  const push = (l: Line) => pagesOfLines[pagesOfLines.length - 1].push(l);
  const explicitBreaks = text.includes("\f");
  for (const row of rows) {
    // A form feed is a page break in a text export.
    const parts = row.split("\f");
    parts.forEach((part, i) => {
      if (i > 0) pagesOfLines.push([]);
      const expanded = part.replace(/\t/g, " ".repeat(TAB));
      let body = expanded.trim();
      if (!body) return push({ text: "", x: 0 });
      if (/^#{1,6}\s/.test(body) || /^=(?!=)/.test(body) || /^={3,}$/.test(body)) return; // sections, synopses, page breaks
      const indent = expanded.length - expanded.trimStart().length;
      if (/^>.*<$/.test(body)) body = body.slice(1, -1).trim(); // centred
      else if (body.startsWith(">")) body = body.slice(1).trim(); // forced transition
      if (body.startsWith("@")) body = body.slice(1).trim().toUpperCase(); // forced character
      else if (/^[!~]/.test(body)) body = body.slice(1).trim(); // forced action, lyric
      else if (/^\.(?=[A-Za-z0-9])/.test(body)) body = body.slice(1).trim(); // forced scene heading
      // Emphasis marks around words: **bold**, *italic*, _underline_.
      body = body.replace(/(\*{1,3})(\S(?:.*?\S)?)\1/g, "$2").replace(/(^|\s)_(\S(?:.*?\S)?)_(?=\s|[.,;:!?]|$)/g, "$1$2");
      if (body) push({ text: body, x: LEFT + indent * CHAR_W });
    });
  }

  // No page breaks in the paste: count pages the way a screenplay fills them.
  let pages = pagesOfLines;
  if (!explicitBreaks) {
    const all = pagesOfLines[0];
    pages = [];
    for (let i = 0; i < all.length; i += LINES_PER_PAGE) pages.push(all.slice(i, i + LINES_PER_PAGE));
    if (!pages.length) pages = [[]];
  }
  const lines: Line[] = [];
  const inkByPage: number[] = [];
  for (const pg of pages) {
    for (const l of pg) lines.push(l);
    // A real page break separates blocks. A counted one must not: it falls
    // wherever line 56 happens to be, often between a name and their speech.
    if (explicitBreaks) lines.push({ text: "", x: 0 });
    inkByPage.push(inkChars(pg));
  }
  return { lines, pages: pages.length, inkByPage };
}

// ---- Pasted text without indentation ---------------------------------------
// With no positions to go by, structure has to come from the text itself.
// Three shapes cover what people paste:
//   • blocks separated by blank lines (Fountain, plain-text exports): a line in
//     capitals with text straight under it is a speaker, per the Fountain spec;
//   • one paragraph per line with no blank lines (copied out of Word or Google
//     Docs): a speaker's name, then exactly one paragraph of speech;
//   • "NAME: what they say" on one line (stage and radio scripts, hand-typed).
const TEXT_HEADING_RE = /^(INT\.?\s*\/\s*EXT|EXT\.?\s*\/\s*INT|INT|EXT|EST|I\s*\/\s*E)[.\s]/i;
// Capitals on their own line that are directions, not people.
const TEXT_NOT_A_NAME_RE =
  /^(INT|EXT|FADE|CUT TO|DISSOLVE|SMASH CUT|MATCH CUT|JUMP CUT|THE END|END OF|CONTINUED|MORE|TITLE|SUPER|INSERT|INTERCUT|BACK TO|MONTAGE|SERIES OF|LATER|MOMENTS LATER|CONTINUOUS|MEANWHILE|FLASHBACK|BLACK|OVER BLACK)\b/;
const TEXT_TRANSITION_RE = /^(FADE (IN|OUT|TO)|CUT TO|SMASH CUT|MATCH CUT|JUMP CUT|DISSOLVE TO|BACK TO|THE END)\b|TO:$/;
const INLINE_CUE_RE = /^([A-Z][A-Z0-9 .'’&#-]{1,30}?)(?:\s*\((.{1,24})\))?:\s+(\S.*)$/;
// "WORD: text" lines that are directions or labels, never someone speaking.
const INLINE_NOT_A_NAME_RE =
  /^(NOTE|NOTES|WARNING|TITLE|SUPER|SCENE|ACT|CHAPTER|SETTING|TIME|PLACE|AT RISE|CAST|CHARACTERS|SOUND|MUSIC|LIGHTS|SFX|FX|CUT TO|FADE)\b/;
// The same line with the name written as a name is ("Maeve: …", "Dr. Okafor:
// …", "Old Man 2: …") instead of in capitals: how a script typed in Word or
// Google Docs usually has it. Far more ordinary sentences have this shape than
// have the capitals one ("Remember: he lies."), so it is trusted only on much
// stronger evidence; see classifyPlainText.
const INLINE_CASED_RE =
  /^([A-Z][A-Za-z.'’-]*(?: (?:[A-Z][A-Za-z.'’-]*|#?\d{1,2})){0,2})(?:\s*\((.{1,24})\))?:\s+(\S.*)$/;

/** "MRS. LINDQVIST (V.O.)", "COP 2 ^", "ALEX:" → the name, or null if the line isn't shaped like a cue. */
function textCueName(t: string): string | null {
  const m = t.replace(/\s*\^$/, "").replace(/:$/, "").trim().match(CUE_RE);
  if (!m) return null;
  const name = m[1].trim();
  if (name.length < 2 || !/[A-Z]{2}/.test(name) || /^\d/.test(name) || TEXT_NOT_A_NAME_RE.test(name)) return null;
  return name;
}

/** Classify pasted, unindented text. See the three shapes above. */
export function classifyPlainText(lines: Line[]): ParsedScene[] {
  const rows = lines.map((l) => l.text.trim());
  const filled = rows.filter(Boolean).length;
  // Blank lines between blocks, or one paragraph per line with none?
  const blockStyle = rows.length > 0 && (rows.length - filled) / rows.length > 0.12;
  const blank = (k: number) => k < 0 || k >= rows.length || !rows[k];

  // "NAME: speech" is only trusted once the script shows it's written that
  // way — several such lines, with a name that keeps coming back — so one
  // stray "WARNING: wet floor" in an action line isn't taken for a speaker.
  // Once it is, a name that appears a single time still counts: bit parts.
  const inlineName = (t: string): RegExpMatchArray | null => {
    const m = t.match(INLINE_CUE_RE);
    return m && !TEXT_NOT_A_NAME_RE.test(m[1]) && !INLINE_NOT_A_NAME_RE.test(m[1]) && !TEXT_HEADING_RE.test(t) ? m : null;
  };
  const inlineCounts = new Map<string, number>();
  for (const t of rows) {
    const m = inlineName(t);
    if (m) inlineCounts.set(m[1].trim(), (inlineCounts.get(m[1].trim()) || 0) + 1);
  }
  const inlineStyle =
    [...inlineCounts.values()].reduce((a, b) => a + b, 0) >= 3 && [...inlineCounts.values()].some((n) => n >= 2);

  // "Name: speech" with the name in ordinary case. Trusted only when the page
  // is plainly written that way: at least six such lines, making up at least
  // one line in seven, nearly all of them (four in five) under a name that
  // comes back. A report with a few "Summary: …" lines has none of that.
  const casedName = (t: string): RegExpMatchArray | null => {
    if (inlineName(t)) return null; // in capitals: the rule above has it
    const m = t.match(INLINE_CASED_RE);
    if (!m || m[1].length > 24) return null;
    const upper = m[1].toUpperCase();
    return !TEXT_NOT_A_NAME_RE.test(upper) && !INLINE_NOT_A_NAME_RE.test(upper) && !TEXT_HEADING_RE.test(t) ? m : null;
  };
  const casedCounts = new Map<string, number>();
  for (const t of rows) {
    const m = casedName(t);
    if (m) casedCounts.set(m[1].toUpperCase(), (casedCounts.get(m[1].toUpperCase()) || 0) + 1);
  }
  const casedTotal = [...casedCounts.values()].reduce((a, b) => a + b, 0);
  const casedRecurring = [...casedCounts.values()].filter((n) => n >= 2).reduce((a, b) => a + b, 0);
  const casedStyle = casedTotal >= 6 && casedTotal * 7 >= filled && casedRecurring * 5 >= casedTotal * 4;
  // In a script that writes its names in capitals, the odd "Maeve:" is still Maeve.
  const casedCue = (t: string): RegExpMatchArray | null => {
    const m = casedName(t);
    return m && (casedStyle || (inlineStyle && inlineCounts.has(m[1].toUpperCase()))) ? m : null;
  };

  // Lines broken at the page's width with no blank lines between blocks: text
  // copied out of a PDF viewer. A speech's column is narrow (about 35
  // characters) and action runs to 60, so line length is the only clue to
  // where a speech ends. Best effort; the PDF itself reads better.
  const lengths = rows.filter(Boolean).map((r) => r.length).sort((a, b) => a - b);
  const hardWrapped = !blockStyle && lengths.length >= 30 && lengths[Math.floor(lengths.length * 0.95)] <= 64;
  const SPEECH_WIDTH = 40;

  // Without blank lines a name must recur to count: a single line in capitals
  // could as easily be a sound effect.
  const recurring = new Set<string>();
  if (!blockStyle) {
    const seen = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) {
      const name = rows[i] ? textCueName(rows[i]) : null;
      const next = rows.slice(i + 1).find(Boolean) ?? "";
      if (name && !CUE_EXCLUDE_RE.test(name) && next && !textCueName(next) && !TEXT_HEADING_RE.test(next)) {
        seen.set(name, (seen.get(name) || 0) + 1);
      }
    }
    for (const [name, n] of seen) if (n >= 2) recurring.add(name);
  }

  const scenes: ParsedScene[] = [];
  let current: ParsedScene = { heading: "", scene_index: 0, elements: [] };
  scenes.push(current);
  let speaker: string | null = null;
  let owed = 0; // paragraph style: paragraphs of speech still due to this speaker

  for (let i = 0; i < rows.length; i++) {
    const t = rows[i];
    if (!t) {
      if (blockStyle) speaker = null; // a blank line ends the speech
      continue;
    }
    if (ARTIFACT_RE.test(t)) continue;

    if (TEXT_HEADING_RE.test(t) && (!speaker || !blockStyle)) {
      current = { heading: t, scene_index: scenes.length, elements: [] };
      scenes.push(current);
      speaker = null;
      owed = 0;
      continue;
    }
    if (TEXT_TRANSITION_RE.test(t) && t === t.toUpperCase() && (!blockStyle || !speaker)) {
      speaker = null;
      owed = 0;
      continue;
    }

    if (inlineStyle || casedStyle) {
      const m = inlineName(t) ?? casedCue(t);
      if (m) {
        // Names are capitals everywhere else in a script: a cast list keyed
        // "MAEVE" and "Maeve" would be two people.
        const name = m[1].trim().toUpperCase();
        current.elements.push({ type: "character", character_name: name, text: name });
        current.elements.push({ type: "dialogue", character_name: name, text: m[3].trim() });
        speaker = blockStyle ? name : null; // wrapped lines under it stay theirs
        owed = 0;
        continue;
      }
    }

    const name = textCueName(t);
    const isCue = !!name && (blockStyle ? blank(i - 1) && !blank(i + 1) : recurring.has(name) && !blank(i + 1));
    if (isCue) {
      speaker = name;
      owed = 1;
      current.elements.push({ type: "character", character_name: name!, text: name! });
      continue;
    }

    if (speaker) {
      if (/^\(.*\)$/.test(t)) {
        current.elements.push({ type: "parenthetical", character_name: speaker, text: t });
        owed = 1; // a direction mid-speech is followed by more speech
        continue;
      }
      if (blockStyle || owed > 0 || (hardWrapped && t.length <= SPEECH_WIDTH)) {
        current.elements.push({ type: "dialogue", character_name: speaker, text: t });
        owed = 0;
        continue;
      }
      speaker = null; // their speech is said; this is something else
    }
    current.elements.push({ type: "action", text: t });
  }
  return scenes;
}

/**
 * A document's lines, joined back into the paragraphs they were typed as: one
 * line out per paragraph, no blank lines, the shape classifyPlainText reads a
 * paste in.
 *
 * A script typed in Word or Google Docs has no screenplay indentation to read
 * by. What it has is paragraphs: "MAEVE: I told you." wrapping onto a second
 * and third line, then a stage direction, then the next speech. In the PDF
 * those are just lines at one margin, so read line by line the first line of a
 * speech is the character's and the rest of it is narration. The space between
 * lines is what still shows where a paragraph ends: lines of one paragraph sit
 * a line's pitch apart (15pt, say), paragraphs a little further (18pt, 25pt,
 * 29pt in the files seen). The first clear step up from the pitch is taken as
 * the break.
 *
 * Also a new paragraph: a line far to the left or right of the one above (a
 * centred name over a speech at the margin), a line that is wholly a
 * (direction), and the top of a page unless the line above the break was left
 * in mid-sentence.
 *
 * Returns null when it has nothing to go by: lines with no spacing recorded (a
 * page reader from before this, a scan, a paste), or a document whose
 * paragraphs are no further apart than its lines.
 */
export function paragraphLines(lines: Line[]): Line[] | null {
  const body = lines.filter((l) => l.text.trim() && !ARTIFACT_RE.test(l.text.trim()));
  const gaps = body.map((l) => l.gap).filter((g): g is number => typeof g === "number" && g >= 6);
  if (body.length < 8 || gaps.length * 2 < body.length) return null;

  // Spacings that are common (at least one line in twenty), smallest first.
  // The smallest is the pitch of ordinary lines; the first one at least 15%
  // larger than its neighbour below is the smallest paragraph break.
  const tally = new Map<number, number>();
  for (const g of gaps) tally.set(Math.round(g), (tally.get(Math.round(g)) ?? 0) + 1);
  const floor = Math.max(4, gaps.length * 0.05);
  const common = [...tally.entries()].filter(([, n]) => n >= floor).map(([g]) => g).sort((a, b) => a - b);
  let breakAt = 0;
  for (let i = 1; i < common.length; i++) {
    if (common[i] >= common[i - 1] * 1.15) {
      breakAt = (common[i] + common[i - 1]) / 2;
      break;
    }
  }
  if (!breakAt) return null;

  const SHIFT = 48; // two thirds of an inch: more than any indent inside a paragraph
  const whole = /^[(\[].*[)\]]$/; // "(She exits.)", "[Lights down.]"
  const opensSpeech = /^[A-Z][A-Za-z0-9 .'’&#-]{0,30}(?:\s*\(.{1,24}\))?:\s+\S/;
  const out: Line[] = [];
  let cur: { text: string; x: number; lastX: number; last: string } | null = null;
  let topOfPage = true;
  const close = () => {
    if (cur) out.push({ text: cur.text, x: cur.x });
    cur = null;
  };
  for (const l of lines) {
    const t = l.text.trim();
    if (!t) continue; // separators say nothing the spacing doesn't
    if (typeof l.gap !== "number") topOfPage = true; // a page's first line
    if (ARTIFACT_RE.test(t)) continue; // page numbers, (MORE): not part of any paragraph
    let joins: boolean;
    if (!cur) joins = false;
    else if (whole.test(t) || whole.test(cur.last)) joins = false;
    else if (Math.abs(l.x - cur.lastX) > SHIFT) joins = false;
    else if (topOfPage) joins = !/[.!?…:;"”’')\]]$/.test(cur.last) && !opensSpeech.test(t);
    else joins = (l.gap as number) > 1 && (l.gap as number) <= breakAt;
    if (joins && cur) {
      cur.text = `${cur.text} ${t}`;
      cur.lastX = l.x;
      cur.last = t;
    } else {
      close();
      cur = { text: t, x: l.x, lastX: l.x, last: t };
    }
    topOfPage = false;
  }
  close();
  return out;
}

/**
 * Whether a document read as its paragraphs is a script, with people speaking
 * in it: at least five speeches, and at least one paragraph in six a speech.
 * Counted on the paragraphs as classified, before runs of narration are joined
 * into blocks: a 186-page manuscript on file has twenty lines shaped like
 * "NAME: speech" among 3,382 paragraphs, and is not a script.
 */
export function readsAsScript(scenes: ParsedScene[]): boolean {
  let speeches = 0;
  let narration = 0;
  for (const scene of scenes) {
    for (const el of scene.elements) {
      if (el.type === "dialogue") speeches++;
      else if (el.type === "action") narration++;
    }
  }
  return speeches >= 5 && speeches * 6 >= speeches + narration;
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
  /** "paragraphs": a PDF with no screenplay layout, read as its paragraphs (see parseLines). */
  mode: "geometric" | "legacy" | "text" | "paragraphs";
  /** Lines taken out as running heads or feet before reading (see dropRunningHeads). */
  runningHeads?: number;
  grid: IndentGrid | null;
  scenes: ParsedScene[];
  /** Every speaking character, most lines first. */
  characters: ParsedCharacter[];
  totalElements: number;
  counts: Record<ElementType, number>;
}

/** Classify a whole document's lines into the shape stored in scripts.parsed_json. */
export function parseLines(all: Line[]): ParseResult {
  // What the pages carry that isn't script comes out first.
  const { lines, dropped } = dropRunningHeads(all);
  // Prefer indent-aware classification (standard screenplay format encodes
  // element type in indentation); fall back to text heuristics otherwise.
  const grid = inferIndents(lines);
  const scenes = grid ? classifyGeometric(lines, grid) : classifyLegacy(lines);
  let result = assemble(grid ? "geometric" : "legacy", grid, scenes);

  // A script that isn't laid out as a screenplay: typed in Word or Google Docs
  // as "MAEVE: I told you." (or "Maeve: …"), or as a play, the name centred
  // over a speech that starts at the margin. Read by position, the first comes
  // out as narration with no characters, and the second as hundreds of names
  // nobody answers to (one 123-page play: 733 names, ten speeches). Only then,
  // with next to nobody speaking, is the document read a second way, as its
  // paragraphs, and that reading kept only if people speak in it. A script
  // that reads as one today is never read differently.
  const silent = result.counts.dialogue < 5 || result.counts.dialogue * 4 < result.counts.character;
  if (silent) {
    const paragraphs = paragraphLines(lines);
    if (paragraphs) {
      const scenesByShape = classifyPlainText(paragraphs);
      if (readsAsScript(scenesByShape)) {
        const byShape = assemble("paragraphs", null, scenesByShape);
        if (byShape.counts.dialogue >= result.counts.dialogue * 3) result = byShape;
      }
    }
  }
  if (dropped) result.runningHeads = dropped;
  return result;
}

/**
 * The same, for lines that came from pasted text (linesFromText). A paste that
 * kept its indentation is read by position like a PDF; one that didn't is read
 * by the shapes pasted text actually takes, not by the PDF fallback rules.
 */
export function parseText(lines: Line[]): ParseResult {
  const grid = inferIndents(lines);
  return grid ? assemble("geometric", grid, classifyGeometric(lines, grid)) : assemble("text", null, classifyPlainText(lines));
}

/** Everything after classification: who says what, runs joined up, the tallies. */
function assemble(mode: ParseResult["mode"], grid: IndentGrid | null, scenes: ParsedScene[]): ParseResult {

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
