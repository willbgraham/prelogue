// Internal: read the text of a stored screenplay PDF, a time-boxed slice at a
// time. Called only by parse-script, never by a browser.
//
// WHY THIS IS ITS OWN FUNCTION
// An edge function gets 2 seconds of CPU, and an isolate stops taking new
// requests once it has used about half of that. Pulling text out of a PDF is
// the one CPU-heavy thing parsing does, and how heavy depends on how the PDF
// was made: a script saved with macOS "Print → Save as PDF" draws every letter
// separately and costs several times more than a normal export. Three ordinary
// feature scripts (108–145 pages) died that way with "CPU Time exceeded" and
// their writers were told the file "may be a scan".
//
// So this function never reads a whole document on trust. It reads pages until
// it has spent BOX_MS, then stops and says where it got to; parse-script calls
// again from there. A light PDF finishes in one call exactly as before; a heavy
// one takes a handful. No script is too long or too awkward to read, and
// because the heavy work lives here, parse-script's own isolate stays cool.
//
// Body:    { ticket, from? }      ticket: see _shared/extractTicket.ts
// Returns: { pages, from, next, lines: [text, x, edge?, gap?][], ink: number[], ms }
//          next = the page to ask for next, or null when the document is done
//          ink  = visible characters per page read (0 on a scanned page)
//      or  { error: "password_protected" | "not_a_pdf" | "download_failed" }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getDocumentProxy } from "https://esm.sh/unpdf@0.12.1";
import { inkChars, linesFromItems } from "../_shared/screenplay.ts";
import { verifyTicket } from "../_shared/extractTicket.ts";

// CPU budget for one call's page loop. With the fixed cost of a call (download,
// open the document) this keeps a slice near half a second, so even an isolate
// that accepts it just under its soft limit finishes well inside the hard one.
const BOX_MS = 400;
// CPU budget for the ISOLATE, across every call it serves. The platform counts
// CPU per isolate, not per request, and an isolate keeps accepting requests
// until it reaches its soft limit — so six uploads arriving together each get
// let in, and six private budgets add up to one dead isolate (seen in testing:
// every request in it fails at once). Once the isolate as a whole has spent
// this much, whatever is still reading finishes its current page and hands
// back what it has.
const ISOLATE_BURN_MS = 1_000;
// A call that arrives after the budget is spent still has to get somewhere:
// our clock runs on wall time, which on a busy host runs ahead of the CPU time
// the platform counts, so the isolate may not have been retired yet. It gets a
// short box — real progress, and real CPU that brings the retirement on — not
// a single page, which could string a long script out over a hundred calls.
const LATE_BOX_MS = 100;
// Rough CPU cost of a call outside the timed part (parsing the request,
// checking the ticket, copying the download, encoding the answer).
const CALL_OVERHEAD_MS = 40;
// Safety valve on response size for a document that is all text and no pages.
const MAX_CHARS = 1_500_000;

// How long this isolate has spent with at least one document open and being
// read. That work is pure CPU, so wall time while busy ≥ CPU spent; counting
// the union (not a sum per request) keeps overlapping requests from being
// counted twice.
let activeReads = 0;
let busySince = 0;
let burnedMs = 0;
let served = 0;
const isolateBurn = () =>
  burnedMs + (activeReads > 0 ? performance.now() - busySince : 0) + served * CALL_OVERHEAD_MS;
function readStarted() {
  served++;
  if (activeReads++ === 0) busySince = performance.now();
}
function readEnded() {
  if (--activeReads === 0) burnedMs += performance.now() - busySince;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const started = performance.now();

  try {
    const { ticket, from } = await req.json().catch(() => ({}));
    const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const path = await verifyTicket(ticket, secret);
    if (!path) return json({ error: "forbidden" }, 403);
    const first = Number.isInteger(from) && from >= 1 ? (from as number) : 1;

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, secret);
    const { data: file, error: downloadError } = await supabase.storage
      .from("scripts")
      .download(path);
    if (downloadError || !file) {
      console.error("extract: download failed:", downloadError?.message);
      return json({ error: "download_failed" });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());

    // deno-lint-ignore no-explicit-any
    let pdf: any = null;
    readStarted();
    try {
      try {
        pdf = await getDocumentProxy(bytes);
      } catch (err) {
        const name = (err as { name?: string } | null)?.name ?? "";
        const text = String(err);
        const locked = name === "PasswordException" || /password/i.test(text);
        return json({
          error: locked ? "password_protected" : "not_a_pdf",
          detail: text.slice(0, 200),
        });
      }

      const pages = pdf.numPages as number;
      // [text, x], and for a line at the top or bottom edge of its page a third
      // member: the page's number, negative at the bottom (Line.edge). A fourth
      // is the line's distance below the one above it (Line.gap); the third is
      // then 0 when the line is at no edge.
      const lines: ([string, number] | [string, number, number] | [string, number, number, number])[] = [];
      const ink: number[] = [];
      let next: number | null = null;
      let chars = 0;

      const loopStarted = performance.now();
      const late = isolateBurn() > ISOLATE_BURN_MS;
      const box = late ? LATE_BOX_MS : BOX_MS;
      for (let p = first; p <= pages; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        const pageLines = linesFromItems(content.items, p);
        ink.push(inkChars(pageLines));
        for (const l of pageLines) {
          lines.push(
            typeof l.gap === "number" ? [l.text, l.x, l.edge ?? 0, l.gap] : l.edge ? [l.text, l.x, l.edge] : [l.text, l.x]
          );
          chars += l.text.length;
        }
        page.cleanup?.();
        // Always finish at least one page per call, so progress is guaranteed.
        if (
          p < pages &&
          (performance.now() - loopStarted > box ||
            (!late && isolateBurn() > ISOLATE_BURN_MS) ||
            chars > MAX_CHARS)
        ) {
          next = p + 1;
          break;
        }
      }

      return json({
        pages,
        from: first,
        next,
        lines,
        ink,
        ms: Math.round(performance.now() - started),
      });
    } finally {
      // A warm isolate serves many slices; without this each one would keep
      // its copy of the file alive until the isolate ran out of memory.
      try {
        await pdf?.destroy?.();
      } catch {
        /* nothing to release */
      }
      readEnded();
    }
  } catch (err) {
    console.error("extract-script-text error:", err);
    return json({ error: "internal", detail: String(err).slice(0, 200) }, 500);
  }
});
