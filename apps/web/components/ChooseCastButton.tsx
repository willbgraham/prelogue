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

/**
 * Beside it on the demo: the other half of the pitch, how a line is said. A
 * visitor can't open the lines editor (it is the writer's, and it saves), so
 * this opens the same picker on a line, with the choice of emotion showing:
 * pick one, press Preview, hear it. The demo's owner gets a link to the real
 * editor instead (see the script page).
 */
export function AddEmotionsButton() {
  return (
    <button
      onClick={() => window.dispatchEvent(new CustomEvent("prelogue:direct-lines"))}
      className={EDIT_LINES_CLASS}
    >
      {EDIT_LINES_LABEL}
    </button>
  );
}

export const EDIT_LINES_LABEL = "✏️ Edit Lines & Add Emotions";
export const EDIT_LINES_CLASS =
  "inline-flex items-center gap-1.5 rounded-lg border border-brick px-4 py-2 text-sm font-medium text-brick hover:bg-brick/5";
