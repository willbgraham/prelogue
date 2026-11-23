const { execFile } = require("child_process");

// The voice manifest carries no durations, so probe each MP3 (and, for the
// composite variant, each actor clip) with ffprobe. Content-addressed paths are
// deduped so a repeated line is probed once.
function probeDuration(input) {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input],
      { maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) return resolve(null);
        const d = parseFloat(String(stdout).trim());
        resolve(Number.isFinite(d) ? d : null);
      }
    );
  });
}

// entries: [{ key, url }] — probe each unique key once via its signed URL.
// Twelve at a time: one after another, a feature's thousand-odd clips took
// three to ten minutes before the first frame was drawn.
const PROBE_CONCURRENCY = 12;
async function probeAll(entries) {
  const seen = new Map();
  for (const e of entries) if (!seen.has(e.key)) seen.set(e.key, e.url);
  const todo = [...seen];
  const byKey = new Map();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, todo.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= todo.length) return;
        const [key, url] = todo[i];
        byKey.set(key, await probeDuration(url));
      }
    })
  );
  return byKey;
}

module.exports = { probeDuration, probeAll };
