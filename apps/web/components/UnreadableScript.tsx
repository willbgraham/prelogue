"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserClient } from "@/lib/supabase/client";
import { HELP_EMAIL, MAX_SCRIPT_BYTES, megabytes, parseScript } from "@/lib/parseScript";

/**
 * Shown to a script's writer in place of the player when the script has no
 * lines to read. That used to be a grey box saying the script "hasn't been
 * parsed yet" with nothing to press — a dead end a paying subscriber sat in for
 * a quarter of an hour. There are only two ways out, so offer both: read the
 * same file again (the failure may have been ours), or swap in a different PDF
 * (the file may be a scan).
 */
export function UnreadableScript({ scriptId }: { scriptId: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<null | "retry" | "replace">(null);
  const [status, setStatus] = useState("");
  const [message, setMessage] = useState<string | null>(null);

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
    setMessage(outcome.message);
    setBusy(null);
    setStatus("");
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
        `That file is ${megabytes(file.size)} and the limit is ${megabytes(MAX_SCRIPT_BYTES)}. PDFs that large are usually scans. Export a PDF from your writing app and upload that instead.`
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

  return (
    <div className="rounded-xl border border-brick/40 bg-brick/5 p-5">
      <div className="font-slab text-lg">We couldn&rsquo;t read this PDF</div>
      <p className="mt-1 text-sm text-taupe">
        There are no lines here for the voices to read yet. Usually that means the PDF is a scan
        (pictures of the pages, with no text in it), or something went wrong on our side while
        reading it.
      </p>

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
