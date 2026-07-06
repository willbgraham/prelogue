"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserClient } from "@/lib/supabase/client";

/**
 * Owner-only permanent delete. Requires typing the title to confirm, then calls
 * the ownership-checked `delete_script` RPC (safe FK cascade) and returns to Studio.
 */
export function DeleteScriptButton({ scriptId, title }: { scriptId: string; title: string }) {
  const router = useRouter();
  const supabase = getBrowserClient();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doDelete() {
    setBusy(true);
    setError(null);
    const { error } = await supabase.rpc("delete_script", { p_script_id: scriptId });
    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    router.push("/studio");
    router.refresh();
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-sm font-medium text-brick/80 hover:text-brick hover:underline"
      >
        Delete script
      </button>
    );
  }

  const canDelete = confirm.trim() === title.trim() && !busy;

  return (
    <div className="rounded-xl border border-brick/40 bg-brick/5 p-4">
      <div className="text-sm font-medium text-brick">Delete this script permanently?</div>
      <p className="mt-1 text-xs text-taupe">
        This removes the screenplay, its parsed lines, characters, and every actor read. It can&rsquo;t be undone. Type the
        title <span className="font-semibold">{title}</span> to confirm.
      </p>
      {error && <p className="mt-2 text-xs text-brick">{error}</p>}
      <input
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        placeholder={title}
        className="mt-2 w-full rounded-lg border border-tan bg-elevated px-3 py-2 text-sm outline-none focus:border-brick"
      />
      <div className="mt-3 flex gap-2">
        <button
          onClick={doDelete}
          disabled={!canDelete}
          className="rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "Deleting…" : "Delete forever"}
        </button>
        <button
          onClick={() => {
            setOpen(false);
            setConfirm("");
            setError(null);
          }}
          className="rounded-lg border border-tan px-4 py-2 text-sm font-medium text-taupe hover:bg-elevated"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
