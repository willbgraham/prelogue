// Is there anything to hear?
//
// A script has two separate switches. Its visibility (public / hidden / private)
// is the writer's choice of who may open the page and read the text. Whether its
// read is unlocked (the one-time unlock or a plan) decides whether the audio
// exists at all. A writer can make a script public and never unlock the read:
// then the page is open to everyone and there is nothing on it to play. Only
// the writer gets the free ten-line taste of a locked read; for everyone else
// the server voices nothing (generate-voice-cues).
//
// The page used to find that out only when someone pressed Play: the button
// read "Generating 0%…100%" and then a card said the read was locked, and
// Discover listed such scripts under "pick one and press play".

/**
 * Can this viewer hear anything on the script's page? Yes when the read is
 * unlocked, when they are its writer (the free taste, and the way to unlock),
 * or when an actor has recorded lines for it (those clips play whatever the
 * state of the read).
 */
export function canListen({
  unlocked,
  isOwner,
  actorReads,
}: {
  unlocked: boolean | null | undefined;
  isOwner: boolean;
  /** Actor recordings of this script that this viewer may see. */
  actorReads: number | null | undefined;
}): boolean {
  return unlocked === true || isOwner || (actorReads ?? 0) > 0;
}

/** Does a public script belong in the listings (Discover, the home page)? Only with a read to hear. */
export function hasReadToHear(script: { full_read_unlocked?: boolean | null }): boolean {
  return script.full_read_unlocked === true;
}
