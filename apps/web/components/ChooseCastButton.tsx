"use client";

import { CastIcon } from "@/components/icons";

/**
 * Standalone "Choose Cast" button for placement outside TableReadPlayer (the
 * demo page shows one under the rating row, before the visitor has scrolled
 * to the player). Opens the player's voice picker via a window event the
 * player listens for — no state threading through the server page.
 */
export function ChooseCastButton() {
  return (
    <button
      onClick={() => window.dispatchEvent(new CustomEvent("prelogue:choose-cast"))}
      className="inline-flex items-center gap-1.5 rounded-lg bg-brick px-4 py-2 text-sm font-medium text-white hover:bg-brick/90"
    >
      <CastIcon className="h-4 w-4" />
      Choose Cast
    </button>
  );
}
