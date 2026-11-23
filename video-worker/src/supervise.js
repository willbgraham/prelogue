// A render can be killed outright: out of memory, or the runner taken away.
// Nothing inside the process gets to run then, so the export's row would say
// "processing" until a watchdog noticed hours later, and the writer's card
// would sit on a frozen bar the whole time. (Nov 2026: a 3 h 35 min read ran
// out of memory two and a half hours into its render and did exactly that.)
//
// So the job runs as a child of a small process that outlives it. If the child
// dies without settling its own export, the parent settles it: the row is
// marked failed, so the card says so at once and offers "Try again", and what
// the job left in storage is removed. A part job that dies tells the lead, which
// then renders that part itself instead of waiting to notice the silence.
//
// The child says which export is its own by writing the id to RENDER_ID_FILE
// (noteRenderId), so the parent never has to guess from the script and variant.

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Shown on the card as "Render failed — <this>. Try again."
const STOPPED = "it stopped before it finished";

/** Called by the job once its export row exists. A no-op when not supervised. */
function noteRenderId(renderId) {
  const file = process.env.RENDER_ID_FILE;
  if (!file || !renderId) return;
  try {
    fs.writeFileSync(file, String(renderId));
  } catch (_) {
    /* the watchdog in export-read is still there */
  }
}

/**
 * Settle what a dead job left unsettled. Safe to call for a job that settled
 * itself: only a row still "processing" is touched.
 *
 * @param {object} o
 * @param {object} o.supabase      service-role client
 * @param {string} o.scriptId
 * @param {string|null} o.renderId the export the job said was its own, if it got that far
 * @param {{renderId: string, index: number}|null} [o.partOf] set for a part job
 * @param {string} [o.why]         for the job's log
 */
async function recordDeath({ supabase, scriptId, renderId, partOf = null, why = "", log = console.error }) {
  const { BUCKET, dirFor, notePath: partNotePath, removeDir } = require("./parts");
  const { notePath: progressNotePath } = require("./progress");

  if (partOf) {
    // Tell the lead now. It takes over a part whose note says "failed".
    const dir = dirFor(scriptId, partOf.renderId);
    const key = partNotePath(dir, partOf.index);
    let current = null;
    try {
      const { data } = await supabase.storage.from(BUCKET).download(key);
      current = data ? JSON.parse(await data.text()) : null;
    } catch (_) {
      current = null;
    }
    if (current && (current.state === "done" || current.state === "failed")) return { part: "already settled" };
    const note = { v: 1, index: partOf.index, state: "failed", f: 0, error: `the job stopped (${why || "no reason given"})`, updated_at: new Date().toISOString() };
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(key, Buffer.from(JSON.stringify(note)), { contentType: "application/json", cacheControl: "0", upsert: true });
    if (error) throw new Error(`could not record the stopped part: ${error.message}`);
    log(`part ${partOf.index + 1} stopped (${why}); the lead has been told`);
    return { part: "failed" };
  }

  if (!renderId) return { export: "none started" };
  const { data, error } = await supabase
    .from("daily_renders")
    .update({ status: "failed", error: STOPPED })
    .eq("id", renderId)
    .eq("status", "processing")
    .select("id");
  if (error) throw new Error(`could not record the stopped export: ${error.message}`);
  if (!data || !data.length) return { export: "already settled" };
  log(`export ${renderId} stopped (${why}); recorded as failed`);
  // What it left behind: the card's progress note, and any parts.
  try {
    await supabase.storage.from(BUCKET).remove([progressNotePath(scriptId, renderId)]);
  } catch (_) {
    /* nothing reads it once the row has settled */
  }
  await removeDir(supabase, dirFor(scriptId, renderId));
  return { export: "failed" };
}

/**
 * Run the job as a child and resolve with the exit code to pass on.
 *
 * @param {object} o
 * @param {string} o.script        the script to run (the job itself)
 * @param {string[]} o.args        its arguments
 * @param {(info: {renderId: string|null, why: string}) => Promise<unknown>} o.onDeath
 * @param {object} [o.env]
 */
function supervise({ script, args, onDeath, env = process.env, log = console.error }) {
  return new Promise((resolve) => {
    const idFile = path.join(os.tmpdir(), `render-id-${process.pid}-${Date.now()}.txt`);
    const child = spawn(process.execPath, [script, ...args], {
      stdio: "inherit",
      env: { ...env, RENDER_WORKER: "1", RENDER_ID_FILE: idFile },
    });
    // A cancelled or timed-out job is signalled: pass it on and wait, so the
    // child's death is still recorded in the seconds before everything is killed.
    const forward = (signal) => {
      try {
        child.kill(signal);
      } catch (_) {
        /* already gone */
      }
    };
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = signals.map((s) => {
      const h = () => forward(s);
      process.on(s, h);
      return [s, h];
    });
    let settled = false;
    const finish = async (code, signal, failure) => {
      if (settled) return;
      settled = true;
      for (const [s, h] of handlers) process.removeListener(s, h);
      let exit = 0;
      if (code !== 0 || failure) {
        exit = code || 1;
        let renderId = null;
        try {
          renderId = fs.readFileSync(idFile, "utf8").trim() || null;
        } catch (_) {
          renderId = null;
        }
        const why = failure ? `could not start: ${failure.message}` : signal ? `signal ${signal}` : `exit code ${code}`;
        try {
          await onDeath({ renderId, why });
        } catch (e) {
          log("could not settle the stopped job:", (e && e.message) || e);
        }
      }
      try {
        fs.rmSync(idFile, { force: true });
      } catch (_) {
        /* a stray temp file */
      }
      resolve(exit);
    };
    child.on("error", (e) => finish(1, null, e));
    child.on("exit", (code, signal) => finish(code, signal, null));
  });
}

module.exports = { supervise, recordDeath, noteRenderId, STOPPED };
