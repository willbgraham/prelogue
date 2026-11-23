// Pure timeline builder (unit-testable). buildRows is a JS port of
// apps/web/lib/shared/buildRows.ts — the global element index MUST match
// generate-voice-cues + the voice manifest. buildTimeline turns rows + the
// manifest + probed durations into frame-accurate segments for Remotion.
const FPS = 30;
const SILENT_SEC = 1.2;

// ---------------------------------------------------------------------------
// Long reads
// ---------------------------------------------------------------------------
// A render job is stopped by GitHub after 330 minutes, and renders run at about
// 900–1,050 frames a minute. At 30 frames a second that is roughly 2 h 45 min of
// video — and a 107-page script that was nearly all description ran 3 h 35 min
// (Nov 2026): its export could never have finished, while the card counted down
// to an email that was not coming. Pages are a poor measure of length; frames
// are the real one. So the frame rate steps down for long reads until the whole
// video fits in one job with an hour to spare. The picture is text being typed
// and a script scrolling, which reads the same at 15 frames a second.
const FRAME_BUDGET = 240_000;
const FRAME_RATES = [30, 20, 15, 10];

/** The highest frame rate at which a video this long fits in one job, or null if none does. */
function fpsFor(totalSeconds) {
  const s = Math.max(0, totalSeconds || 0);
  for (const f of FRAME_RATES) if (s * f <= FRAME_BUDGET) return f;
  return null;
}
/** The longest video one job can render, in seconds (at the lowest frame rate). */
const MAX_VIDEO_SECONDS = FRAME_BUDGET / FRAME_RATES[FRAME_RATES.length - 1];

// The frame rate turned out not to be the whole story. The renderer keeps every
// frame's audio samples in memory until the video is finished: about 0.8 MB for
// each second of video, whatever the frame rate, and a job has 8 GB. A
// 105-minute feature fits (about 5 GB). The 3 h 35 min read above, restarted at
// 15 frames a second, ran out of memory two and a half hours in, and its card
// sat on a frozen bar. So one process renders at most two hours of video.
// Anything longer is rendered in parts (below), each in its own process, or
// refused: never started on a job that cannot finish.
const SINGLE_JOB_MAX_SECONDS = 120 * 60;

// ---------------------------------------------------------------------------
// Rendering in parts
// ---------------------------------------------------------------------------
// A feature's video took three to four hours on one job. The same frames can be
// rendered by several jobs at once and joined without re-encoding (see parts.js),
// which brings any feature down to about forty minutes — and at the full 30
// frames a second, since no single job comes near its limit.
//
// A part is about twenty minutes of video. Anything under twenty-five minutes
// renders on one job exactly as it always has: fanning out and joining cost a
// few minutes, which a short video would not earn back.
const PART_FRAMES = 36_000;
const SPLIT_ABOVE_FRAMES = 45_000;
const MAX_PARTS = 16; // GitHub runs up to 20 jobs at once for an account

/**
 * How to divide a video of this many frames among jobs: { parts, framesPerPart,
 * ranges: [[from, to], …] }. Every part is the same length except the last, which
 * is what lets the audio join without a seam. One part means "don't split".
 * `forceParts` is for tests: it splits a short video anyway.
 */
function planParts(totalFrames, forceParts) {
  const total = Math.max(1, Math.floor(totalFrames || 0));
  let parts =
    forceParts > 0
      ? Math.floor(forceParts)
      : total > SPLIT_ABOVE_FRAMES
        ? Math.ceil(total / PART_FRAMES)
        : 1;
  parts = Math.max(1, Math.min(parts, MAX_PARTS));
  for (; parts > 1; parts--) {
    const framesPerPart = Math.ceil(total / parts);
    const ranges = [];
    for (let from = 0; from < total; from += framesPerPart) {
      ranges.push([from, Math.min(total - 1, from + framesPerPart - 1)]);
    }
    const last = ranges[ranges.length - 1];
    // Tiny parts are not worth a job, and the renderer is unreliable below five frames.
    if (ranges.length === parts && last[1] - last[0] + 1 >= 5) return { parts, framesPerPart, ranges };
  }
  return { parts: 1, framesPerPart: total, ranges: [[0, total - 1]] };
}

// A finished file has to go up in one upload, and the largest one known to have
// worked is 942 MB (the project's ceiling is 2 GB). Videos have run about
// 1.2 Mbit/s all told, which passes a gigabyte at around 110 minutes — so past
// that the encoder is held to a rate that keeps the file under it. Short videos
// are left exactly as they were.
const SIZE_BUDGET_BYTES = 1_000_000_000;
const NATURAL_KBPS = 1300;

/** Extra encoder settings for a video of this length ({} when none are needed). */
function encodingFor(videoSeconds) {
  const totalKbps = Math.floor((SIZE_BUDGET_BYTES * 8) / Math.max(1, videoSeconds || 0) / 1000);
  if (totalKbps >= NATURAL_KBPS) return {};
  // The voices are 32 kbit/s speech: 96 (or 64 on the longest reads) loses nothing audible.
  const audioKbps = totalKbps >= 700 ? 96 : 64;
  const videoKbps = Math.max(250, totalKbps - audioKbps);
  return { audioKbps, videoKbps };
}
// No inter-line gap: lines flow back-to-back like the browser player (which
// advances on `ended`). A gap would leave the top screen black between lines.
const GAP_SEC = 0;

function buildRows(parsed, opts = {}) {
  if (!parsed || !parsed.scenes) return [];
  const actorUpper = opts.actorName ? opts.actorName.toUpperCase() : null;
  const rows = [];
  let g = 0;
  let sceneIdx = -1;
  for (const scene of parsed.scenes) {
    sceneIdx++;
    const heading = scene.heading ? scene.heading.trim() : "";
    let headingPending = !!heading;
    for (const el of scene.elements || []) {
      const idx = g++;
      const renderable = el.type === "dialogue" || el.type === "action";
      let rowHeading;
      if (headingPending && renderable) {
        rowHeading = heading;
        headingPending = false;
      }
      if (el.type === "dialogue") {
        const kind = actorUpper
          ? (el.character_name || "").toUpperCase() === actorUpper
            ? "actor"
            : "cue"
          : "line";
        rows.push({ elementIndex: idx, sceneIndex: sceneIdx, kind, character: el.character_name, text: el.text, sceneHeading: rowHeading });
      } else if (el.type === "action") {
        rows.push({ elementIndex: idx, sceneIndex: sceneIdx, kind: "narrator", text: el.text, sceneHeading: rowHeading });
      }
      // character / parenthetical consume an index but produce no row.
    }
  }
  return rows;
}

// manifestByIdx: Map<element_index, {audio_path,...}>
// clipsByIdx:    Map<element_index, {clip_url, trim_start?, trim_end?, volume?}> (composite only)
// durationByKey: Map<path, seconds>  (probed)
// signedByKey:   Map<path, signedUrl>
// fps: frames a second for this render (see fpsFor). Frame counts scale with
// it; the seconds each line takes do not.
function buildTimeline(rows, { manifestByIdx, clipsByIdx = new Map(), durationByKey, signedByKey, fps = FPS }) {
  const segments = [];
  let cursor = 0;
  let seconds = 0;
  for (const row of rows) {
    const idx = row.elementIndex;
    const clip = clipsByIdx.get(idx);
    const cue = manifestByIdx.get(idx);
    let durSec;
    let media;
    if (clip && signedByKey.get(clip.clip_url)) {
      const start = clip.trim_start != null ? clip.trim_start : 0;
      const probed = durationByKey.get(clip.clip_url);
      const end = clip.trim_end != null ? clip.trim_end : probed != null ? probed : start + 2;
      durSec = Math.max(0.3, end - start);
      media = { kind: "video", src: signedByKey.get(clip.clip_url), trimStartSec: start, trimEndSec: end, volume: clip.volume != null ? clip.volume : 1 };
    } else if (cue && signedByKey.get(cue.audio_path)) {
      durSec = durationByKey.get(cue.audio_path) || SILENT_SEC;
      media = { kind: "audio", src: signedByKey.get(cue.audio_path), volume: 1 };
    } else {
      durSec = SILENT_SEC;
      media = null;
    }
    const durationFrames = Math.max(1, Math.ceil(durSec * fps));
    seconds += durSec + GAP_SEC;
    segments.push({
      elementIndex: idx,
      sceneIndex: row.sceneIndex,
      startFrame: cursor,
      durationFrames,
      kind: row.kind,
      character: row.character,
      text: row.text,
      sceneHeading: row.sceneHeading,
      media,
    });
    cursor += durationFrames + Math.round(GAP_SEC * fps);
  }
  return { fps, segments, totalFrames: cursor, seconds };
}

module.exports = {
  buildRows,
  buildTimeline,
  fpsFor,
  encodingFor,
  planParts,
  FPS,
  FRAME_BUDGET,
  FRAME_RATES,
  MAX_VIDEO_SECONDS,
  SINGLE_JOB_MAX_SECONDS,
  PART_FRAMES,
  SPLIT_ABOVE_FRAMES,
  MAX_PARTS,
};
