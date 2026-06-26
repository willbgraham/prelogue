"use client";

import { useState } from "react";

/**
 * Share the script link — uses the native share sheet on mobile browsers,
 * falls back to copying the link on desktop.
 */
export function ShareButton({ title, url }: { title: string; url?: string }) {
  const [copied, setCopied] = useState(false);

  async function onShare() {
    const shareUrl = url ?? (typeof window !== "undefined" ? window.location.href : "");
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title, url: shareUrl });
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") return; // user cancelled
        // otherwise fall through to copy
      }
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — nothing else we can do */
    }
  }

  return (
    <button
      onClick={onShare}
      className="inline-flex items-center gap-2 rounded-lg border border-tan px-3 py-2 text-sm font-medium text-taupe hover:bg-ivory"
    >
      {copied ? "✓ Link copied" : "↗ Share"}
    </button>
  );
}
