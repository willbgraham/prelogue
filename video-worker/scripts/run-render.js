// Re-renders an EXISTING script (admin "Re-render" / "Change voices"), invoked by
// the render-one GitHub Actions workflow with a script_id. Env: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY. Args: <script_id> [variant] [submission_ids csv].
//
// variant "ocr" is not a render at all: it reads a scanned PDF into script
// lines (src/ocr.js). It rides this workflow because the workflow already
// exists and already has the credentials; nothing Remotion is loaded for it.

const scriptId = process.argv[2];
// "ai@parts=3" is a test hook: render a short video in three parts anyway
// ("@manual": the part jobs are started by hand rather than by export-read).
// Three more, for proving what happens when things go wrong: "@noparts" (the
// part jobs cannot be started), "@long" (treat the video as too long for one
// job) and "@die=40" (the job is killed outright 40 seconds in).
const [variant, ...hooks] = (process.argv[3] || "ai").split("@");
const forceParts = Number((hooks.find((h) => h.startsWith("parts=")) || "").slice(6)) || undefined;
const manualParts = hooks.includes("manual");
const noParts = hooks.includes("noparts");
const treatAsLong = hooks.includes("long");
const dieAfterSeconds = Number((hooks.find((h) => h.startsWith("die=")) || "").slice(4)) || 0;
// variant "part": the third argument is "<render id>:<part index>" (see src/parts.js).
const partOf = variant === "part" ? (process.argv[4] || "").split(":") : null;
const submissionIds = partOf
  ? []
  : (process.argv[4] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SR;

if (!scriptId) {
  console.error("usage: run-render.js <script_id> [variant] [submission_ids]");
  process.exit(1);
}
if (!supabaseUrl || !serviceKey) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

function startJob() {
  if (variant === "ocr") {
    const { readScan } = require("../src/ocr");
    return readScan({ supabaseUrl, serviceKey, scriptId });
  }
  const { makeClient } = require("../src/supabaseData");
  const { renderScene, exportAudio, getBundle } = require("../src/renderScene");
  const supabase = makeClient(supabaseUrl, serviceKey);
  if (partOf) {
    // One part of a video another job is leading: render it, upload it, done.
    const [renderId, index] = partOf;
    if (!/^[0-9a-f-]{36}$/.test(renderId || "") || !/^\d{1,2}$/.test(index || "")) {
      return Promise.reject(new Error("a part needs <render id>:<part index>"));
    }
    const { runPartJob } = require("../src/parts");
    return runPartJob({
      supabase,
      scriptId,
      renderId,
      index: Number(index),
      renderer: require("@remotion/renderer"),
      getBundle,
    });
  }
  // variant "audio" skips Remotion entirely and just stitches the existing voice
  // clips into one MP3 — which is why audio export has no page limit.
  return variant === "audio"
    ? exportAudio({ supabase, supabaseUrl, serviceKey, scriptId })
    : renderScene({
        supabase,
        supabaseUrl,
        serviceKey,
        scriptId,
        variant,
        submissionIds: submissionIds.length ? submissionIds : undefined,
        forceParts,
        // By hand: every other part counts as started, and is waited for.
        startParts: noParts
          ? async () => {
              throw new Error("test hook: the part jobs were refused");
            }
          : manualParts
            ? async (count) => Array.from({ length: count - 1 }, (_, i) => i + 1)
            : undefined,
        ...(treatAsLong ? { singleJobMaxSeconds: 0 } : {}),
      });
}

const label = variant === "ocr" ? "SCAN" : partOf ? "PART" : "RENDER";

function runJob() {
  if (dieAfterSeconds > 0) {
    // Test hook: die the way an out-of-memory kill does, with nothing getting to run.
    setTimeout(() => process.kill(process.pid, "SIGKILL"), dieAfterSeconds * 1000).unref();
  }
  startJob()
    .then((r) => {
      console.log(`${label} DONE`, JSON.stringify(r));
      process.exit(0);
    })
    .catch((e) => {
      console.error(`${label} FAIL`, (e && e.message) || e);
      process.exit(1);
    });
}

// A render or an export runs as a child of this process, which settles the
// export if the child is killed before it can (see src/supervise.js). Reading a
// scan is not an export and keeps its own failure handling.
if (variant === "ocr" || process.env.RENDER_WORKER) {
  runJob();
} else {
  const { supervise, recordDeath } = require("../src/supervise");
  supervise({
    script: __filename,
    args: process.argv.slice(2),
    onDeath: ({ renderId, why }) => {
      const { makeClient } = require("../src/supabaseData");
      const part = partOf && /^[0-9a-f-]{36}$/.test(partOf[0] || "") && /^\d{1,2}$/.test(partOf[1] || "");
      return recordDeath({
        supabase: makeClient(supabaseUrl, serviceKey),
        scriptId,
        renderId,
        partOf: part ? { renderId: partOf[0], index: Number(partOf[1]) } : null,
        why,
      });
    },
  }).then((code) => process.exit(code));
}
