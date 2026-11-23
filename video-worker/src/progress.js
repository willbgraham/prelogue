// Lets the export card show how far along a job is and how long is left.
//
// A video export of a feature takes hours, and all the writer used to see was
// "Rendering…" for the whole of it. The job now writes a small JSON note beside
// the export's files in the private daily-renders bucket
// (<script>/progress/<render id>.json) and export-read hands it to the card on
// each status poll. No schema change: a missing note (an older worker, or a job
// that has not written yet) simply means "no figure to show".
//
// Reporting must never hurt the export it describes: writes are fire-and-forget,
// one at a time, and every failure is swallowed.

const { fpsFor } = require("./timeline");

const BUCKET = "daily-renders";
const notePath = (scriptId, renderId) => `${scriptId}/progress/${renderId}.json`;

// How a job divides up, as shares of the bar. Rendering frames is nearly all of
// a video export; an audio export is mostly fetching the clips.
const STAGES = {
  video: { preparing: [0, 2], rendering: [2, 94], finishing: [94, 97], uploading: [97, 99] },
  audio: { preparing: [0, 5], collecting: [5, 85], stitching: [85, 92], uploading: [92, 99] },
};

/**
 * Seconds a video export takes from the moment the worker starts to the file
 * being ready, given the length of the video.
 *
 * Measured on real exports (GitHub runner, 4 cores): features of 64, 72 and 105
 * minutes took 144, 138 and 205 minutes (1.9–2.25x their length, slower as
 * memory fills); two-minute scenes took two to three minutes (about 1x).
 * KEEP IN SYNC with apps/web/lib/exportEstimate.ts.
 */
function videoJobSeconds(videoSeconds, fps) {
  const v = Math.max(0, videoSeconds || 0);
  const ratio = v <= 300 ? 1 : v >= 1800 ? 2.05 : 1 + ((v - 300) / 1500) * 1.05;
  // Those were all 30 frames a second. A long read is rendered at fewer (see
  // timeline.js), and the work goes with the number of frames.
  const rate = (fps || fpsFor(v) || 10) / 30;
  return Math.round(45 + v * ratio * rate);
}

/** The same for an audio export: fetch every clip, stitch, upload. Measured: 24–57 s for 845–2,300 lines. */
function audioJobSeconds(lines) {
  return Math.round(10 + 0.02 * Math.max(0, lines || 0));
}

/**
 * How far through the rendering stage a video is, 0..1, from the renderer's
 * frame counts. Not the renderer's own `progress`: that gives encoding 30% of
 * the figure, but encoding either keeps pace with rendering (when the machine
 * has the memory to do both at once, as the runner does) or follows it and is
 * about ten times faster (as on a laptop) — so that figure crawls for most of
 * the job and then leaps. Weighted by where the time actually goes, the bar
 * moves at an even pace either way.
 */
function renderFraction({ renderedFrames, encodedFrames }, totalFrames) {
  const total = Math.max(1, totalFrames || 0);
  const rendered = Math.min(1, Math.max(0, (renderedFrames || 0) / total));
  const encoded = Math.min(1, Math.max(0, (encodedFrames || 0) / total));
  return 0.913 * rendered + 0.087 * encoded;
}

// What is left to do once the frames are rendered (mix, upload, MP3 copy).
const videoTailSeconds = (videoSeconds) => Math.round(20 + 0.02 * Math.max(0, videoSeconds || 0));

/**
 * @param {object} o
 * @param {object} o.supabase       service-role client
 * @param {string} o.scriptId
 * @param {string} o.renderId
 * @param {"video"|"audio"} o.kind
 * @param {() => number} [o.now]    clock, for tests
 * @param {number} [o.minIntervalMs] least time between two writes
 * @param {(line: string) => void} [o.log]
 */
function createReporter({ supabase, scriptId, renderId, kind, now = Date.now, minIntervalMs, log = console.log }) {
  const stages = STAGES[kind === "audio" ? "audio" : "video"];
  const every = minIntervalMs != null ? minIntervalMs : kind === "audio" ? 1500 : 10_000;
  const path = notePath(scriptId, renderId);
  const startedAt = now();

  let stage = "preparing";
  let fraction = 0; // 0..1 within the current stage
  let stageStartedAt = startedAt;
  let pct = 0; // 0..99 over the whole job; never goes backwards
  let videoSeconds = null;
  let videoFps = null;
  let lines = null;
  let samples = []; // [{ t, f }] within the current stage, for the recent rate
  let lastWriteAt = -Infinity;
  let writing = null; // the write in flight, if any
  let dirty = false;
  let wantNow = false; // a change of stage is written at once, not on the next tick
  let closed = false;
  let lastLoggedTenth = -1;

  function overall() {
    const [lo, hi] = stages[stage] || [0, 0];
    return Math.min(99, Math.max(0, Math.floor(lo + (hi - lo) * Math.min(1, Math.max(0, fraction)))));
  }

  // Seconds left, or null when there is nothing to go on yet.
  function eta() {
    const t = now();
    const elapsed = (t - startedAt) / 1000;
    const inStage = (t - stageStartedAt) / 1000;

    // What the whole job should take, from its size alone.
    const modelTotal =
      kind === "audio"
        ? lines != null ? audioJobSeconds(lines) : null
        : videoSeconds != null ? videoJobSeconds(videoSeconds, videoFps) : null;
    const byModel = modelTotal != null ? Math.max(0, modelTotal - elapsed) : null;

    // What it is actually doing: the pace over the last few minutes of the long
    // stage (a render slows as it goes, so the recent pace beats the average).
    const longStage = kind === "audio" ? "collecting" : "rendering";
    const tail = kind === "audio" ? 6 : videoTailSeconds(videoSeconds);
    if (stage !== longStage) {
      if (stage === "preparing") return byModel;
      // Past the long stage only the tail is left, however long the rest took:
      // what remains of the bar between the end of that stage and the top.
      const [lo, hi] = stages[stage];
      const top = stages.uploading[1];
      const tailStart = stages[longStage][1];
      const share = (top - (lo + (hi - lo) * fraction)) / (top - tailStart);
      return Math.max(1, Math.round(tail * Math.min(1, Math.max(0, share))));
    }
    if (fraction <= 0 || inStage < 5) return byModel;

    const recentFrom = samples.find((s) => t - s.t <= 300_000) || samples[0];
    let pace = fraction / inStage; // fraction per second, averaged over the stage
    if (recentFrom && t - recentFrom.t >= 60_000 && fraction > recentFrom.f) {
      pace = (fraction - recentFrom.f) / ((t - recentFrom.t) / 1000);
    }
    const byPace = (1 - fraction) / pace + tail;
    if (byModel == null) return Math.round(byPace);
    // Early on the pace is noise (the first frames are the slowest to start);
    // lean on the model and hand over to the pace as real progress accrues.
    const trust = Math.min(1, Math.max(0, (fraction - 0.02) / 0.08));
    return Math.round((1 - trust) * byModel + trust * byPace);
  }

  function snapshot() {
    pct = Math.max(pct, overall());
    const left = eta();
    return {
      v: 1,
      render_id: renderId,
      kind: kind === "audio" ? "audio" : "video",
      stage,
      pct,
      eta_seconds: left == null || !isFinite(left) ? null : Math.max(0, Math.round(left)),
      video_seconds: videoSeconds != null ? Math.round(videoSeconds) : null,
      started_at: new Date(startedAt).toISOString(),
      updated_at: new Date(now()).toISOString(),
    };
  }

  function write() {
    if (closed) return;
    dirty = false;
    wantNow = false;
    lastWriteAt = now();
    const note = snapshot();
    let attempt;
    try {
      attempt = Promise.resolve(
        supabase.storage
          .from(BUCKET)
          .upload(path, Buffer.from(JSON.stringify(note)), {
            contentType: "application/json",
            cacheControl: "0", // rewritten every few seconds; never serve an old one
            upsert: true,
          })
      );
    } catch (_) {
      return; // a client that throws outright: nothing to wait for
    }
    writing = attempt
      .catch(() => {})
      .then(() => {
        writing = null;
        // Something changed while that one was on the wire.
        if (dirty && !closed && (wantNow || now() - lastWriteAt >= every)) write();
      });
  }

  function touch(force) {
    if (closed) return;
    dirty = true;
    if (force) wantNow = true;
    if (writing) return; // picked up when the write in flight lands
    if (wantNow || now() - lastWriteAt >= every) write();
  }

  return {
    /** The length of the finished video, once the timeline is built. */
    setVideoSeconds(seconds, fps) {
      if (seconds > 0) videoSeconds = seconds;
      if (fps > 0) videoFps = fps;
    },
    /** How many clips an audio export has to fetch. */
    setLines(n) {
      if (n > 0) lines = n;
    },
    /** Move to a named stage of the job. */
    stage(name, f = 0) {
      if (closed || !stages[name]) return;
      if (name !== stage) {
        stage = name;
        stageStartedAt = now();
        samples = [];
      }
      fraction = Math.min(1, Math.max(0, f));
      touch(true);
    },
    /** Progress within the current stage, 0..1. Cheap enough to call per frame. */
    progress(f) {
      if (closed || !(f >= 0)) return;
      fraction = Math.min(1, Math.max(fraction, f));
      const t = now();
      const last = samples[samples.length - 1];
      if (!last || t - last.t >= 15_000) {
        samples.push({ t, f: fraction });
        if (samples.length > 240) samples.shift();
      }
      // A line in the job's log every ten per cent: figures only.
      const tenth = Math.floor(overall() / 10);
      if (tenth > lastLoggedTenth) {
        lastLoggedTenth = tenth;
        const left = eta();
        try {
          log(`  ${stage} ${overall()}%${left != null ? ` · about ${Math.round(left / 60)} min left` : ""}`);
        } catch (_) {
          /* a logger is never worth a failed export */
        }
      }
      touch(false);
    },
    /** The job is over (finished or failed): stop reporting and remove the note. */
    async close() {
      if (closed) return;
      closed = true;
      const tidy = (async () => {
        try {
          if (writing) await writing;
          await supabase.storage.from(BUCKET).remove([path]);
        } catch (_) {
          /* a leftover note is harmless: nothing reads it once the row has settled */
        }
      })();
      // The export is already delivered by now. A storage call that never
      // answers must not keep the job (and its runner) alive for hours.
      let timer;
      await Promise.race([tidy, new Promise((r) => (timer = setTimeout(r, 10_000)))]);
      clearTimeout(timer);
    },
    snapshot,
    path,
  };
}

module.exports = { createReporter, renderFraction, videoJobSeconds, audioJobSeconds, notePath, STAGES, BUCKET };
