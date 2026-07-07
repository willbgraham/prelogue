import { Composition } from "remotion";
import type { CalculateMetadataFunction } from "remotion";
import { DailyScene } from "./DailyScene";
import type { DailySceneProps } from "./lib/props";
import { FPS, WIDTH, HEIGHT } from "./lib/theme";

// Duration = end of the last segment (+ ~0.5s tail). Segments carry their own
// start/duration frames from the worker's probed timeline.
const calc: CalculateMetadataFunction<DailySceneProps> = ({ props }) => {
  const fps = props.fps || FPS;
  const end = (props.segments ?? []).reduce((m, s) => Math.max(m, s.startFrame + s.durationFrames), 0);
  return { durationInFrames: Math.max(1, end + Math.round(fps * 0.5)), fps };
};

const EMPTY: DailySceneProps = {
  fps: FPS,
  variant: "ai",
  script: { id: "", title: "" },
  segments: [],
};

export function RemotionRoot() {
  return (
    <Composition
      id="DailyScene"
      component={DailyScene}
      durationInFrames={300}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      defaultProps={EMPTY}
      calculateMetadata={calc}
    />
  );
}
