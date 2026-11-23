/**
 * How long an export takes, so the card can say so before the writer starts one
 * and until the job reports figures of its own.
 *
 * KEEP IN SYNC with video-worker/src/progress.js (videoJobSeconds,
 * audioJobSeconds): the worker uses the same sums once it knows the exact
 * length of the video.
 */

// Characters a read gets through in a minute. Across 29 finished video exports
// it ran from 720 to 950 (median 840).
const CHARS_PER_MINUTE = 840;

// From pressing the button to the worker starting: a few seconds in the queue,
// then the job installs its tools. Measured at 31–68 seconds.
const START_UP_SECONDS = 40;

/** Seconds a read of this many spoken characters runs. */
export function readSeconds(spokenChars: number): number {
  return (Math.max(0, spokenChars) / CHARS_PER_MINUTE) * 60;
}

/**
 * Seconds the worker needs for a video of this length. Measured on real
 * exports: features of 64, 72 and 105 minutes took 144, 138 and 205 minutes
 * (1.9–2.25x their length, slower as memory fills); two-minute scenes about 1x.
 */
function videoJobSeconds(videoSeconds: number): number {
  const v = Math.max(0, videoSeconds);
  const ratio = v <= 300 ? 1 : v >= 1800 ? 2.05 : 1 + ((v - 300) / 1500) * 1.05;
  // Those were all 30 frames a second; a long read renders at fewer, and the
  // work goes with the number of frames.
  return Math.round(45 + v * ratio * ((fpsFor(v) ?? 10) / 30));
}

// One job can render about 240,000 frames before it is stopped, so the frame
// rate steps down for long reads until the whole video fits (the picture is
// text being typed, which reads the same at 15 frames a second).
// KEEP IN SYNC with video-worker/src/timeline.js.
const FRAME_BUDGET = 240_000;
const FRAME_RATES = [30, 20, 15, 10];
function fpsFor(videoSeconds: number): number | null {
  for (const f of FRAME_RATES) if (Math.max(0, videoSeconds) * f <= FRAME_BUDGET) return f;
  return null;
}

/** The longest read that can be rendered as one video (400 minutes), in seconds. */
export const MAX_VIDEO_SECONDS = FRAME_BUDGET / FRAME_RATES[FRAME_RATES.length - 1];

/** False when a read of this many spoken characters is too long to render as one video. */
export function videoFits(spokenChars: number): boolean {
  return readSeconds(spokenChars) <= MAX_VIDEO_SECONDS;
}

/** The same for an MP3: fetch every clip, join them, upload. Measured: 24–57 s for 845–2,300 lines. */
function audioJobSeconds(lines: number): number {
  return Math.round(10 + 0.02 * Math.max(0, lines));
}

/** From pressing "Render MP4" to the download being ready. */
export function videoExportSeconds(spokenChars: number): number {
  return START_UP_SECONDS + videoJobSeconds(readSeconds(spokenChars));
}

/** From pressing "Prepare MP3" to the download being ready. */
export function audioExportSeconds(lines: number): number {
  return START_UP_SECONDS + audioJobSeconds(lines);
}

/**
 * "about a minute", "about 25 minutes", "about 3½ hours". Deliberately round:
 * it is an estimate, and has been within about a tenth on the exports measured.
 */
export function roughly(seconds: number): string {
  const m = Math.max(0, seconds) / 60;
  if (m < 1.5) return "about a minute";
  if (m < 10) return `about ${Math.round(m)} minutes`;
  if (m < 50) return `about ${Math.round(m / 5) * 5} minutes`;
  const halves = Math.max(2, Math.round(m / 30)); // hours, in halves
  if (halves === 2) return "about an hour";
  const whole = Math.floor(halves / 2);
  return `about ${whole}${halves % 2 ? "½" : ""} hours`;
}

/** "about 2 h 10 min left", "about 4 min left", "less than a minute left". */
export function timeLeft(seconds: number): string {
  if (seconds < 50) return "less than a minute left";
  const m = Math.round(seconds / 60);
  if (m < 60) return `about ${m} min left`;
  const r = Math.round(m / 5) * 5;
  const h = Math.floor(r / 60);
  const rest = r % 60;
  return rest ? `about ${h} h ${rest} min left` : `about ${h} h left`;
}
