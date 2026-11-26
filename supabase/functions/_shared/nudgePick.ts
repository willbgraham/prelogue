// Who is due the "your first ten lines are free to hear" nudge, and about
// which of their scripts. Pure: send-nudge gathers the rows, this decides, so
// the rule can be checked without a database or a mail provider.
//
// The rule is one nudge per WRITER, ever. It used to be one per script: a
// writer who uploaded three drafts got three emails, and one who uploaded a
// one-page test alongside a play got an email about each, a second apart.

export type LockedScript = {
  id: string;
  writer_id: string;
  created_at: string;
  page_count: number | null;
  /** The parse found real dialogue (see `readsAsScript`). Without it there is
   *  no cast to choose and the "opening" is one voice reading everything as
   *  narration: a keyboard-mash test, or a layout the parser couldn't read.
   *  Not something to send a writer to. */
  reads_as_script: boolean;
};

/** How a script parsed: lines a character speaks, and lines the narrator reads. */
export type ParsedLines = { dialogue: number; action: number };

/** Count the spoken lines of a stored parse (`scripts.parsed_json`). */
export function countLines(parsed: unknown): ParsedLines {
  const out: ParsedLines = { dialogue: 0, action: 0 };
  const scenes = (parsed as { scenes?: unknown } | null)?.scenes;
  if (!Array.isArray(scenes)) return out;
  for (const scene of scenes) {
    const elements = (scene as { elements?: unknown } | null)?.elements;
    if (!Array.isArray(elements)) continue;
    for (const el of elements) {
      const type = (el as { type?: unknown } | null)?.type;
      if (type === "dialogue") out.dialogue++;
      else if (type === "action") out.action++;
    }
  }
  return out;
}

/**
 * Whether a parse is a script with a cast, rather than a page of narration:
 * at least five lines of dialogue, and at least one spoken line in ten is a
 * character's. A count of characters is not the test: one feature on file has
 * seven characters, 733 cues, and ten lines of dialogue against 728 that the
 * narrator reads, because its speeches were taken for action.
 */
export function readsAsScript(lines: ParsedLines): boolean {
  const spoken = lines.dialogue + lines.action;
  return lines.dialogue >= 5 && lines.dialogue * 10 >= spoken;
}

export type NudgeChoice = { writer_id: string; script_id: string };

export type Held = {
  /** Has paid before, for anything: never nudged, whatever else is locked. */
  paid: number;
  /** Already had the nudge, about any script. */
  nudged_before: number;
  /** The house account. */
  house: number;
  /** Nothing of theirs in the window parsed as a script with a cast. */
  nothing_to_cast: number;
};

export type PickInput = {
  /** Locked scripts inside the window (old enough, not too old). */
  scripts: LockedScript[];
  paid: Iterable<string>;
  nudged: Iterable<string>;
  /** Id prefix of the house account. */
  house: string;
};

const pages = (s: LockedScript) => (typeof s.page_count === "number" && isFinite(s.page_count) ? s.page_count : 0);

/** The script to write to a writer about: the longest that reads as a script; the newest of equals. */
export function featured(scripts: LockedScript[]): LockedScript | null {
  const castable = scripts.filter((s) => s.reads_as_script);
  if (!castable.length) return null;
  return castable.reduce((best, s) =>
    pages(s) > pages(best) || (pages(s) === pages(best) && s.created_at > best.created_at) ? s : best
  );
}

/**
 * One choice per writer who is due, the longest-waiting first (by the age of
 * the script chosen for them), with a count of everyone held back and why.
 */
export function pickNudges(input: PickInput): { writers: number; choices: NudgeChoice[]; held: Held } {
  const paid = new Set(input.paid);
  const nudged = new Set(input.nudged);
  const byWriter = new Map<string, LockedScript[]>();
  for (const s of input.scripts) {
    if (!s || !s.id || !s.writer_id) continue;
    const list = byWriter.get(s.writer_id);
    if (list) list.push(s);
    else byWriter.set(s.writer_id, [s]);
  }
  const held: Held = { paid: 0, nudged_before: 0, house: 0, nothing_to_cast: 0 };
  const due: { choice: NudgeChoice; since: string }[] = [];
  for (const [writer, scripts] of byWriter) {
    if (input.house && writer.startsWith(input.house)) held.house++;
    else if (paid.has(writer)) held.paid++;
    else if (nudged.has(writer)) held.nudged_before++;
    else {
      const pick = featured(scripts);
      if (!pick) held.nothing_to_cast++;
      else due.push({ choice: { writer_id: writer, script_id: pick.id }, since: pick.created_at });
    }
  }
  due.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.choice.writer_id < b.choice.writer_id ? -1 : 1));
  return { writers: byWriter.size, choices: due.map((d) => d.choice), held };
}
