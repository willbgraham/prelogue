import { useCurrentFrame } from "remotion";
import { MONO } from "../fonts";
import { theme } from "../lib/theme";
import type { Segment } from "../lib/props";

// Top 16:9 panel for AI/narrator lines: types the text out on the paper
// background, in step with the line's audio. Frame-local (inside the segment's
// <Sequence>), so `reveal` uses the player's exact formula.
export function Typewriter({ seg }: { seg: Segment }) {
  const frame = useCurrentFrame(); // 0-based within this segment
  const progress = seg.durationFrames > 1 ? Math.min(1, frame / (seg.durationFrames - 1)) : 1;
  const reveal = Math.ceil(seg.text.length * progress); // == TableReadPlayer reveal
  const shown = seg.text.slice(0, reveal);
  const typing = reveal < seg.text.length;
  const cursorOn = typing && Math.floor(frame / 15) % 2 === 0; // frame-driven blink
  const isNarr = seg.kind === "narrator";
  const label = isNarr ? "NARRATOR" : (seg.character || "").toUpperCase();

  const len = seg.text.length;
  const fontSize = len > 160 ? 26 : len > 90 ? 32 : 38;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        backgroundColor: theme.paper,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 70px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontFamily: MONO,
          fontSize: 20,
          letterSpacing: 2,
          color: theme.brick,
          textTransform: "uppercase",
          marginBottom: 22,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: MONO,
          fontSize,
          lineHeight: 1.4,
          color: theme.ink,
          fontStyle: isNarr ? "italic" : "normal",
          maxWidth: 940,
        }}
      >
        {shown}
        <span style={{ opacity: cursorOn ? 1 : 0, color: theme.brick }}>▌</span>
      </div>
    </div>
  );
}
