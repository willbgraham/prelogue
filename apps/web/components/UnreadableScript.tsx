"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserClient } from "@/lib/supabase/client";
import {
  HELP_EMAIL,
  MAX_SCRIPT_BYTES,
  megabytes,
  parseScript,
  pasteProblem,
  scanStatus,
  uploadScriptText,
  type ScanState,
} from "@/lib/parseScript";
import { PasteScriptBox } from "@/components/PasteScriptBox";

/**
 * Shown to a script's writer in place of the player when the script has no
 * lines to read. That used to be a grey box saying the script "hasn't been
 * parsed yet" with nothing to press — a dead end a paying subscriber sat in for
 * a quarter of an hour.
 *
 * Three situations look the same from the outside and must not read the same:
 *   • a scan that is being read right now (a wait, with an email at the end);
 *   • a scan the reader gave up on (ours to follow up, theirs to replace);
 *   • anything else: read the same file again, swap in a different PDF, or —
 *     when there is no PDF we can read at all — paste the script in as text.
 */
export function UnreadableScript({ scriptId }: { scriptId: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<null | "retry" | "replace" | "paste">(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState("");
  const [status, setStatus] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  // "unknown" until the first answer, so a scan in progress never flashes the
  // "we couldn't read this" panel first.
  const [scan, setScan] = useState<ScanState | "unknown">("unknown");
  // Bumped to (re)start watching after an action hands the file to the reader.
  const [watch, setWatch] = useState(0);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const check = async () => {
      const state = await scanStatus(getBrowserClient(), scriptId);
      if (!alive) return;
      if (state === "done") {
        // The lines are in. Reload the page data; this panel gives way to the player.
        router.refresh();
        return;
      }
      setScan(state);
      if (state === "reading") timer = window.setTimeout(check, 15_000);
    };
    void check();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [scriptId, router, watch]);

  async function read() {
    setStatus("Reading the screenplay…");
    const slow = window.setTimeout(
      () => setStatus("Still reading. Long scripts take a little longer…"),
      7000
    );
    const outcome = await parseScript(getBrowserClient(), scriptId).finally(() =>
      window.clearTimeout(slow)
    );
    if (outcome.ok) {
      // Stay "busy" until the refreshed page swaps this panel for the player.
      setStatus("Done. Loading your read…");
      router.refresh();
      return;
    }
    setBusy(null);
    setStatus("");
    if (outcome.reading) {
      setMessage(null);
      setScan("reading");
      setWatch((n) => n + 1);
      return;
    }
    setMessage(outcome.message);
  }

  async function retry() {
    setBusy("retry");
    setMessage(null);
    await read();
  }

  async function replace(file: File) {
    setMessage(null);
    if (file.size > MAX_SCRIPT_BYTES) {
      setMessage(
        `That file is ${megabytes(file.size)} and the limit is ${megabytes(MAX_SCRIPT_BYTES)}. Export a PDF from your writing app and upload that instead.`
      );
      return;
    }
    setBusy("replace");
    setStatus("Uploading PDF…");
    try {
      const supabase = getBrowserClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Please sign in first.");
      const path = `${user.id}/${Date.now()}.pdf`;
      const up = await supabase.storage
        .from("scripts")
        .upload(path, file, { contentType: "application/pdf" });
      if (up.error) throw up.error;
      const { error: updErr } = await supabase
        .from("scripts")
        .update({ file_url: path })
        .eq("id", scriptId);
      if (updErr) throw updErr;
      await read();
    } catch (e) {
      setMessage(
        (e as { message?: string } | null)?.message || "The upload failed. Please try again."
      );
      setBusy(null);
      setStatus("");
    }
  }

  async function submitPasted() {
    const problem = pasteProblem(pasted);
    if (problem) {
      setMessage(problem);
      return;
    }
    setMessage(null);
    setBusy("paste");
    setStatus("Saving your script…");
    try {
      const supabase = getBrowserClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Please sign in first.");
      const path = await uploadScriptText(supabase, user.id, pasted);
      const { error: updErr } = await supabase
        .from("scripts")
        .update({ file_url: path })
        .eq("id", scriptId);
      if (updErr) throw updErr;
      await read();
    } catch (e) {
      setMessage(
        (e as { message?: string } | null)?.message || "Saving the text failed. Please try again."
      );
      setBusy(null);
      setStatus("");
    }
  }

  if (scan === "unknown") {
    return (
      <div className="rounded-xl border border-tan bg-ivory p-5 text-sm text-muted">
        Checking on this script…
      </div>
    );
  }

  if (scan === "reading") {
    return (
      <div role="status" className="rounded-xl border border-tan bg-ivory p-5">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-brick/30 border-t-brick"
          />
          <div className="font-slab text-lg">Reading your scanned pages…</div>
        </div>
        <p className="mt-2 text-sm text-taupe">
          This PDF is a scan (pictures of the pages), so we&rsquo;re reading it with text
          recognition. It usually takes about five minutes.
        </p>
        <p className="mt-2 text-sm text-taupe">
          You don&rsquo;t need to wait here: we&rsquo;ll email you when it&rsquo;s ready, and this
          page will update on its own.
        </p>
      </div>
    );
  }

  const gaveUp = scan === "failed" && !message;

  return (
    <div className="rounded-xl border border-brick/40 bg-brick/5 p-5">
      <div className="font-slab text-lg">We couldn&rsquo;t read this PDF</div>
      {gaveUp ? (
        <p className="mt-1 text-sm text-taupe">
          This PDF is a scan, and our text recognition couldn&rsquo;t read it reliably. We&rsquo;ve
          been alerted and will take a look. If you have the script in your writing app, a PDF
          exported from there will work straight away.
        </p>
      ) : (
        <p className="mt-1 text-sm text-taupe">
          There are no lines here for the voices to read yet. Usually that means something went
          wrong on our side while reading it, or the file isn&rsquo;t the script itself.
        </p>
      )}

      {message && (
        <p role="alert" className="mt-3 rounded-lg bg-brick/10 px-3 py-2 text-sm text-brick">
          {message}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          onClick={() => fileRef.current?.click()}
          disabled={!!busy}
          className="rounded-lg bg-brick px-5 py-2.5 font-medium text-white disabled:opacity-60"
        >
          {busy === "replace" ? status || "Working…" : "Upload a different PDF"}
        </button>
        <button
          onClick={retry}
          disabled={!!busy}
          className="rounded-lg border border-brick px-5 py-2.5 font-medium text-brick hover:bg-brick/5 disabled:opacity-60"
        >
          {busy === "retry" ? status || "Working…" : "Try reading it again"}
        </button>
        {!pasteOpen && (
          <button
            onClick={() => setPasteOpen(true)}
            disabled={!!busy}
            className="text-sm font-medium text-taupe underline decoration-tan underline-offset-4 hover:text-brick disabled:opacity-60"
          >
            Paste the script text instead
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = ""; // let the same file be picked twice
            if (f) void replace(f);
          }}
        />
      </div>

      {pasteOpen && (
        <div className="mt-4">
          <PasteScriptBox value={pasted} onChange={setPasted} disabled={!!busy} />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              onClick={submitPasted}
              disabled={!!busy}
              className="rounded-lg bg-brick px-5 py-2.5 font-medium text-white disabled:opacity-60"
            >
              {busy === "paste" ? status || "Working…" : "Use this text"}
            </button>
            <button
              onClick={() => setPasteOpen(false)}
              disabled={!!busy}
              className="text-sm text-taupe hover:text-ink disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <p className="mt-4 text-xs leading-relaxed text-muted">
        A PDF exported straight from your writing app (Final Draft, Fade In, WriterDuet, Highland
        and so on) almost always works. Your title, details and settings stay as they are. Stuck?
        Email{" "}
        <a href={`mailto:${HELP_EMAIL}`} className="text-brick hover:underline">
          {HELP_EMAIL}
        </a>{" "}
        and we&rsquo;ll help.
      </p>
    </div>
  );
}
