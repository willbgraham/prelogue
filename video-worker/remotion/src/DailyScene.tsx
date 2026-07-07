import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import { Audio } from "@remotion/media";
import "./fonts"; // side-effect: block-load Courier Prime + Roboto Slab
import { theme, TOP_H, BOTTOM_H, WIDTH } from "./lib/theme";
import type { DailySceneProps } from "./lib/props";
import { Typewriter } from "./panels/Typewriter";
import { ActorVideo } from "./panels/ActorVideo";
import { ScrollingScript } from "./panels/ScrollingScript";

// 9:16 (1080×1920): top 16:9 video screen (typewriter or actor clip per line),
// bottom scrolling script. One Sequence per line for the top visual + its audio.
export function DailyScene({ segments }: DailySceneProps) {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ backgroundColor: theme.paper }}>
      {/* TOP — 16:9 video screen */}
      <div style={{ position: "absolute", top: 0, left: 0, width: WIDTH, height: TOP_H, backgroundColor: "#000", overflow: "hidden" }}>
        {segments.map((s) => (
          <Sequence key={`top-${s.elementIndex}`} from={s.startFrame} durationInFrames={s.durationFrames} premountFor={fps}>
            {s.media?.kind === "video" ? <ActorVideo seg={s} /> : <Typewriter seg={s} />}
          </Sequence>
        ))}
      </div>

      {/* BOTTOM — scrolling script */}
      <div style={{ position: "absolute", top: TOP_H, left: 0, width: WIDTH, height: BOTTOM_H, backgroundColor: theme.paper, overflow: "hidden" }}>
        <ScrollingScript segments={segments} />
      </div>

      {/* Divider — reads the top as a distinct "screen" above the script */}
      <div style={{ position: "absolute", top: TOP_H - 3, left: 0, width: WIDTH, height: 5, backgroundColor: theme.brick, boxShadow: "0 8px 22px rgba(42,36,32,0.16)" }} />

      {/* AUDIO — AI voice cues (actor clips carry their own audio in ActorVideo) */}
      {segments.map((s) =>
        s.media?.kind === "audio" ? (
          <Sequence key={`aud-${s.elementIndex}`} from={s.startFrame} durationInFrames={s.durationFrames} premountFor={fps}>
            <Audio src={s.media.src} volume={s.media.volume} trimAfter={s.durationFrames} />
          </Sequence>
        ) : null
      )}
    </AbsoluteFill>
  );
}
