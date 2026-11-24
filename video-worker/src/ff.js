// ffmpeg and ffprobe for the worker's own steps: mixing scene beds under a
// video, joining an MP3, the MP3 beside a video, measuring clips, turning a
// tilted scan upright.
//
// They used to be whatever `apt-get install ffmpeg` put on the runner at the
// start of every job: about ninety packages from Ubuntu's mirror, twenty
// seconds on a good day and ten to fifteen minutes when the mirror was slow
// (four jobs in about ninety over two days in Nov 2026), with the writer's
// card on "Starting up" all the while. The renderer already brings both
// programs with it (one package per platform, installed by `npm ci`) and
// renders with them. So does the worker now, and the job no longer needs
// anything from the mirror.
//
// The renderer's copies are a slimmed build (ffmpeg n7.1 with Remotion
// 4.0.485), and three things about them shaped the code that uses them. Check
// anything new against THIS build, on Linux, before relying on it:
//  - no https on Linux (it reads files and plain http only), so a clip or a
//    bed is fetched by Node first and handed over as a file (localCopy);
//  - no `aloop` filter, and `-stream_loop -1` does not loop: see
//    postMixAmbience for how a bed is repeated;
//  - its ffprobe gives an MP3's length with the encoder's padding left in,
//    about 65 ms more per clip than the sound that plays (and than the ffprobe
//    of ffmpeg 8 that timed every video before): see probe.js, which counts
//    the decoded sound instead of asking.
//
// If the renderer's copy can't be found or won't start, the system's is used
// instead, and the log says which. If neither starts, that is said at once
// rather than discovered as a silent video.

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

const NAMES = ["ffmpeg", "ffprobe"];
// How long one fetch of a clip or a bed may take. A voice clip is a few dozen
// kilobytes; an actor's video clip, some megabytes.
const FETCH_TIMEOUT_MS = 120_000;
const chosen = new Map(); // name → { file, env, source, version }

/**
 * Where the renderer's programs may be: its platform packages sit beside it
 * (`@remotion/compositor-linux-x64-gnu` and the like), and more than one can be
 * installed for the same machine (glibc and musl builds), so each is tried.
 * Found by looking, not by loading the renderer: reading a scan needs ffmpeg
 * too and loads nothing of Remotion's.
 */
function rendererDirs() {
  try {
    const main = require.resolve("@remotion/renderer"); // …/node_modules/@remotion/renderer/dist/index.js
    const scope = main.slice(0, main.lastIndexOf(`${path.sep}renderer${path.sep}`));
    const prefix = `compositor-${process.platform}-${process.arch}`;
    return fs
      .readdirSync(scope)
      .filter((name) => name.startsWith(prefix))
      .sort()
      .map((name) => path.join(scope, name));
  } catch (_) {
    return [];
  }
}

/** The environment the renderer's programs need: their libraries sit beside them. */
function envBeside(dir) {
  const key =
    process.platform === "darwin" ? "DYLD_LIBRARY_PATH" : process.platform === "win32" ? "PATH" : "LD_LIBRARY_PATH";
  const sep = process.platform === "win32" ? ";" : ":";
  return { ...process.env, [key]: process.env[key] ? `${dir}${sep}${process.env[key]}` : dir };
}

/** Does it start? Returns its version line, or null. */
function versionOf(file, env) {
  try {
    const r = childProcess.spawnSync(file, ["-version"], { env, encoding: "utf8", timeout: 20_000 });
    if (r.status !== 0) return null;
    const m = String(r.stdout || "").match(/version (\S+)/);
    return m ? m[1] : "unknown version";
  } catch (_) {
    return null;
  }
}

/**
 * The program to run for `name`, the environment to run it in, and whose it is.
 * Decided once per process.
 */
function which(name) {
  if (!NAMES.includes(name)) throw new Error(`not an ffmpeg program: ${name}`);
  if (chosen.has(name)) return chosen.get(name);
  // A way back, should a newer renderer's copy ever misbehave: PRELOGUE_FF=system
  // in the job's environment uses the machine's own ffmpeg (which the job must
  // then install).
  const preferSystem = process.env.PRELOGUE_FF === "system";
  if (preferSystem) {
    const version = versionOf(name, process.env);
    if (version) {
      const got = { file: name, env: process.env, source: "system", version };
      chosen.set(name, got);
      return got;
    }
  }
  let why = "the renderer's copy was not found";
  for (const dir of rendererDirs()) {
    const file = path.join(dir, process.platform === "win32" ? `${name}.exe` : name);
    if (!fs.existsSync(file)) continue;
    try {
      fs.chmodSync(file, 0o755); // a package unpacked without its mode bits
    } catch (_) {
      /* not ours to change: it either runs or it doesn't */
    }
    const env = envBeside(dir);
    const version = versionOf(file, env);
    if (version) {
      const got = { file, env, source: "renderer", version };
      chosen.set(name, got);
      return got;
    }
    why = "the renderer's copy would not start";
  }
  const version = preferSystem ? null : versionOf(name, process.env);
  if (version) {
    const got = { file: name, env: process.env, source: "system", version };
    chosen.set(name, got);
    console.warn(`${name}: using the system's (${version}); ${why}`);
    return got;
  }
  throw new Error(`${name} is not available: ${why}, and none is installed on this machine`);
}

/** Can `name` be run at all? (For steps that are skipped without it.) */
function available(name) {
  try {
    which(name);
    return true;
  } catch (_) {
    return false;
  }
}

/** One line for the job's log: which programs this job is using. */
function describe() {
  return NAMES.map((n) => {
    try {
      const w = which(n);
      return `${n} ${w.version} (${w.source === "renderer" ? "the renderer's own" : "the system's"})`;
    } catch (e) {
      return `${n}: ${e.message}`;
    }
  }).join("; ");
}

/** Like child_process.execFileSync, for "ffmpeg" or "ffprobe". */
function execFileSync(name, args, options = {}) {
  const w = which(name);
  return childProcess.execFileSync(w.file, args, { ...options, env: w.env });
}

/** Like child_process.execFile (callback form), for "ffmpeg" or "ffprobe". */
function execFile(name, args, options, callback) {
  let w;
  try {
    w = which(name);
  } catch (e) {
    return process.nextTick(() => callback(e, "", ""));
  }
  return childProcess.execFile(w.file, args, { ...options, env: w.env }, callback);
}

/** Like child_process.spawn, for "ffmpeg" or "ffprobe". Throws if the program can't be found. */
function spawn(name, args, options = {}) {
  const w = which(name);
  return childProcess.spawn(w.file, args, { ...options, env: w.env });
}

/** Promise form: resolves { stdout, stderr }, rejects with the error. */
function run(name, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(name, args, options, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })));
  });
}

/**
 * Test hook ("@nosysff" on a job): make sure nothing in this job can be using
 * the system's ffmpeg or ffprobe, by putting impostors that fail loudly ahead
 * of them on the PATH. A job that passes with this set does not need the
 * `apt-get install ffmpeg` step at all.
 */
function forbidSystem() {
  if (process.env.PRELOGUE_NO_SYSTEM_FFMPEG) return; // the supervising parent already did
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-system-ffmpeg-"));
  for (const n of NAMES) {
    const file = path.join(dir, n);
    fs.writeFileSync(file, `#!/bin/sh\necho "the system's ${n} was called: this job must not need it" >&2\nexit 97\n`);
    fs.chmodSync(file, 0o755);
  }
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH || ""}`;
  process.env.PRELOGUE_NO_SYSTEM_FFMPEG = dir;
}

/**
 * Test hook ("@noapt" on a job): put the machine back as it was before the
 * workflow's `apt-get install -y ffmpeg` step ran, by removing exactly the
 * packages that step installed (read from apt's own history). A job that
 * passes after this is a job that passes with the step deleted: nothing it
 * needs came in with those packages, not a program and not a library.
 */
function undoSystemInstall(log = console.log) {
  if (process.env.PRELOGUE_APT_UNDONE) return; // the supervising parent already did
  process.env.PRELOGUE_APT_UNDONE = "1";
  if (process.platform !== "linux") return log("@noapt: not a Linux runner, nothing to undo");
  let history = "";
  try {
    history = fs.readFileSync("/var/log/apt/history.log", "utf8");
  } catch (_) {
    return log("@noapt: apt has no history here, nothing to undo");
  }
  const mine = history
    .split(/\n\s*\n/)
    .filter((block) => /Commandline: apt-get install -y ffmpeg\b/.test(block))
    .pop();
  const line = mine && (mine.match(/^Install: (.*)$/m) || [])[1];
  if (!line) return log("@noapt: the ffmpeg install step left no record, nothing to undo");
  // "libavcodec62:amd64 (7:8.0.1-3ubuntu2, automatic), ffmpeg:amd64 (7:8.0.1-3ubuntu2)"
  const packages = line
    .split(/\),\s*/)
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter((name) => /^[a-z0-9][a-z0-9+.:-]+$/.test(name || ""));
  if (!packages.length) return log("@noapt: no packages named in the install record");
  childProcess.execFileSync("sudo", ["apt-get", "remove", "-y", "-qq", ...packages], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
  });
  const still = childProcess.spawnSync("which", ["ffmpeg"], { encoding: "utf8" });
  log(`@noapt: removed the ${packages.length} packages the ffmpeg install step had added; a system ffmpeg is ${still.status === 0 ? "STILL THERE" : "no longer there"}`);
}

/**
 * A file on this machine holding what `input` points at: the path itself, or a
 * copy fetched into `dir` if it is a web address. The renderer's programs for
 * Linux are built without https, so nothing can be handed to them by address.
 */
async function localCopy(input, dir) {
  if (!/^https?:\/\//i.test(String(input))) return { file: input, fetched: false };
  const ext = path.extname(new URL(input).pathname).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 8);
  const file = path.join(dir, `${require("crypto").randomUUID()}${ext}`);
  // A connection kept open from an earlier fetch can be closed under us, and a
  // busy server answers 5xx now and then: neither means the file is missing.
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt));
    try {
      // A connection that goes quiet without closing would otherwise hold the job for ever.
      const res = await fetch(input, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) {
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        return { file, fetched: true };
      }
      last = new Error(`could not fetch the file (HTTP ${res.status})`);
      if (res.status < 500 && res.status !== 429 && res.status !== 408) break; // it isn't there, or isn't ours to have
    } catch (e) {
      last = new Error(`could not fetch the file (${(e && e.cause && e.cause.code) || (e && e.name === "TimeoutError" ? "no answer in time" : e && e.message) || e})`);
    }
  }
  throw last;
}

module.exports = { which, available, describe, execFileSync, execFile, spawn, run, localCopy, forbidSystem, undoSystemInstall };
