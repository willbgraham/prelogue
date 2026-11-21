// OCR output → the lines parse-script expects.
//
// A scanned screenplay has no text in it, only pictures of pages. Tesseract
// turns each picture back into words with positions; this module turns those
// words into the same shape the PDF-text path produces — one entry per line,
// with the x-position where the line starts — because that x-position is how
// the parser tells action from dialogue from a character cue. Getting the
// words right is Tesseract's job; getting where each line STARTS right is ours.
//
// Pure functions, no I/O. Measured on a synthetic script with a known answer
// (clean pages, and pages tilted up to 1.5° either way): every line recovered,
// structure identical to the original, ~0.05% character error.

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);

// A scanner leaves a shadow at the paper's edge that reads as a lone bar or
// dash. Nothing a script prints sits in the outer quarter inch, and no line
// starts or ends with a bare symbol.
const JUNK = /^[|«»~_=<>—\-.,'`:;]+$/;
const EDGE_JUNK = /^[|«»~_=<>]+$/;
const EDGE_PT = 18;

/**
 * One page of Tesseract TSV (`tesseract page.png out tsv`) → text lines with
 * positions in PDF points, origin bottom-left (the convention pdf.js uses, so
 * a scanned page and a text page land in the same coordinate space).
 */
function pageFromTsv(tsv, dpi) {
  const S = 72 / dpi;
  const cells = tsv.split("\n").slice(1).map((l) => l.split("\t")).filter((c) => c.length >= 12);
  const pageRow = cells.find((c) => c[0] === "1");
  const widthPx = Number(pageRow?.[8]) || Math.round(8.5 * dpi);
  const heightPx = Number(pageRow?.[9]) || Math.round(11 * dpi);
  const byLine = new Map();
  for (const c of cells) {
    if (c[0] !== "5" || !c[11].trim()) continue;
    const key = `${c[2]}-${c[3]}-${c[4]}`; // block-paragraph-line
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push({ x: +c[6], y: +c[7], w: +c[8], h: +c[9], conf: +c[10], t: c[11] });
  }
  const obs = [];
  let confSum = 0;
  let confN = 0;
  for (const words of byLine.values()) {
    words.sort((a, b) => a.x - b.x);
    let kept = words.filter(
      (w) => !(JUNK.test(w.t) && (w.x * S < EDGE_PT || (w.x + w.w) * S > widthPx * S - EDGE_PT))
    );
    while (kept.length > 1 && JUNK.test(kept[0].t) && kept[0].t !== "-" && kept[0].t !== "—") kept.shift();
    while (kept.length > 1 && EDGE_JUNK.test(kept[kept.length - 1].t)) kept.pop();
    if (kept.length === 0 || (kept.length === 1 && JUNK.test(kept[0].t))) continue;
    const top = Math.min(...kept.map((w) => w.y));
    const bottom = Math.max(...kept.map((w) => w.y + w.h));
    const last = kept[kept.length - 1];
    for (const w of kept) {
      confSum += w.conf;
      confN++;
    }
    obs.push({
      t: kept.map((w) => w.t).join(" "),
      x: kept[0].x * S,
      y: (heightPx - bottom) * S,
      w: (last.x + last.w - kept[0].x) * S,
      h: (bottom - top) * S,
    });
  }
  return { width: widthPx * S, height: heightPx * S, obs, confSum, confN };
}

/** Observations on the same baseline, joined left to right, top of page first. */
function rowsFromPage(page, stats) {
  const obs = page.obs.filter((o) => o.t.trim()).map((o) => ({ ...o, cy: o.y + o.h / 2 }));
  const hMed = median(obs.map((o) => o.h)) || 10;
  obs.sort((a, b) => b.cy - a.cy);
  const groups = [];
  for (const o of obs) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.cy - o.cy) < hMed * 0.5) {
      last.parts.push(o);
      last.cy = (last.cy * (last.parts.length - 1) + o.cy) / last.parts.length;
    } else {
      groups.push({ cy: o.cy, parts: [o] });
    }
  }
  const rows = [];
  for (const g of groups) {
    g.parts.sort((a, b) => a.x - b.x);
    let text = g.parts.map((q) => q.t.trim()).join(" ").replace(/\s+/g, " ").trim();
    let x = g.parts[0].x;
    const lastPart = g.parts[g.parts.length - 1];
    const right = lastPart.x + lastPart.w;
    // Shooting scripts print the scene number in both margins
    // ("12 INT. KITCHEN - DAY 12") and mark revised lines with a "*" at the
    // right edge. Neither is part of the line, and the line starts where its
    // text does, not where the number does.
    const lead = /^(\d{1,3}[A-Z]{0,2}\.?)\s+(?=\S)/.exec(text);
    const heading = /^(?:\d{1,3}[A-Z]{0,2}\.?\s+)?(INT[.,:]|EXT[.,:]|INT\.?\/EXT[.,:]|I\/E[.,:])/i.test(text);
    if (lead && heading) {
      const whole = text.length;
      text = text.slice(lead[0].length);
      x += (lead[0].length / Math.max(1, whole)) * (right - x);
      stats.sceneNumbers++;
    }
    if (heading) text = text.replace(/\s+\d{1,3}[A-Z]{0,2}\.?\s*\*?$/, "").replace(/^(INT|EXT)[,:]/i, "$1.");
    const unstarred = text.replace(/(\s*\*)+$/, "");
    if (unstarred !== text && unstarred) {
      text = unstarred;
      stats.revisionMarks++;
    }
    if (text && !/^\*+$/.test(text)) rows.push({ y: g.cy, x, text });
  }
  return rows;
}

/**
 * A page that went through the scanner at an angle has left edges that drift
 * across the page from top to bottom — and, past a couple of degrees, short
 * lines (a character cue) drift into the row above or below. Find the rotation
 * that makes the page's left edges line up into the fewest, tallest columns,
 * and turn every word back by it. Done before rows are built, because which
 * words share a row depends on it.
 */
function straighten(page) {
  const obs = page.obs;
  if (obs.length < 8) return 0;
  const cx = page.width / 2;
  const cy = page.height / 2;
  const score = (a) => {
    const sin = Math.sin(a);
    const cos = Math.cos(a);
    const bins = new Map();
    for (const o of obs) {
      const x = cx + (o.x - cx) * cos + (o.y + o.h / 2 - cy) * sin;
      const b = Math.round(x / 3);
      bins.set(b, (bins.get(b) || 0) + 1);
    }
    let s = 0;
    for (const n of bins.values()) s += n * n;
    return s;
  };
  let best = 0;
  let bestScore = score(0);
  // ±0.08 rad ≈ ±4.6°, in steps of 0.001 rad ≈ 0.06°. Zero wins ties.
  for (let k = -80; k <= 80; k++) {
    const a = k * 0.001;
    const s = score(a);
    if (s > bestScore * 1.0001) {
      bestScore = s;
      best = a;
    }
  }
  if (best !== 0) {
    const sin = Math.sin(best);
    const cos = Math.cos(best);
    for (const o of obs) {
      const midY = o.y + o.h / 2;
      // Where the line starts (its left edge)…
      const left = cx + (o.x - cx) * cos + (midY - cy) * sin;
      // …and the height of its middle, which is what puts words on one row.
      const midX = o.x + o.w / 2;
      const rowY = cy - (midX - cx) * sin + (midY - cy) * cos;
      o.x = left;
      o.y = rowY - o.h / 2;
    }
  }
  return best;
}

/**
 * Running headers and footers: the page number, a draft date, "(CONTINUED)".
 * They are printed in the same spot on every page, set apart from the text,
 * and they are not part of the script — but read aloud they become "November
 * twelfth, thirty-seven" between two lines of dialogue, on every page, and
 * they cut a speech in two wherever it runs over a page break. (The parser
 * drops a bare page number on its own; it can't know "Nov 12, 2024 37." is
 * one, and OCR sometimes reads "3." as "3s".)
 *
 * A first (or last) row counts as furniture when it has a number in it or is
 * very short, sits clear of the text block, and the same thing happens at the
 * same height on a good share of the pages. One page proves nothing, so this
 * needs a few pages to act at all.
 */
function dropRunningHeads(pages) {
  const dropped = { headers: 0, footers: 0 };
  const typicalGap = (rows) => {
    const g = [];
    for (let i = 1; i < rows.length; i++) if (rows[i - 1].y - rows[i].y > 0) g.push(rows[i - 1].y - rows[i].y);
    return median(g) || 12;
  };
  // "Nov 12, 2024 37." → "AAA 9, 9 9": letters and digit runs, so the same
  // header on another page (another page number, a misread digit) matches.
  const shapeOf = (text) => text.replace(/[A-Za-z]/g, "A").replace(/\d+/g, "9").replace(/[^A9, ]/g, "").trim().slice(0, 14);
  const looksLikeFurniture = (text) => /\d/.test(text) || text.replace(/[^A-Za-z0-9]/g, "").length <= 12;
  for (const edge of ["headers", "footers"]) {
    const candidates = [];
    for (const pg of pages) {
      if (pg.rows.length < 4) continue;
      const first = edge === "headers" ? pg.rows[0] : pg.rows[pg.rows.length - 1];
      const next = edge === "headers" ? pg.rows[1] : pg.rows[pg.rows.length - 2];
      const apart = Math.abs(first.y - next.y) > typicalGap(pg.rows) * 1.3;
      if (apart && looksLikeFurniture(first.text)) candidates.push({ pg, row: first });
    }
    const usable = pages.filter((p) => p.rows.length >= 4).length;
    if (candidates.length < 3 || candidates.length < usable * 0.4) continue;
    const height = median(candidates.map((c) => c.row.y));
    const shapes = new Map();
    for (const c of candidates) {
      if (Math.abs(c.row.y - height) > 14) continue;
      const shape = shapeOf(c.row.text);
      shapes.set(shape, (shapes.get(shape) || 0) + 1);
      c.pg.rows.splice(c.pg.rows.indexOf(c.row), 1);
      dropped[edge]++;
    }
    // A header with words in it ("Nov 12, 2024 37.") has a recognisable
    // outline. Where one page's copy didn't sit clear of the text, or wasn't
    // the first thing read, catch it by that outline at that height.
    const [commonShape, count] = [...shapes.entries()].sort((a, b) => b[1] - a[1])[0] || ["", 0];
    if (commonShape.length >= 8 && count >= Math.max(3, dropped[edge] * 0.5)) {
      for (const pg of pages) {
        const kept = pg.rows.filter((r) => !(Math.abs(r.y - height) <= 14 && shapeOf(r.text) === commonShape));
        dropped[edge] += pg.rows.length - kept.length;
        pg.rows = kept;
      }
    }
  }
  // Continuation marks the parser would catch if OCR hadn't put a space in
  // them: "(MORE )", "( CONTINUED)", "CONTINUED :".
  let marks = 0;
  for (const pg of pages) {
    const before = pg.rows.length;
    pg.rows = pg.rows.filter((r) => !/^\(?(CONTINUED|MORE)\)?[:.]?$/i.test(r.text.replace(/\s+/g, "")));
    marks += before - pg.rows.length;
  }
  return { ...dropped, marks };
}

/**
 * A scan also sits a little differently on the glass each page. Slide each
 * page sideways to line its columns up with the document's.
 */
function alignPages(pages) {
  const BIN = 2;
  const shifts = new Map();
  for (let pass = 0; pass < 2; pass++) {
    const H = new Map();
    for (const pg of pages) for (const r of pg.rows) H.set(Math.round(r.x / BIN), (H.get(Math.round(r.x / BIN)) || 0) + 1);
    for (const pg of pages) {
      if (pg.rows.length < 5) continue;
      let best = 0;
      let bestScore = -1;
      for (let d = -24; d <= 24; d++) {
        let s = 0;
        for (const r of pg.rows) {
          const b = Math.round((r.x - d) / BIN);
          s += (H.get(b) || 0) + 0.5 * ((H.get(b - 1) || 0) + (H.get(b + 1) || 0));
        }
        s -= Math.abs(d) * 0.01; // prefer not moving
        if (s > bestScore) {
          bestScore = s;
          best = d;
        }
      }
      if (best) {
        for (const r of pg.rows) r.x -= best;
        shifts.set(pg.page, (shifts.get(pg.page) || 0) + best);
      }
    }
  }
  return shifts;
}

/**
 * Everything above, for a whole document.
 * @param {{tsv: string, dpi: number}[]} tsvPages  one entry per page, in order
 * @returns {{ lines: [string, number][], pages: number, quality: object }}
 */
function linesFromOcr(tsvPages) {
  const stats = { sceneNumbers: 0, revisionMarks: 0 };
  let confSum = 0;
  let confN = 0;
  const pages = tsvPages.map((p, i) => {
    const page = pageFromTsv(p.tsv, p.dpi);
    confSum += page.confSum;
    confN += page.confN;
    const tilt = straighten(page);
    const rows = rowsFromPage(page, stats);
    return { page: i + 1, rows, tilt };
  });
  const furniture = dropRunningHeads(pages);
  const shifts = alignPages(pages);

  const lines = [];
  const inkByPage = [];
  for (const pg of pages) {
    const gaps = [];
    for (let i = 1; i < pg.rows.length; i++) {
      const g = pg.rows[i - 1].y - pg.rows[i].y;
      if (g > 0) gaps.push(g);
    }
    const typical = median(gaps) || 12;
    let ink = 0;
    pg.rows.forEach((r, i) => {
      // A large vertical gap is a blank line (it ends a dialogue block), as in
      // the PDF-text path.
      if (i > 0 && pg.rows[i - 1].y - r.y > typical * 1.6) lines.push(["", 0]);
      lines.push([r.text, +r.x.toFixed(2)]);
      ink += r.text.replace(/\s+/g, "").length;
    });
    lines.push(["", 0]); // page boundary
    inkByPage.push(ink);
  }

  const rowCount = pages.reduce((n, p) => n + p.rows.length, 0);
  return {
    lines,
    pages: pages.length,
    quality: {
      rows: rowCount,
      words: confN,
      meanConfidence: confN ? +(confSum / confN / 100).toFixed(3) : 0,
      inkPerPageMedian: median(inkByPage),
      emptyPages: inkByPage.filter((n) => n < 20).length,
      pagesStraightened: pages.filter((p) => Math.abs(p.tilt) >= 0.002).length,
      steepestTiltDegrees: +(Math.max(0, ...pages.map((p) => Math.abs(p.tilt))) * 180 / Math.PI).toFixed(1),
      pagesShifted: [...shifts.values()].filter((d) => Math.abs(d) >= 3).length,
      marginSceneNumbers: stats.sceneNumbers,
      revisionMarks: stats.revisionMarks,
      runningHeadersDropped: furniture.headers,
      runningFootersDropped: furniture.footers,
      continuationMarksDropped: furniture.marks,
    },
  };
}

module.exports = { linesFromOcr, pageFromTsv, rowsFromPage, straighten, alignPages, dropRunningHeads };
