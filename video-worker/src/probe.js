const fs = require("fs");
const os = require("os");
const path = require("path");
const ff = require("./ff");

// The voice manifest carries no durations, so each clip (and, for the composite
// variant, each actor clip) is measured here. Content-addressed paths are
// deduped so a repeated line is measured once.
//
// A voice clip's length is the length of the sound in it: the clip is decoded
// and its samples counted. Asking ffprobe for the "duration" instead depends on
// which ffprobe is asked: an MP3 carries a little padding from its encoder, and
// ffmpeg 8's ffprobe leaves it out while ffmpeg 7's counts it — about 65 ms a
// clip, half a minute over a 500-line read. Every video before this was timed
// by ffmpeg 8's figure, which is the decoded length to the microsecond
// (measured on a runner, Nov 2026), so counting keeps the timing as it was and
// stops it moving with whatever ffprobe a machine happens to have.

let scratch = null;
function scratchDir() {
  if (!scratch) {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
    process.once("exit", () => {
      try {
        fs.rmSync(scratch, { recursive: true, force: true });
      } catch (_) {
        /* the machine is going away anyway */
      }
    });
  }
  return scratch;
}

/** Seconds of sound in an audio file, by decoding it and counting the samples. Null if it can't be decoded. */
function decodedSeconds(file) {
  return new Promise((resolve) => {
    let child;
    try {
      child = ff.spawn(
        "ffmpeg",
        ["-v", "error", "-i", file, "-vn", "-map", "0:a:0", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"],
        { stdio: ["ignore", "pipe", "ignore"] }
      );
    } catch (_) {
      return resolve(null);
    }
    let head = Buffer.alloc(0);
    let total = 0;
    let sound = null; // { at: where the samples start, bytesPerSecond }
    child.stdout.on("data", (chunk) => {
      total += chunk.length;
      if (sound || head.length > 65536) return;
      head = Buffer.concat([head, chunk]);
      // RIFF….WAVE, then chunks of (name, size, body): "fmt " describes the samples, "data" is them.
      if (head.length < 12 || head.toString("ascii", 0, 4) !== "RIFF") return;
      let at = 12;
      let fmt = null;
      while (at + 8 <= head.length) {
        const name = head.toString("ascii", at, at + 4);
        const size = head.readUInt32LE(at + 4);
        if (name === "fmt " && at + 24 <= head.length) {
          fmt = { channels: head.readUInt16LE(at + 10), rate: head.readUInt32LE(at + 12), bits: head.readUInt16LE(at + 22) };
        }
        if (name === "data") {
          if (fmt && fmt.channels > 0 && fmt.rate > 0 && fmt.bits > 0) {
            sound = { at: at + 8, bytesPerSecond: (fmt.channels * fmt.rate * fmt.bits) / 8 };
          }
          return;
        }
        at += 8 + size + (size % 2);
      }
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0 || !sound) return resolve(null);
      const seconds = (total - sound.at) / sound.bytesPerSecond;
      resolve(seconds > 0 && Number.isFinite(seconds) ? seconds : null);
    });
  });
}

/** What ffprobe gives as a file's duration (for video clips, where it is the picture's length that matters). */
function statedSeconds(file) {
  return new Promise((resolve) => {
    ff.execFile(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
      { maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) return resolve(null);
        const d = parseFloat(String(stdout).trim());
        resolve(Number.isFinite(d) ? d : null);
      }
    );
  });
}

/** Length in seconds of a clip, given its address or a path. Null if it can't be measured. */
async function probeDuration(input) {
  if (!input) return null;
  let copy = null;
  try {
    copy = await ff.localCopy(input, scratchDir());
    const isMp3 = /\.mp3$/i.test(/^https?:\/\//i.test(String(input)) ? new URL(input).pathname : String(input));
    return isMp3 ? await decodedSeconds(copy.file) : await statedSeconds(copy.file);
  } catch (_) {
    return null;
  } finally {
    if (copy && copy.fetched) {
      try {
        fs.unlinkSync(copy.file);
      } catch (_) {
        /* nothing to tidy */
      }
    }
  }
}

// entries: [{ key, url }] — measure each unique key once via its signed URL.
// Twelve at a time: one after another, a feature's thousand-odd clips took
// three to ten minutes before the first frame was drawn.
const PROBE_CONCURRENCY = 12;
async function probeAll(entries) {
  const seen = new Map();
  for (const e of entries) if (!seen.has(e.key)) seen.set(e.key, e.url);
  const todo = [...seen];
  const byKey = new Map();
  if (todo.length) ff.which("ffmpeg"); // no ffmpeg at all: say that, not "clips could not be measured"
  let next = 0;
  let failed = 0;
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, todo.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= todo.length) return;
        const [key, url] = todo[i];
        let d = await probeDuration(url);
        if (d == null && url) d = await probeDuration(url); // once more: a dropped connection is not a missing clip
        if (d == null) failed++;
        byKey.set(key, d);
      }
    })
  );
  // A line whose clip can't be measured is given a moment of silence by the
  // timeline. For a clip or two that is the best that can be done; for many it
  // means the measuring itself is broken, and the video would be timed by
  // guesswork from end to end. That must stop the job, not pass quietly.
  if (failed && (failed === todo.length || failed > todo.length * 0.2)) {
    throw new Error(`${failed} of ${todo.length} clips could not be measured, so the video cannot be timed`);
  }
  if (failed) console.warn(`${failed} of ${todo.length} clips could not be measured (each is given a moment of silence)`);
  return byKey;
}

module.exports = { probeDuration, probeAll, decodedSeconds };
