import { useMemo } from "react";
import { useCurrentFrame, interpolate, Easing } from "remotion";
import { MONO } from "../fonts";
import { theme, BOTTOM_H } from "../lib/theme";
import {
  computeLayout,
  PAD_X,
  CONTENT_W,
  FONT_SIZE,
  LINE_H,
  LABEL_H,
  HEADING_H,
} from "../lib/layout";
import type { Segment } from "../lib/props";

// Bottom panel: the full script, absolutely positioned from the pre-measure,
// scrolled so the active line stays centered (the player's scrollTo math),
// eased between lines. Rendered at composition level → absolute frame.
export function ScrollingScript({ segments }: { segments: Segment[] }) {
  const frame = useCurrentFrame();
  const { rows } = useMemo(() => computeLayout(segments), [segments]);

  let active = 0;
  for (let i = 0; i < segments.length; i++) {
    if (frame >= segments[i].startFrame) active = i;
    else break;
  }
  const centerY = (i: number) => rows[i].top - BOTTOM_H / 2 + rows[i].height / 2;
  const seg = segments[active];
  const scrollY = interpolate(
    frame,
    [seg.startFrame, seg.startFrame + 12],
    [centerY(Math.max(0, active - 1)), centerY(active)],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.ease) }
  );

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: PAD_X, top: 0, width: CONTENT_W, transform: `translateY(${-scrollY}px)` }}>
        {segments.map((s, i) => {
          const r = rows[i];
          const isActive = i === active;
          const isNarr = s.kind === "narrator";
          return (
            <div key={s.elementIndex} style={{ position: "absolute", top: r.top, left: 0, width: CONTENT_W }}>
              {s.sceneHeading && (
                <div style={{ fontFamily: MONO, fontSize: 18, letterSpacing: 1.5, textTransform: "uppercase", color: theme.muted, height: HEADING_H, display: "flex", alignItems: "center" }}>
                  {s.sceneHeading}
                </div>
              )}
              {!isNarr && s.character && (
                <div style={{ fontFamily: MONO, fontSize: 20, textTransform: "uppercase", color: theme.brick, textAlign: "center", height: LABEL_H, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {s.character}
                </div>
              )}
              <div
                style={{
                  fontFamily: MONO,
                  fontSize: FONT_SIZE,
                  lineHeight: `${LINE_H}px`,
                  color: isActive ? theme.ink : theme.taupe,
                  fontStyle: isNarr ? "italic" : "normal",
                  textAlign: isNarr ? "left" : "center",
                  opacity: isActive ? 1 : 0.5,
                  backgroundColor: isActive ? "rgba(188,64,38,0.10)" : "transparent",
                  borderRadius: 8,
                }}
              >
                {s.text}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
