import type { SupabaseClient } from "@supabase/supabase-js";

/** Largest file the scripts bucket accepts. */
export const MAX_SCRIPT_BYTES = 50 * 1024 * 1024;

export const HELP_EMAIL = "hello@prelogue.studio";

export type ParseFailure = {
  ok: false;
  code: string;
  /** Plain-English reason, ready to show the writer. */
  message: string;
  /** True when the failure is on our side: the writer's file is fine. */
  ours: boolean;
  /** True when the server already removed the unusable upload. */
  discarded: boolean;
  /**
   * True when the PDF is a scan and is being read in the background: not a
   * failure to report, a wait. The writer is emailed when it's ready.
   */
  reading?: boolean;
};
export type ParseOutcome =
  | { ok: true; pages: number | null; imagePages: number }
  | ParseFailure;

// What a writer can fix themselves, by failure code. KEEP IN STEP with FAILS in
// supabase/functions/parse-script/index.ts — the codes are the contract; the
// wording here is the site's (it can say more than the function's fallback).
const FIXABLE: Record<string, string> = {
  scanned_pdf: `This PDF is a scan: pictures of the pages, with no text in it for the voices to read. Open the script in the app you wrote it in (Final Draft, Fade In, WriterDuet, Highland and so on), export it as a PDF, and upload that. If a scan is all you have, email ${HELP_EMAIL} and we'll help.`,
  password_protected:
    "This PDF is password-protected, so we can't open it. Save a copy without the password and upload that.",
  not_a_pdf:
    "That file isn't a PDF we can open. Export your script as a PDF from your writing app and try again.",
  too_long: `That file is longer than 400 pages, which is more than we can read as one script. If it really is one script, email ${HELP_EMAIL} and we'll sort it out.`,
  empty_script:
    "We opened the PDF but couldn't find any script text in it. Check it's the right file, then export it again from your writing app.",
  empty_text:
    "We couldn't find a script in that text. Paste the whole script, with each character's name in capitals on its own line and what they say underneath.",
};

const READING =
  "This PDF is a scan, so we're reading the pages with text recognition. It usually takes about five minutes. We'll email you when your script is ready.";

const OUR_SIDE =
  "Something went wrong on our side while reading this PDF. Your file is fine, and we've been alerted. Please try again in a few minutes.";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask the server to read a stored screenplay PDF into scenes and lines.
 *
 * Two kinds of failure, and they need different handling:
 *   • the file (a scan, a password, not a PDF): told plainly, once — trying
 *     again can't help, a different file can;
 *   • us (a crashed worker, a dropped connection): retried here, quietly,
 *     because the writer did nothing wrong and a second go usually works.
 *
 * `discardIfUnreadable` asks the server to remove an upload that turned out to
 * be unusable, so it doesn't sit in the studio as a script that never plays.
 * Use it only for a brand-new upload.
 */
export async function parseScript(
  supabase: SupabaseClient,
  scriptId: string,
  opts: { discardIfUnreadable?: boolean } = {}
): Promise<ParseOutcome> {
  const ATTEMPTS = 3;
  let last: ParseFailure = {
    ok: false,
    code: "unreachable",
    message: OUR_SIDE,
    ours: true,
    discarded: false,
  };

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let d: Record<string, unknown> | null = null;
    let transportFailed = false;
    try {
      const { data, error } = await supabase.functions.invoke("parse-script", {
        body: {
          script_id: scriptId,
          ...(opts.discardIfUnreadable ? { discard_if_unreadable: true } : {}),
        },
      });
      transportFailed = !!error;
      d = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    } catch {
      transportFailed = true;
    }

    if (!transportFailed && d?.success === true) {
      // A server from before scans were refused reports a scan as a success
      // with nothing in it. Never treat that as a script.
      if (d.elements === 0) {
        return {
          ok: false,
          code: "scanned_pdf",
          message: FIXABLE.scanned_pdf,
          ours: false,
          discarded: false,
        };
      }
      return {
        ok: true,
        pages: typeof d.pages === "number" ? d.pages : null,
        imagePages: typeof d.image_pages === "number" ? d.image_pages : 0,
      };
    }

    const code = typeof d?.error === "string" ? d.error : "unreachable";
    if (code === "scanned_pdf" && d?.ocr === "reading") {
      return { ok: false, code, message: READING, ours: false, discarded: false, reading: true };
    }
    if (FIXABLE[code]) {
      return {
        ok: false,
        code,
        message: FIXABLE[code],
        ours: false,
        discarded: d?.discarded === true,
      };
    }

    last = { ok: false, code, message: OUR_SIDE, ours: true, discarded: false };
    if (attempt < ATTEMPTS) await wait(1500 * attempt);
  }
  return last;
}

export type ScanState = "reading" | "failed" | "done" | "none";

/** Is a scanned upload being read right now? Never throws; "none" if unknown. */
export async function scanStatus(supabase: SupabaseClient, scriptId: string): Promise<ScanState> {
  try {
    const { data, error } = await supabase.functions.invoke("parse-script", {
      body: { script_id: scriptId, action: "status" },
    });
    const state = (data as { ocr?: string } | null)?.ocr;
    if (error) return "none";
    return state === "reading" || state === "failed" || state === "done" ? state : "none";
  } catch {
    return "none";
  }
}

// ---- Pasted script text -----------------------------------------------------
// The fallback for a writer with no usable PDF: the script lives in Google Docs
// or Word, is a Fountain file, or the only PDF is one we can't read. The text is
// stored as a .txt beside where a PDF would go, so everything downstream
// (reading it again, replacing it, deleting it) works the same way.

/** Shorter than this isn't a script; it's a slip of the paste. */
export const MIN_PASTE_CHARS = 200;
/** A long feature is about 200,000 characters. */
export const MAX_PASTE_CHARS = 900_000;

/** Why this text can't be used, or null if it can. */
export function pasteProblem(text: string): string | null {
  const length = text.trim().length;
  if (length === 0) return "Paste your script into the box first.";
  if (length < MIN_PASTE_CHARS) return "That's only a few lines. Paste the whole script.";
  if (length > MAX_PASTE_CHARS) {
    return "That's more text than one script. Paste one script at a time (up to about 400 pages).";
  }
  return null;
}

/** Store pasted script text; resolves with its storage path. Throws on failure. */
export async function uploadScriptText(
  supabase: SupabaseClient,
  userId: string,
  text: string
): Promise<string> {
  const path = `${userId}/${Date.now()}.txt`;
  const { error } = await supabase.storage
    .from("scripts")
    .upload(path, new Blob([text], { type: "text/plain;charset=utf-8" }), {
      contentType: "text/plain;charset=utf-8",
    });
  if (error) throw error;
  return path;
}

/** "36 MB" */
export const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
