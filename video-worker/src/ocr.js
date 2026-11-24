// Read a scanned screenplay: pictures of pages in, script lines out.
//
// Run by the render-one workflow with variant "ocr" (parse-script dispatches it
// when an upload turns out to have no text in it). Steps: download the PDF,
// get one image per page, run Tesseract on each, turn the words back into
// lines (src/ocrLines.js), and hand those lines to parse-script, which saves
// them exactly as it saves a normal script and emails the writer.
//
// Uses only what a GitHub runner has or can apt-get: poppler (pdfimages,
// pdftoppm, pdfinfo) and tesseract; and ffmpeg, to turn a tilted page upright,
// which comes with the renderer (src/ff.js) and is done without if absent.
//
// THIS REPOSITORY AND ITS ACTION LOGS ARE PUBLIC. Nothing here may print a
// line of anyone's script — counts, timings and error names only.
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { linesFromOcr, pageFromTsv, straighten } = require("./ocrLines");
const ff = require("./ff"); // ffmpeg, from the renderer's package if it is installed

const run = promisify(execFile);
const MAX_PAGES = 400;
// Below this, what Tesseract read isn't a script we should put in front of a
// writer as theirs. (Clean scans score ~0.94–0.96; a sideways page ~0.3.)
const MIN_CONFIDENCE = 0.7;
const MIN_INK_PER_PAGE = 100;
// A page tilted more than this is turned upright and read again: Tesseract
// starts dropping short lines (character cues) past about two degrees.
const REREAD_TILT = 0.017; // radians, ≈ 1°

const has = (bin) => {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** Make sure the command-line tools exist; on a Linux runner, install them. */
function ensureTools(log) {
  const need = ["tesseract", "pdftoppm", "pdfimages", "pdfinfo"];
  let missing = need.filter((b) => !has(b));
  if (missing.length && process.platform === "linux") {
    log(`installing ${missing.join(", ")}`);
    execFileSync("sudo", ["apt-get", "update", "-qq"], { stdio: "ignore" });
    execFileSync("sudo", ["apt-get", "install", "-y", "-qq", "tesseract-ocr", "poppler-utils"], { stdio: "ignore" });
    missing = need.filter((b) => !has(b));
  }
  if (missing.length) throw new Error(`missing tools: ${missing.join(", ")}`);
}

/** Run `fn` over `items`, at most `limit` at a time, keeping order. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

async function pageCount(pdf) {
  const { stdout } = await run("pdfinfo", [pdf]);
  const m = /^Pages:\s+(\d+)/m.exec(stdout);
  if (!m) throw new Error("could not read the page count");
  return Number(m[1]);
}

/**
 * One image per page. A scan is usually exactly that inside the PDF already —
 * one photo per page — and lifting those out is near-instant and lossless.
 * Anything else (several images on a page, a rotated page, a PDF that is only
 * partly a scan) is rendered instead, which is slower but always right.
 */
async function pageImages(pdf, dir, pages, cpus, log) {
  try {
    const { stdout } = await run("pdfimages", ["-list", pdf], { maxBuffer: 16 * 1024 * 1024 });
    const rows = stdout
      .split("\n")
      .slice(2)
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c.length >= 14 && /^\d+$/.test(c[0]));
    const perPage = new Map();
    for (const c of rows) perPage.set(Number(c[0]), [...(perPage.get(Number(c[0])) || []), c]);
    const simple =
      rows.length === pages &&
      perPage.size === pages &&
      rows.every((c) => c[2] === "image" && Number(c[12]) >= 150 && Number(c[12]) <= 620 && Math.abs(Number(c[12]) - Number(c[13])) < 2);
    // A rotated page keeps its photo sideways inside the file; only rendering
    // turns it the right way up.
    const { stdout: info } = await run("pdfinfo", ["-f", "1", "-l", String(pages), pdf], { maxBuffer: 16 * 1024 * 1024 });
    const rotated = /Page\s+\d+\s+rot:\s+(?!0\b)\d+/.test(info);
    if (simple && !rotated) {
      // A scanner's JPEGs come out exactly as they went in: no decoding, no
      // re-compressing (re-saving them as PNG took 33 of the 41 seconds a
      // 30-page scan needed). Anything else is converted.
      const allJpeg = rows.every((c) => c[8] === "jpeg");
      await run("pdfimages", [allJpeg ? "-all" : "-png", pdf, path.join(dir, "img")], { maxBuffer: 16 * 1024 * 1024 });
      const files = fs.readdirSync(dir).filter((f) => /^img-\d+\.(jpg|png)$/.test(f)).sort();
      if (files.length === pages) {
        log(`lifted ${pages} page images straight out of the PDF${allJpeg ? " (as stored)" : ""}`);
        return files.map((f, i) => ({ file: path.join(dir, f), dpi: Number(rows[i][12]) }));
      }
    }
  } catch (err) {
    log(`fast path unavailable (${String(err.message || err).split("\n")[0].slice(0, 80)})`);
  }
  return await renderPages(pdf, dir, pages, cpus, log);
}

async function renderPages(pdf, dir, pages, cpus, log) {
  const DPI = 300;
  const chunk = Math.ceil(pages / Math.max(1, cpus));
  const ranges = [];
  for (let from = 1; from <= pages; from += chunk) ranges.push([from, Math.min(pages, from + chunk - 1)]);
  // JPEG, not PNG: compressing a 300 dpi page as PNG costs more than reading it.
  await pool(ranges, cpus, ([from, to]) =>
    run("pdftoppm", ["-r", String(DPI), "-gray", "-jpeg", "-jpegopt", "quality=92", "-f", String(from), "-l", String(to), pdf, path.join(dir, "ren")], {
      maxBuffer: 16 * 1024 * 1024,
    })
  );
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^ren-\d+\.jpg$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (files.length !== pages) throw new Error(`rendered ${files.length} of ${pages} pages`);
  log(`rendered ${pages} pages at ${DPI} dpi`);
  return files.map((f) => ({ file: path.join(dir, f), dpi: DPI }));
}

// Tesseract is built with OpenMP on Linux and will start a thread per core for
// each page. We already run one process per core, so that is cores² threads
// fighting over the same cores: on a 4-core GitHub runner the first real scan
// (30 pages) was still going after ten minutes, against 40 seconds locally.
// One thread per process, and the processes do the parallelism.
const TESSERACT_ENV = { ...process.env, OMP_THREAD_LIMIT: "1", OMP_NUM_THREADS: "1" };

async function tesseract(image) {
  const base = image.replace(/\.[a-z0-9]+$/i, "") + "-ocr";
  await run("tesseract", [image, base, "-l", "eng", "--psm", "6", "tsv"], { maxBuffer: 16 * 1024 * 1024, env: TESSERACT_ENV });
  const tsv = fs.readFileSync(`${base}.tsv`, "utf8");
  fs.rmSync(`${base}.tsv`, { force: true });
  return tsv;
}

/** Recognise every page; turn badly tilted ones upright and read them again. */
async function recognise(images, cpus, log) {
  const workers = Math.max(1, Math.min(cpus, 6));
  const pages = await pool(images, workers, async (img) => ({ ...img, tsv: await tesseract(img.file) }));
  if (!ff.available("ffmpeg")) return pages;
  let reread = 0;
  await pool(pages, workers, async (pg) => {
    const tilt = straighten(pageFromTsv(pg.tsv, pg.dpi));
    if (Math.abs(tilt) < REREAD_TILT) return;
    const upright = pg.file.replace(/\.[a-z0-9]+$/i, "-upright.png");
    try {
      await ff.run("ffmpeg", ["-loglevel", "error", "-y", "-i", pg.file, "-vf", `rotate=${tilt.toFixed(5)}:fillcolor=white`, upright]);
      const again = await tesseract(upright);
      // Keep the second reading only if it really is straighter.
      if (Math.abs(straighten(pageFromTsv(again, pg.dpi))) < Math.abs(tilt)) {
        pg.tsv = again;
        reread++;
      }
    } catch {
      /* keep the first reading */
    }
  });
  if (reread) log(`${reread} tilted page(s) turned upright and read again`);
  return pages;
}

/**
 * PDF file → lines + a quality report. No network, no project specifics: this
 * is the part a test can run against a synthetic scan.
 */
async function readPdf(pdf, workDir, log = () => {}) {
  ensureTools(log);
  const cpus = Math.max(1, os.cpus().length);
  const pages = await pageCount(pdf);
  if (pages > MAX_PAGES) throw Object.assign(new Error(`${pages} pages is more than we read as one script`), { code: "too_long" });

  const t0 = Date.now();
  let images = await pageImages(pdf, workDir, pages, cpus, log);
  const t1 = Date.now();
  let read = linesFromOcr(await recognise(images, cpus, log));
  log(`timing: page images ${Math.round((t1 - t0) / 1000)}s, recognition ${Math.round((Date.now() - t1) / 1000)}s on ${cpus} cores`);
  // Photos stored sideways or mirrored inside the PDF read as nonsense; a
  // render applies the page's own orientation. Worth one more try.
  if (read.quality.meanConfidence < MIN_CONFIDENCE && images[0] && /img-\d+\.[a-z]+$/.test(images[0].file)) {
    log(`first reading was poor (confidence ${read.quality.meanConfidence}); rendering the pages instead`);
    images = await renderPages(pdf, workDir, pages, cpus, log);
    read = linesFromOcr(await recognise(images, cpus, log));
  }
  return read;
}

async function api(url, serviceKey, init = {}) {
  return fetch(url, {
    ...init,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

/** The whole job for one script. Resolves with counts; rejects with a reason safe to log. */
async function readScan({ supabaseUrl, serviceKey, scriptId, log = console.log }) {
  const started = Date.now();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "prelogue-scan-"));
  const report = async (body) => {
    const res = await api(`${supabaseUrl}/functions/v1/parse-script`, serviceKey, { method: "POST", body: JSON.stringify({ script_id: scriptId, ...body }) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  try {
    const rowRes = await api(`${supabaseUrl}/rest/v1/scripts?id=eq.${encodeURIComponent(scriptId)}&select=id,file_url`, serviceKey);
    const row = (await rowRes.json().catch(() => []))[0];
    if (!row?.file_url) throw new Error("script not found");

    const fileRes = await api(`${supabaseUrl}/storage/v1/object/scripts/${row.file_url.split("/").map(encodeURIComponent).join("/")}`, serviceKey);
    if (!fileRes.ok) throw new Error(`download failed (HTTP ${fileRes.status})`);
    const pdf = path.join(workDir, "in.pdf");
    fs.writeFileSync(pdf, Buffer.from(await fileRes.arrayBuffer()));
    log(`downloaded ${(fs.statSync(pdf).size / 1048576).toFixed(1)} MB`);

    const read = await readPdf(pdf, workDir, log);
    const q = read.quality;
    log(`read ${read.pages} pages: ${q.rows} lines, confidence ${q.meanConfidence}, ${q.inkPerPageMedian} characters on a typical page, ${q.pagesStraightened} straightened (steepest ${q.steepestTiltDegrees}°)`);
    if (q.meanConfidence < MIN_CONFIDENCE || q.inkPerPageMedian < MIN_INK_PER_PAGE) {
      throw new Error(`the scan is too unclear to read reliably (confidence ${q.meanConfidence}, ${q.inkPerPageMedian} characters on a typical page)`);
    }

    const saved = await report({ lines: read.lines, pages: read.pages, source: "ocr", source_file: row.file_url, notify_writer: true });
    if (saved.body && saved.body.error === "superseded") {
      // The writer replaced the PDF while we were reading the old one.
      log("the file was replaced while it was being read; nothing saved");
      return { pages: read.pages, superseded: true, seconds: Math.round((Date.now() - started) / 1000) };
    }
    if (saved.status !== 200 || !saved.body.success) {
      throw new Error(`parse-script did not save it (HTTP ${saved.status}, ${saved.body.error || "no reason given"})`);
    }
    const result = { pages: read.pages, scenes: saved.body.scenes, elements: saved.body.elements, characters: saved.body.characters, confidence: q.meanConfidence, seconds: Math.round((Date.now() - started) / 1000) };
    log(`saved: ${result.scenes} scenes, ${result.elements} elements, ${result.characters} characters`);
    return result;
  } catch (err) {
    const reason = String((err && err.message) || err).split("\n")[0].slice(0, 300);
    // Tell parse-script, which tells the owner and stops the writer's page
    // from saying "still reading" forever.
    try {
      await report({ ocr_failed: reason });
    } catch {
      /* the stale-job check will catch it */
    }
    throw new Error(reason);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { readScan, readPdf };
