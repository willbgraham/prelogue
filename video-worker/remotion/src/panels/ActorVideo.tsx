import { useVideoConfig } from "remotion";
import { Video } from "@remotion/media";
import type { Segment } from "../lib/props";

// Top 16:9 panel for lines cast to a real actor: their clip, trimmed + volume-
// adjusted, letterboxed into the panel (matches the player's object-contain).
export function ActorVideo({ seg }: { seg: Segment }) {
  const { fps } = useVideoConfig();
  if (seg.media?.kind !== "video") return null;
  return (
    <Video
      src={seg.media.src}
      trimBefore={Math.round(seg.media.trimStartSec * fps)}
      trimAfter={Math.round(seg.media.trimEndSec * fps)}
      volume={seg.media.volume}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", backgroundColor: "#000" }}
    />
  );
}
