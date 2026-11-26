// Turn an uploaded screenplay PDF into scenes, characters and lines.
//
// Body:    { script_id, debug?, discard_if_unreadable? }
//            The stored file is a PDF, or pasted script text saved as .txt
//            (the fallback for a writer with no usable PDF).
//          { script_id, lines: [text, x][], pages, notify_writer? }   service
//            role / admin only: text already lifted off the pages by other
//            means (OCR of a scan). Skips extraction; everything after it is
//            the normal path. notify_writer emails them that it's ready.
//          { script_id, ocr_failed: reason }   service role only: the scan
//            reader gave up.
//          { script_id, action: "status" }     is a scan being read right now?
// Returns: { success: true, mode, pages, scenes, elements, dialogue, characters, … }
//      or  { error: "scanned_pdf", ocr: "reading", message, pages }   a scan,
//          handed to the scan reader; the writer is emailed when it's done
//      or  { error: <code>, message, ours, pages?, discarded? }   (HTTP 200 —
//          supabase-js hides the body of a non-2xx, and the message is the point)
//
// This function coordinates; it does not read the PDF itself. The CPU-heavy
// text extraction happens in extract-script-text, in time-boxed slices, because
// an edge function gets 2 seconds of CPU and some perfectly ordinary PDFs need
// more than that in one go (see that file's header). Here we collect the
// slices, classify the lines (cheap) and save.
//
// A failure is never silent:
//   • the caller gets a code and a plain-English reason — a scan, a password,
//     or "our side", which are three different things to tell a writer;
//   • the owner gets an email, so a customer who hit a wall is known about the
//     same minute rather than found in the logs days later.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isServiceRole } from "../_shared/serviceRole.ts";
import { type Line, linesFromItems, linesFromText, inkChars, parseLines, parseText } from "../_shared/screenplay.ts";
import { signTicket } from "../_shared/extractTicket.ts";
import { sendEmail } from "../_shared/sendEmail.ts";
import { brandEmail, esc } from "../_shared/brandEmail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EXTRACT_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/extract-script-text`;
// Where "an upload couldn't be read" notices go. Same inbox as the contact form.
const ALERT_TO = Deno.env.get("ALERT_TO") ?? Deno.env.get("CONTACT_TO") ?? "hello@prelogue.studio";

const MAX_PAGES = 400;
// Function-to-function calls are capped at 30 per request chain per minute;
// past that the platform says how long to wait and we do, so the real bound is
// the deadline below. This only stops a slice loop that isn't getting anywhere.
const MAX_SLICES = 60;
// The gateway gives up on a silent request at 150s; answer well before that.
const DEADLINE_MS = 110_000;
const SLICE_ATTEMPTS = 5;
// A real script page carries 500–1,500 visible characters. A scanned page
// carries none, or a scanner's one-line stamp.
const PAGE_HAS_TEXT = 20;
const SCAN_MEDIAN_INK = 100;
const SCAN_TOTAL_INK = 200;
// discard_if_unreadable only ever removes an upload that is this fresh.
const DISCARD_WINDOW_MS = 30 * 60_000;

// ---- Scans ---------------------------------------------------------------
// A scanned PDF has no text to extract. Instead of turning the writer away, we
// hand it to the scan reader: a job on the render worker (GitHub Actions, the
// same one that makes exports) that runs OCR and posts the lines back here.
// It takes a few minutes, so the writer is told and emailed when it's done.
const SITE = "https://prelogue.studio";
const GH_API = Deno.env.get("GH_API_BASE") ?? "https://api.github.com";
// A reading that hasn't reported back in this long has died.
const SCAN_STALE_MS = 30 * 60_000;
// Scan readings one writer may start in a day (each is minutes of compute).
const SCAN_DAILY_CAP = 6;
// Past this size a PDF is all but certainly a scan — and the page reader would
// need more memory than it has to find that out (a 36 MB scan took 165 MB of
// its 256). Send it straight to the scan reader.
const BIG_FILE_BYTES = 40 * 1024 * 1024;
const READING_MESSAGE =
  "This PDF is a scan, so we're reading the pages with text recognition. It usually takes about five minutes. We'll email you when your script is ready.";

type ScanJob = {
  state: "reading" | "done" | "failed";
  started_at: string;
  finished_at?: string;
  pages?: number;
  detail?: string;
};
// Job notes live in the private bucket, outside every writer's own folder, so
// only the service role can read or write them. One small file per script.
const jobPath = (writerId: string, scriptId: string) => `ocr-jobs/${writerId}/${scriptId}.json`;

// deno-lint-ignore no-explicit-any
async function readJob(supabase: any, writerId: string, scriptId: string): Promise<ScanJob | null> {
  try {
    const { data, error } = await supabase.storage.from("scripts").download(jobPath(writerId, scriptId));
    if (error || !data) return null;
    const job = JSON.parse(await data.text());
    return job && typeof job.state === "string" ? (job as ScanJob) : null;
  } catch {
    return null;
  }
}

// deno-lint-ignore no-explicit-any
async function writeJob(supabase: any, writerId: string, scriptId: string, job: ScanJob): Promise<boolean> {
  const { error } = await supabase.storage
    .from("scripts")
    .upload(jobPath(writerId, scriptId), JSON.stringify(job), { contentType: "application/json", upsert: true });
  if (error) console.error("scan job note not saved:", error.message);
  return !error;
}

/** Is a reading in flight for this script? A stale one counts as dead. */
function stillReading(job: ScanJob | null): boolean {
  return !!job && job.state === "reading" && Date.now() - new Date(job.started_at).getTime() < SCAN_STALE_MS;
}

/** Ask the render worker to read a scan. Resolves with why not, if not. */
async function dispatchScanReader(scriptId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const ghPat = Deno.env.get("GH_PAT");
  if (!ghPat) return { ok: false, reason: "no GH_PAT configured" };
  const repo = Deno.env.get("GH_REPO") || "willbgraham/prelogue";
  try {
    const res = await fetch(`${GH_API}/repos/${repo}/actions/workflows/render-one.yml/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ghPat}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "prelogue-scan-reader",
      },
      body: JSON.stringify({ ref: "main", inputs: { script_id: scriptId, variant: "ocr" } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 204) return { ok: true };
    try {
      await res.body?.cancel();
    } catch {
      /* nothing to drain */
    }
    return { ok: false, reason: `the worker answered HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: String(err).slice(0, 120) };
  }
}

/**
 * Start reading a scan, unless one is already being read or the writer has
 * started too many today.
 */
async function startScanReading(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  writerId: string,
  scriptId: string,
  pages: number | undefined
): Promise<{ started: true } | { started: false; reason: string }> {
  if (stillReading(await readJob(supabase, writerId, scriptId))) return { started: true };
  const { data: notes } = await supabase.storage.from("scripts").list(`ocr-jobs/${writerId}`, { limit: 100 });
  const dayAgo = Date.now() - 24 * 3600_000;
  const today = (notes ?? []).filter(
    // deno-lint-ignore no-explicit-any
    (n: any) => new Date(n.updated_at ?? n.created_at ?? 0).getTime() > dayAgo
  ).length;
  if (today >= SCAN_DAILY_CAP) return { started: false, reason: `${today} scans already read for this writer today` };
  const sent = await dispatchScanReader(scriptId);
  if (!sent.ok) return { started: false, reason: sent.reason };
  // The worker is on its way either way; the note is what the writer's page reads.
  await writeJob(supabase, writerId, scriptId, { state: "reading", started_at: new Date().toISOString(), pages });
  return { started: true };
}

/** How big is the stored file? null if we can't tell. */
// deno-lint-ignore no-explicit-any
async function storedSize(supabase: any, fileUrl: string): Promise<number | null> {
  try {
    const cut = fileUrl.lastIndexOf("/");
    const { data } = await supabase.storage
      .from("scripts")
      .list(cut > 0 ? fileUrl.slice(0, cut) : "", { search: fileUrl.slice(cut + 1), limit: 5 });
    // deno-lint-ignore no-explicit-any
    const hit = (data ?? []).find((o: any) => o.name === fileUrl.slice(cut + 1));
    const size = Number(hit?.metadata?.size);
    return Number.isFinite(size) ? size : null;
  } catch {
    return null;
  }
}

type FailCode =
  | "scanned_pdf"
  | "password_protected"
  | "not_a_pdf"
  | "too_long"
  | "empty_script"
  | "empty_text"
  | "extract_failed"
  | "save_failed";

// KEEP IN STEP with apps/web/lib/parseErrors.ts, which words these for the site.
const FAILS: Record<FailCode, { ours: boolean; message: string }> = {
  scanned_pdf: {
    ours: false,
    message:
      "This PDF is a scan: pictures of the pages, with no text in it for the voices to read. Export a PDF straight from your writing app and upload that instead.",
  },
  password_protected: {
    ours: false,
    message:
      "This PDF is password-protected, so we can't open it. Save a copy without the password and upload that.",
  },
  not_a_pdf: {
    ours: false,
    message:
      "That file isn't a PDF we can open. Export your script as a PDF from your writing app and try again.",
  },
  too_long: {
    ours: false,
    message: `That file is longer than ${MAX_PAGES} pages, which is more than we can read as one script.`,
  },
  empty_script: {
    ours: false,
    message:
      "We opened the PDF but couldn't find any script text in it. Check it's the right file, then export it again from your writing app.",
  },
  empty_text: {
    ours: false,
    message:
      "We couldn't find a script in that text. Paste the whole script, with each character's name in capitals on its own line and what they say underneath.",
  },
  extract_failed: {
    ours: true,
    message:
      "Something went wrong on our side while reading this PDF. Your file is fine, and we've been alerted. Please try again in a few minutes.",
  },
  save_failed: {
    ours: true,
    message:
      "We read your script but couldn't save it. That's on our side, and we've been alerted. Please try again in a few minutes.",
  },
};

type Extracted =
  | { ok: true; lines: Line[]; pages: number; ink: number[]; slices: number; via: "slices" | "inline" | "supplied" | "text" }
  | { ok: false; code: FailCode; detail?: string; pages?: number };

// Bounds on text handed to us instead of extracted by us.
const MAX_SUPPLIED_LINES = 80_000;
const MAX_SUPPLIED_CHARS = 3_000_000;

/** Validate caller-supplied lines ([text, x] pairs) into the shape extraction produces. */
function suppliedLines(raw: unknown, rawPages: unknown): Extracted | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SUPPLIED_LINES) return null;
  const pages = Number.isInteger(rawPages) && (rawPages as number) > 0 ? (rawPages as number) : 0;
  if (!pages) return null;
  const lines: Line[] = [];
  let chars = 0;
  for (const item of raw) {
    if (!Array.isArray(item) || typeof item[0] !== "string" || typeof item[1] !== "number" || !Number.isFinite(item[1])) {
      return null;
    }
    chars += item[0].length;
    if (chars > MAX_SUPPLIED_CHARS) return null;
    lines.push({ text: item[0], x: item[1] });
  }
  if (pages > MAX_PAGES) return { ok: false, code: "too_long", pages };
  // No per-page breakdown comes with supplied text; spread it evenly so the
  // "is there any text here at all" check still means something.
  const total = inkChars(lines);
  return { ok: true, lines, pages, ink: Array.from({ length: pages }, () => Math.round(total / pages)), slices: 0, via: "supplied" };
}

// A script pasted as text is stored as a .txt (or uploaded as .fountain).
const TEXT_FILE_RE = /\.(txt|fountain)$/i;
// A long feature is ~200,000 characters; this is room for five.
const MAX_TEXT_BYTES = 1_000_000;

/** Read a stored text file into lines. Cheap enough to do here: no page reader. */
// deno-lint-ignore no-explicit-any
async function readTextFile(path: string, supabase: any): Promise<Extracted> {
  const { data: file, error } = await supabase.storage.from("scripts").download(path);
  if (error || !file) return { ok: false, code: "extract_failed", detail: "text: download failed" };
  if (file.size > MAX_TEXT_BYTES) return { ok: false, code: "too_long", detail: `${file.size} bytes of text` };
  const read = linesFromText(await file.text());
  if (read.pages > MAX_PAGES) return { ok: false, code: "too_long", pages: read.pages };
  return { ok: true, lines: read.lines, pages: read.pages, ink: read.inkByPage, slices: 0, via: "text" };
}

type SliceBody = {
  error?: string;
  detail?: string;
  pages?: number;
  next?: number | null;
  /** [text, x], with a third member for a line at the edge of its page (Line.edge)
   *  and a fourth for its distance below the line above it (Line.gap). */
  lines?: ([string, number] | [string, number, number] | [string, number, number, number])[];
  ink?: number[];
};

/** One call to extract-script-text, retried when the failure looks transient. */
async function callSlice(
  headers: Record<string, string>,
  ticket: string,
  from: number,
  deadline: number
): Promise<{ ok: true; body: SliceBody } | { ok: false; detail: string; unreachable: boolean }> {
  let detail = "";
  let unreachable = false;
  let refusals = 0;
  // Five tries: an isolate that hits its CPU soft limit while several uploads
  // are being read at once can drop a request it had already accepted. The
  // next try lands on a fresh isolate, so patience is all this needs.
  for (let attempt = 1; attempt <= SLICE_ATTEMPTS; attempt++) {
    const left = deadline - Date.now();
    if (left < 2_000) {
      detail = detail || "out of time";
      unreachable = false;
      break;
    }
    unreachable = false;
    try {
      const res = await fetch(EXTRACT_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ ticket, from }),
        signal: AbortSignal.timeout(Math.min(45_000, left)),
      });
      if (res.ok) return { ok: true, body: (await res.json()) as SliceBody };
      detail = `HTTP ${res.status}`;
      try {
        await res.body?.cancel();
      } catch {
        /* already consumed */
      }
      // The gateway refusing us (function missing, auth) is not something
      // retries fix, so three tries settle it; a worker that died (546) or
      // hiccuped (5xx) gets the full count.
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        unreachable = true;
        if (++refusals >= 3) break;
      }
    } catch (err) {
      detail = String(err).slice(0, 200);
      // The platform's nested-call rate limit says how long to wait.
      const retryAfter = (err as { retryAfterMs?: number } | null)?.retryAfterMs;
      if (typeof retryAfter === "number") {
        await sleep(Math.max(0, Math.min(retryAfter, deadline - Date.now() - 5_000)));
        continue;
      }
      // Only a connection that couldn't be made counts as "can't reach it".
      // A timeout or a garbled answer means it was there and struggling.
      unreachable = err instanceof TypeError;
    }
    // Back off further each time, at a random point in the window, so uploads
    // that failed together don't all come back together.
    if (attempt < SLICE_ATTEMPTS) await sleep(150 + Math.floor(Math.random() * 350 * 2 ** (attempt - 1)));
  }
  return { ok: false, detail, unreachable };
}

/**
 * Last resort: read the whole PDF here, in one pass, the way this function did
 * before extraction moved out. Used only when extract-script-text cannot be
 * reached at all, so a broken deploy degrades to "works for most scripts"
 * instead of "works for none".
 */
// deno-lint-ignore no-explicit-any
async function extractInline(path: string, supabase: any): Promise<Extracted> {
  try {
    const { data: file, error } = await supabase.storage.from("scripts").download(path);
    if (error || !file) return { ok: false, code: "extract_failed", detail: "inline: download failed" };
    const { getDocumentProxy } = await import("https://esm.sh/unpdf@0.12.1");
    // deno-lint-ignore no-explicit-any
    let pdf: any;
    try {
      pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
    } catch (err) {
      const locked =
        (err as { name?: string } | null)?.name === "PasswordException" || /password/i.test(String(err));
      return { ok: false, code: locked ? "password_protected" : "not_a_pdf", detail: String(err).slice(0, 200) };
    }
    const pages = pdf.numPages as number;
    if (pages > MAX_PAGES) return { ok: false, code: "too_long", pages };
    const lines: Line[] = [];
    const ink: number[] = [];
    for (let p = 1; p <= pages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const pageLines = linesFromItems(content.items, p);
      ink.push(inkChars(pageLines));
      for (const l of pageLines) lines.push(l);
    }
    return { ok: true, lines, pages, ink, slices: 1, via: "inline" };
  } catch (err) {
    return { ok: false, code: "extract_failed", detail: `inline: ${String(err).slice(0, 200)}` };
  }
}

/** Collect every page's lines from extract-script-text, a slice at a time. */
// deno-lint-ignore no-explicit-any
async function extractText(path: string, req: Request, supabase: any): Promise<Extracted> {
  const ticket = await signTicket(path, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  // Forward the caller's own credentials: they just passed the gateway on the
  // way in, so they pass it again on the way to the sibling function.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = req.headers.get("Authorization");
  if (auth) headers.Authorization = auth;
  const apikey = req.headers.get("apikey") ?? Deno.env.get("SUPABASE_ANON_KEY");
  if (apikey) headers.apikey = apikey;

  const lines: Line[] = [];
  const ink: number[] = [];
  let from = 1;
  let pages = 0;
  let slices = 0;
  const deadline = Date.now() + DEADLINE_MS;

  while (true) {
    const r = await callSlice(headers, ticket, from, deadline);
    if (!r.ok) {
      if (slices === 0 && r.unreachable) {
        console.error(`extract-script-text unreachable (${r.detail}); reading inline`);
        return await extractInline(path, supabase);
      }
      return { ok: false, code: "extract_failed", detail: `page ${from}: ${r.detail}`, pages };
    }
    const b = r.body;
    if (b.error) {
      if (b.error === "password_protected" || b.error === "not_a_pdf") {
        return { ok: false, code: b.error, detail: b.detail };
      }
      return { ok: false, code: "extract_failed", detail: `page ${from}: ${b.error} ${b.detail ?? ""}`.trim(), pages };
    }
    if (typeof b.pages !== "number" || !Array.isArray(b.lines) || !Array.isArray(b.ink)) {
      return { ok: false, code: "extract_failed", detail: `page ${from}: malformed slice`, pages };
    }
    slices++;
    pages = b.pages;
    if (pages > MAX_PAGES) return { ok: false, code: "too_long", pages };
    // A third member marks a line at the top or bottom edge of its page
    // (Line.edge), a fourth is its distance below the line above (Line.gap);
    // a reader from before either was sent simply has none.
    for (const [text, x, edge, gap] of b.lines) {
      const line: Line = typeof edge === "number" && Number.isInteger(edge) && edge !== 0 ? { text, x, edge } : { text, x };
      if (typeof gap === "number" && Number.isFinite(gap)) line.gap = gap;
      lines.push(line);
    }
    for (const n of b.ink) ink.push(n);

    if (b.next == null) break;
    if (!(b.next > from)) {
      return { ok: false, code: "extract_failed", detail: `page ${from}: no progress`, pages };
    }
    from = b.next;
    if (slices >= MAX_SLICES) {
      return { ok: false, code: "extract_failed", detail: `gave up after ${slices} slices at page ${from} of ${pages}`, pages };
    }
  }

  // Every page read exactly once, or the result can't be trusted.
  if (ink.length !== pages) {
    return { ok: false, code: "extract_failed", detail: `read ${ink.length} of ${pages} pages`, pages };
  }
  return { ok: true, lines, pages, ink, slices, via: "slices" };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Hand a promise to the runtime to finish after the response has gone out. */
function inBackground(work: Promise<unknown>) {
  const guarded = work.catch((err) => console.error("background task failed:", err));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(guarded);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const {
      script_id,
      debug,
      discard_if_unreadable,
      lines: givenLines,
      pages: givenPages,
      notify_writer,
      source_file,
      ocr_failed,
      action,
    } = await req.json();
    if (!script_id) return json({ error: "script_id required" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: script, error: scriptError } = await supabase
      .from("scripts")
      .select("id, title, file_url, writer_id, created_at, full_read_unlocked")
      .eq("id", script_id)
      .single();

    if (scriptError || !script) return json({ error: "Script not found" }, 404);

    // Parsing rewrites parsed_json/characters and (with debug) echoes raw
    // script text, so only the script's writer, an admin, or the service role
    // may run it. Previously unauthenticated — private-script text leak.
    const isService = isServiceRole(req.headers.get("Authorization"));
    let isAdmin = false;
    let callerId: string | null = null;
    if (!isService) {
      const {
        data: { user: caller },
      } = await createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } }
      ).auth.getUser();
      callerId = caller?.id ?? null;
      if (callerId) {
        const { data: me } = await supabase
          .from("users")
          .select("is_admin")
          .eq("id", callerId)
          .single();
        isAdmin = !!me?.is_admin;
      }
      if (!callerId || (callerId !== script.writer_id && !isAdmin)) {
        return json({ error: "forbidden" }, 403);
      }
    }
    const allowDebug = !!debug && (isService || isAdmin);

    /**
     * Tell the owner an upload couldn't be read. Never on a debug run (that's
     * us looking), never blocking the writer's response, never throwing.
     */
    const alertOwner = (what: string, detail: string, told: string | null) => {
      if (allowDebug) return;
      inBackground(
        (async () => {
          // Each lookup stands alone: a notice with a blank in it still beats
          // no notice because one lookup threw.
          let writer: { display_name?: string | null; plan?: string | null; plan_status?: string | null } | null = null;
          let email = "";
          try {
            const { data } = await supabase
              .from("users")
              .select("display_name, plan, plan_status")
              .eq("id", script.writer_id)
              .single();
            writer = data;
          } catch (err) {
            console.error("parse alert: writer lookup failed:", String(err).slice(0, 120));
          }
          try {
            const { data } = await supabase.auth.admin.getUserById(script.writer_id);
            email = data?.user?.email ?? "";
          } catch (err) {
            console.error("parse alert: email lookup failed:", String(err).slice(0, 120));
          }
          const plan = writer?.plan && writer.plan !== "free" ? `${writer.plan} (${writer.plan_status ?? "?"})` : "free";
          const rows: [string, string][] = [
            ["What happened", what],
            ["Script", `${script.title ?? "(untitled)"}`],
            ["Writer", `${writer?.display_name ?? "(no name)"}${email ? ` · ${email}` : ""}`],
            ["Plan", plan],
            ["Detail", detail],
            ["What they were told", told ?? "Nothing: the upload went through."],
            ["Script id", String(script_id)],
            ["File", String(script.file_url)],
          ];
          const html =
            `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#2A2420">` +
            `<p style="margin:0 0 12px"><strong>A writer's upload needs a look.</strong></p>` +
            `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse">` +
            rows
              .map(
                ([k, v]) =>
                  `<tr><td style="padding:4px 14px 4px 0;color:#8A7F73;vertical-align:top;white-space:nowrap">${esc(k)}</td>` +
                  `<td style="padding:4px 0;vertical-align:top">${esc(v)}</td></tr>`
              )
              .join("") +
            `</table></div>`;
          const sent = await sendEmail({
            to: ALERT_TO,
            subject: `Upload needs a look: ${what}`,
            html,
            replyTo: email || undefined,
            tag: "parse-alert",
          });
          console.log(`parse alert (${what}): ${sent.sent ? "sent" : `NOT sent: ${sent.reason}`}`);
        })()
      );
    };

    /** Answer a failed parse: code + reason to the caller, a notice to the owner. */
    const fail = async (code: FailCode, detail: string, pages?: number) => {
      const f = FAILS[code];
      // An upload nobody can use shouldn't sit in the writer's studio as a
      // script that never plays. Only on request, only for a problem with the
      // file itself (never one of ours — we need that file to find our bug),
      // and only for an upload so fresh it can't be anything but this attempt.
      let discarded = false;
      const fresh = Date.now() - new Date(script.created_at as string).getTime() < DISCARD_WINDOW_MS;
      if (discard_if_unreadable && !f.ours && fresh && !script.full_read_unlocked && !allowDebug) {
        const { error: delErr } = await supabase.from("scripts").delete().eq("id", script_id);
        if (!delErr) {
          discarded = true;
          await supabase.storage.from("scripts").remove([script.file_url as string]);
        } else {
          console.error("discard failed:", delErr.message);
        }
      }
      console.error(`parse failed [${code}] script=${script_id} pages=${pages ?? "?"} ${detail}`);
      alertOwner(
        `${code.replaceAll("_", " ")}${pages ? `, ${pages} pages` : ""}`,
        `${detail}${discarded ? " · The unusable upload was removed from their studio." : ""}`,
        f.message
      );
      return json({ error: code, message: f.message, ours: f.ours, pages, discarded });
    };

    const writerId = script.writer_id as string;
    // "It's a scan, and it's being read": still an error to a client that
    // doesn't know about scan reading, a pending state to one that does.
    const readingReply = (pageCount?: number) =>
      json({ error: "scanned_pdf", ocr: "reading", message: READING_MESSAGE, ours: false, pages: pageCount, discarded: false });

    // ---- Is a scan being read? (the writer's script page asks) ---------------
    if (action === "status") {
      const job = await readJob(supabase, writerId, script_id);
      if (!job) return json({ ocr: "none" });
      // A reading that never reported back is a failure the writer should see
      // as one, not a spinner that turns forever.
      const state = job.state === "reading" && !stillReading(job) ? "failed" : job.state;
      return json({ ocr: state, started_at: job.started_at, pages: job.pages ?? null });
    }

    // ---- The scan reader gave up ---------------------------------------------
    if (ocr_failed !== undefined) {
      if (!isService) return json({ error: "forbidden" }, 403);
      const reason = String(ocr_failed).slice(0, 300);
      const job = await readJob(supabase, writerId, script_id);
      await writeJob(supabase, writerId, script_id, {
        state: "failed",
        started_at: job?.started_at ?? new Date().toISOString(),
        finished_at: new Date().toISOString(),
        pages: job?.pages,
        detail: reason,
      });
      console.error(`scan reading failed script=${script_id} ${reason}`);
      alertOwner(
        "a scan could not be read automatically",
        reason,
        "Their script page says we couldn't read the scan automatically, that we've been alerted, and offers a different PDF."
      );
      return json({ ok: true });
    }

    // ---- 1. Text out of the PDF ---------------------------------------------
    const started = Date.now();
    let ext: Extracted;
    // A file this large goes straight to the scan reader (see BIG_FILE_BYTES).
    // If that can't be started, carry on and let the page reader try.
    const isTextFile = TEXT_FILE_RE.test(String(script.file_url));
    if (givenLines === undefined && !allowDebug && !isTextFile) {
      const size = await storedSize(supabase, script.file_url as string);
      if (size !== null && size > BIG_FILE_BYTES) {
        const scan = await startScanReading(supabase, writerId, script_id, undefined);
        if (scan.started) return readingReply();
        console.error(`large file (${Math.round(size / 1048576)} MB) not sent to the scan reader: ${scan.reason}`);
      }
    }
    if (givenLines !== undefined) {
      // Text read off the pages by other means. Ours to supply, not a
      // browser's: it replaces what the PDF says.
      if (!isService && !isAdmin) return json({ error: "forbidden" }, 403);
      // The scan reader takes minutes. If the writer swapped in a different
      // PDF meanwhile, what it read is yesterday's file: don't let it replace
      // the script they have now.
      if (typeof source_file === "string" && source_file !== script.file_url) {
        console.log(`scan result ignored script=${script_id}: the file was replaced while it was being read`);
        return json({ error: "superseded", message: "The file was replaced while it was being read." });
      }
      const supplied = suppliedLines(givenLines, givenPages);
      if (!supplied) return json({ error: "lines must be [text, x] pairs, with a page count" }, 400);
      ext = supplied;
    } else if (isTextFile) {
      ext = await readTextFile(script.file_url as string, supabase);
    } else {
      ext = await extractText(script.file_url as string, req, supabase);
    }
    if (!ext.ok) {
      if (allowDebug) return json({ debug: true, error: ext.code, detail: ext.detail, pages: ext.pages });
      return await fail(ext.code, ext.detail ?? "", ext.pages);
    }
    const { lines, pages, ink } = ext;
    const totalInk = ink.reduce((a, b) => a + b, 0);
    const textPages = ink.filter((n) => n >= PAGE_HAS_TEXT).length;
    const imagePages = pages - textPages;
    const scanned = totalInk < SCAN_TOTAL_INK || median(ink) < SCAN_MEDIAN_INK;

    // ---- 2. Lines into scenes -------------------------------------------------
    const parsed = scanned ? null : ext.via === "text" ? parseText(lines) : parseLines(lines);

    // Debug mode: inspect extraction without writing to the DB (echoes raw
    // script text, so admin/service-role only).
    if (allowDebug) {
      return json({
        debug: true,
        via: ext.via,
        slices: ext.slices,
        ms: Date.now() - started,
        pages,
        textPages,
        imagePages,
        totalInk,
        scanned,
        mode: parsed?.mode ?? null,
        grid: parsed?.grid ?? null,
        // Lines taken out as running heads or feet ("MY TITLE • 12" on every page).
        runningHeads: parsed?.runningHeads ?? 0,
        totalLines: lines.length,
        scenes: parsed?.scenes.length ?? 0,
        totalElements: parsed?.totalElements ?? 0,
        elementCounts: parsed?.counts ?? null,
        characters: parsed?.characters.map((c) => c.name) ?? [],
        sampleLines: lines.slice(0, 70).map((l) => ({ x: Math.round(l.x), text: l.text })),
        sampleElements: parsed?.scenes.flatMap((s) => s.elements).slice(0, 30) ?? [],
      });
    }

    if (scanned || !parsed) {
      const what = `${textPages} of ${pages} pages have text (${totalInk} characters in all)`;
      // Pasted text with next to nothing in it isn't a scan; say what it is.
      if (ext.via === "text") return await fail("empty_text", `${totalInk} characters of pasted text`, pages);
      // Text we were handed that still isn't a script: nothing more to try.
      if (ext.via === "supplied") return await fail("scanned_pdf", what, pages);
      const scan = await startScanReading(supabase, writerId, script_id, pages);
      if (scan.started) {
        console.log(`scan handed to the reader script=${script_id} pages=${pages}`);
        return readingReply(pages);
      }
      return await fail("scanned_pdf", `${what} · automatic reading not started: ${scan.reason}`, pages);
    }
    if (parsed.totalElements === 0) {
      return await fail(ext.via === "text" ? "empty_text" : "empty_script", `${totalInk} characters of text but nothing readable as a script`, pages);
    }

    // ---- 3. Save ----------------------------------------------------------------
    const parsedCharacters = parsed.characters.slice(0, 30);
    const parsedJson = { scenes: parsed.scenes, characters: parsedCharacters };

    const { error: saveErr } = await supabase
      .from("scripts")
      .update({ parsed_json: parsedJson })
      .eq("id", script_id);
    if (saveErr) return await fail("save_failed", saveErr.message, pages);
    // Best-effort page count in a SEPARATE statement, so a missing column (e.g.
    // before the listing-metadata migration runs) can't block the critical
    // parsed_json write. The returned error is intentionally ignored.
    await supabase.from("scripts").update({ page_count: pages }).eq("id", script_id);

    // Idempotent, non-destructive character insert (don't delete — that would
    // cascade-delete actor submissions). One line is enough to register: a
    // character who speaks once still needs to exist to be castable.
    const topChars = parsedCharacters.filter((c) => c.line_count >= 1).slice(0, 24);
    const { data: existingChars } = await supabase
      .from("characters")
      .select("name")
      .eq("script_id", script_id);
    // deno-lint-ignore no-explicit-any
    const existingNames = new Set((existingChars || []).map((c: any) => c.name));
    const toInsert = topChars.filter((c) => !existingNames.has(c.name));

    if (toInsert.length > 0) {
      await supabase.from("characters").insert(
        toInsert.map((c) => ({
          script_id,
          name: c.name,
          description: null,
          line_count: c.line_count,
        }))
      );
    }
    for (const c of topChars) {
      if (existingNames.has(c.name)) {
        await supabase
          .from("characters")
          .update({ line_count: c.line_count })
          .eq("script_id", script_id)
          .eq("name", c.name);
      }
    }

    // Read from the PDF's own text while a scan reading was still open (the
    // writer replaced a scan with a proper PDF): that job no longer matters,
    // and the script page must stop saying "reading".
    if (ext.via !== "supplied") {
      const open = await readJob(supabase, writerId, script_id);
      if (open && open.state === "reading") {
        await writeJob(supabase, writerId, script_id, { ...open, state: "done", finished_at: new Date().toISOString(), detail: "replaced by a readable PDF" });
      }
    }

    // Text that came from the scan reader: close the job and tell the writer.
    if (ext.via === "supplied" && notify_writer === true && isService) {
      const job = await readJob(supabase, writerId, script_id);
      await writeJob(supabase, writerId, script_id, {
        state: "done",
        started_at: job?.started_at ?? new Date().toISOString(),
        finished_at: new Date().toISOString(),
        pages,
      });
      inBackground(
        (async () => {
          let to = "";
          try {
            const { data } = await supabase.auth.admin.getUserById(writerId);
            to = data?.user?.email ?? "";
          } catch (err) {
            console.error("scan ready: email lookup failed:", String(err).slice(0, 120));
          }
          if (!to) return console.log("scan ready: writer has no email; nothing sent");
          const title = String(script.title ?? "Your script");
          const sent = await sendEmail({
            to,
            subject: `"${title}" is ready to cast and play`,
            html: brandEmail({
              heading: "Your script is ready",
              bodyHtml:
                `<p style="margin:0 0 14px;">We've finished reading the scanned pages of <strong>${esc(title)}</strong>. It's in your studio, ready to cast and play.</p>` +
                `<p style="margin:0 0 14px;">Because it came from a scan, a few words may be slightly off. You can fix any line under <strong>Edit lines</strong> on the script's page.</p>`,
              cta: { label: "Open your studio", url: `${SITE}/studio` },
              footnote: "You're receiving this because you uploaded a scanned script on prelogue.studio.",
            }),
            tag: "scan-ready",
          });
          console.log(`scan ready email: ${sent.sent ? "sent" : `NOT sent: ${sent.reason}`}`);
        })()
      );
    }

    // Things that worked but the owner should still hear about.
    if (ext.via === "inline") {
      alertOwner(
        "the page reader was unreachable",
        "parse-script fell back to reading the PDF in one pass. This upload worked, but long or print-to-PDF scripts will fail until extract-script-text is reachable again.",
        null
      );
    } else if (imagePages / pages > 0.25) {
      alertOwner(
        `${imagePages} of ${pages} pages are images`,
        "Those pages have no text and are skipped in the read. The rest of the script parsed normally.",
        null
      );
    }

    return json({
      success: true,
      mode: parsed.mode,
      pages,
      image_pages: imagePages,
      scenes: parsed.scenes.length,
      elements: parsed.totalElements,
      running_heads: parsed.runningHeads ?? 0,
      dialogue: parsed.counts.dialogue,
      characters: topChars.length,
      character_names: topChars.map((c) => c.name),
      slices: ext.slices,
      via: ext.via,
      ms: Date.now() - started,
    });
  } catch (err) {
    console.error("Parse error:", err);
    return json({ error: "Internal error", details: String(err) }, 500);
  }
});
