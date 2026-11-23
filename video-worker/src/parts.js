// Rendering one long video as parts on several jobs at once, then joining them.
//
// One job (the "lead") measures the read, writes a plan to storage, asks for the
// other parts to be started, and renders the first part itself. Each part job
// reads the plan, renders its own range of frames and uploads the result. The
// lead then joins the parts — no re-encoding — into the file it would have made
// alone. This is Remotion's own recipe for distributed rendering, followed to
// the letter (https://www.remotion.dev/docs/distributed-rendering): every part
// the same length but the last, `h264-ts` chunks, audio rendered separately for
// a seamless AAC join, and `combineChunks()` at the end. Checked against a
// whole render of the same scene: same frames, same samples, no step at a join.
//
// A part that fails, stalls or never starts is rendered by the lead itself, so
// a lost job costs time, never the export. If the other jobs cannot be started
// at all, the caller renders on one job as it always did.
//
// Everything lives under <script>/parts/<render>/ in the private exports bucket
// and is removed when the export settles:
//   plan.json       what to render (the composition's props and the ranges)
//   part-003.json   that part's state and progress
//   v-003.ts        its video        a-003.aac   its audio

const path = require("path");
const os = require("os");
const fs = require("fs");
const { renderFraction } = require("./progress");

const BUCKET = "daily-renders";
const PLAN_VERSION = 1;

const pad = (i) => String(i).padStart(3, "0");
const dirFor = (scriptId, renderId) => `${scriptId}/parts/${renderId}`;
const planPath = (dir) => `${dir}/plan.json`;
const notePath = (dir, i) => `${dir}/part-${pad(i)}.json`;
const videoPath = (dir, i) => `${dir}/v-${pad(i)}.ts`;
const audioPath = (dir, i) => `${dir}/a-${pad(i)}.aac`;

// How long the lead waits before deciding a part is not coming.
const DEFAULTS = {
  pollMs: 10_000, // how often the lead looks at the other parts
  neverStartedMs: 12 * 60_000, // dispatched, but no word from the job at all
  staleMs: 15 * 60_000, // was reporting, then stopped
  budgetMs: 4.75 * 3600_000, // the lead's own job is stopped at 5½ hours
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function putJson(supabase, key, value) {
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(key, Buffer.from(JSON.stringify(value)), {
      contentType: "application/json",
      cacheControl: "0",
      upsert: true,
    });
  if (error) throw new Error(`could not write ${key}: ${error.message}`);
}

async function getJson(supabase, key) {
  const { data, error } = await supabase.storage.from(BUCKET).download(key);
  if (error || !data) return null;
  try {
    return JSON.parse(await data.text());
  } catch (_) {
    return null;
  }
}

async function putFile(supabase, key, file, contentType) {
  // Three tries: a part is half an hour of rendering, not worth losing to one dropped upload.
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(key, fs.readFileSync(file), { contentType, upsert: true });
    if (!error) return;
    last = error;
    await sleep(2000 * (attempt + 1));
  }
  throw new Error(`could not upload ${key}: ${last && last.message}`);
}

async function getFile(supabase, key, file) {
  const { data, error } = await supabase.storage.from(BUCKET).download(key);
  if (error || !data) throw new Error(`could not fetch ${key}: ${error ? error.message : "empty"}`);
  fs.writeFileSync(file, Buffer.from(await data.arrayBuffer()));
}

async function removeDir(supabase, dir) {
  try {
    const { data } = await supabase.storage.from(BUCKET).list(dir, { limit: 200 });
    const keys = (data || []).map((o) => `${dir}/${o.name}`);
    if (keys.length) await supabase.storage.from(BUCKET).remove(keys);
  } catch (_) {
    /* leftovers are private and small next to a finished export; never worth a failure */
  }
}

/** The encoder settings every part must share (and the join must be told about). */
function heldOptions(held) {
  return held && held.videoKbps
    ? {
        audioBitrate: `${held.audioKbps}k`,
        encodingMaxRate: `${held.videoKbps}k`,
        encodingBufferSize: `${held.videoKbps * 2}k`,
      }
    : {};
}

/**
 * Render one part: frames [from, to] of the composition, as a video chunk and a
 * separate audio chunk. Used by part jobs and by the lead alike.
 */
async function renderPart({ renderer, serveUrl, composition, props, range, held, outDir, index, onProgress }) {
  const video = path.join(outDir, `v-${pad(index)}.ts`);
  const audio = path.join(outDir, `a-${pad(index)}.aac`);
  const frames = range[1] - range[0] + 1;
  await renderer.renderMedia({
    serveUrl,
    composition,
    inputProps: props,
    // The distributed recipe — the same for every part, or the join shows.
    codec: "h264-ts",
    frameRange: range,
    compositionStart: 0,
    enforceAudioTrack: true,
    forSeamlessAacConcatenation: true,
    separateAudioTo: audio,
    numberOfGifLoops: null,
    outputLocation: video,
    concurrency: Math.min(os.cpus().length, 4),
    chromiumOptions: { gl: "swiftshader", headless: true },
    ...heldOptions(held),
    onProgress: (f) => onProgress && onProgress(renderFraction(f, frames)),
  });
  return { video, audio };
}

/** A part's own note: its state and how far it has got. Never throws; `set` waits, `progress` does not. */
function partNote(supabase, dir, index, { now = Date.now, everyMs = 10_000 } = {}) {
  const key = notePath(dir, index);
  let state = "starting";
  let f = 0;
  let error = null;
  let lastWrite = -Infinity;
  let writing = null;
  const body = () => ({ v: 1, index, state, f, error, updated_at: new Date(now()).toISOString() });
  const write = () => {
    lastWrite = now();
    writing = putJson(supabase, key, body())
      .catch(() => {})
      .then(() => {
        writing = null;
      });
    return writing;
  };
  return {
    progress(fraction) {
      if (!(fraction >= 0)) return;
      f = Math.min(1, Math.max(f, fraction));
      if (!writing && now() - lastWrite >= everyMs) write();
    },
    /** A change of state is written now, and waited for (twice over, for "done" and "failed"). */
    async set(next, extra = {}) {
      state = next;
      if (extra.f != null) f = extra.f;
      if (extra.error) error = String(extra.error).slice(0, 300);
      if (writing) await writing;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          lastWrite = now();
          await putJson(supabase, key, body());
          return;
        } catch (_) {
          await sleep(1500 * (attempt + 1));
        }
      }
    },
  };
}

/**
 * A part job: render one part of someone else's plan and upload it.
 * Touches nothing but its own three files.
 */
async function runPartJob({ supabase, scriptId, renderId, index, renderer, getBundle, log = console.log, noteEveryMs }) {
  const dir = dirFor(scriptId, renderId);
  const note = partNote(supabase, dir, index, noteEveryMs ? { everyMs: noteEveryMs } : {});
  await note.set("starting");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `part-${pad(index)}-`));
  try {
    const plan = await getJson(supabase, planPath(dir));
    if (!plan) throw new Error("no plan found for this export");
    if (plan.v !== PLAN_VERSION) throw new Error(`plan version ${plan.v} is not one this worker understands`);
    const range = plan.ranges[index];
    if (!range) throw new Error(`the plan has no part ${index}`);

    const serveUrl = await getBundle();
    const composition = await renderer.selectComposition({ serveUrl, id: "DailyScene", inputProps: plan.props });
    if (composition.durationInFrames !== plan.durationInFrames || composition.fps !== plan.fps) {
      throw new Error(
        `this worker lays the video out differently from the plan (${composition.durationInFrames} frames at ${composition.fps} vs ${plan.durationInFrames} at ${plan.fps})`
      );
    }
    await note.set("rendering");
    log(`part ${index + 1} of ${plan.ranges.length}: frames ${range[0]}–${range[1]}`);
    const made = await renderPart({
      renderer,
      serveUrl,
      composition,
      props: plan.props,
      range,
      held: plan.held,
      outDir: tmp,
      index,
      onProgress: (f) => note.progress(f),
    });
    await note.set("uploading", { f: 1 });
    await putFile(supabase, audioPath(dir, index), made.audio, "audio/aac");
    await putFile(supabase, videoPath(dir, index), made.video, "video/mp2t");
    await note.set("done", { f: 1 });
    log(`part ${index + 1} uploaded`);
    return { index, frames: range[1] - range[0] + 1 };
  } catch (e) {
    await note.set("failed", { error: (e && e.message) || e });
    throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Ask export-read (which holds the GitHub token) to start the other parts. Resolves with the indexes started. */
async function requestParts({ supabaseUrl, serviceKey, scriptId, renderId, parts, ref }) {
  const res = await fetch(`${supabaseUrl}/functions/v1/export-read`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "parts", script_id: scriptId, render_id: renderId, parts, ref }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(out.started)) {
    throw new Error(`the part jobs could not be started (${res.status}${out.error ? `: ${out.error}` : ""})`);
  }
  return out.started.map(Number);
}

/**
 * The lead's side: write the plan, get the other parts started, render part 0,
 * watch the rest (rendering any that are lost), then join. Resolves with the
 * path of the joined MP4.
 *
 * Throws `PartsUnavailable` if no other job could be started at all — nothing
 * has been rendered by then, and the caller should render on one job instead.
 */
class PartsUnavailable extends Error {}

async function renderInParts({
  supabase,
  supabaseUrl,
  serviceKey,
  scriptId,
  renderId,
  variant,
  props,
  composition,
  held,
  plan, // from planParts()
  serveUrl,
  tmp,
  reporter,
  renderer,
  startParts, // (count) => Promise<number[]>; defaults to asking export-read
  options = {},
  log = console.log,
  now = Date.now,
}) {
  const opt = { ...DEFAULTS, ...options };
  const dir = dirFor(scriptId, renderId);
  const { ranges, framesPerPart } = plan;
  const total = composition.durationInFrames;
  const K = ranges.length;
  const began = now();

  await putJson(supabase, planPath(dir), {
    v: PLAN_VERSION,
    renderId,
    scriptId,
    variant,
    fps: composition.fps,
    durationInFrames: total,
    framesPerPart,
    ranges,
    held: held || {},
    props,
  });

  let started;
  try {
    started = await (startParts
      ? startParts(K)
      : requestParts({ supabaseUrl, serviceKey, scriptId, renderId, parts: K, ref: process.env.GITHUB_REF_NAME || undefined }));
  } catch (e) {
    await removeDir(supabase, dir);
    throw new PartsUnavailable((e && e.message) || String(e));
  }
  if (!started.length) {
    await removeDir(supabase, dir);
    throw new PartsUnavailable("no part job was started");
  }
  const dispatchedAt = now();
  log(`rendering in ${K} parts of ${framesPerPart} frames; ${started.length} other job(s) started`);

  // What the lead knows about each part. Part 0 is its own.
  const parts = ranges.map((range, i) => ({
    index: i,
    range,
    frames: range[1] - range[0] + 1,
    f: 0,
    state: i === 0 ? "mine" : started.includes(i) ? "waiting" : "lost",
    seenAt: null, // when its note last changed
    files: null, // local files, once rendered here or fetched
  }));
  const report = () =>
    reporter && reporter.progress(parts.reduce((sum, p) => sum + p.f * p.frames, 0) / total);

  const look = async () => {
    await Promise.all(
      parts
        .filter((p) => p.state === "waiting" || p.state === "rendering" || p.state === "uploading")
        .map(async (p) => {
          const note = await getJson(supabase, notePath(dir, p.index));
          if (!note) {
            if (now() - dispatchedAt > opt.neverStartedMs) p.state = "lost";
            return;
          }
          const at = new Date(note.updated_at).getTime();
          if (note.state === "failed") {
            log(`part ${p.index + 1} failed on its job (${note.error || "no reason given"}); it will be rendered here`);
            p.state = "lost";
          } else if (note.state === "done") {
            p.state = "done";
            p.f = 1;
          } else {
            p.state = note.state === "uploading" ? "uploading" : "rendering";
            p.f = Math.max(p.f, Math.min(1, Number(note.f) || 0));
            if (isFinite(at) && now() - at > opt.staleMs) {
              log(`part ${p.index + 1} has gone quiet; it will be rendered here`);
              p.state = "lost";
            }
          }
          p.seenAt = isFinite(at) ? at : p.seenAt;
        })
    );
    report();
  };

  // Watch the others while rendering our own part.
  let watching = true;
  const watcher = (async () => {
    while (watching) {
      try {
        await look();
      } catch (_) {
        /* a failed look is tried again on the next round */
      }
      await sleep(opt.pollMs);
    }
  })();

  const renderHere = async (p) => {
    p.files = await renderPart({
      renderer,
      serveUrl,
      composition,
      props,
      range: p.range,
      held,
      outDir: tmp,
      index: p.index,
      onProgress: (f) => {
        p.f = Math.max(p.f, f);
        report();
      },
    });
    p.f = 1;
    p.state = "here";
    report();
  };

  try {
    await renderHere(parts[0]);

    // Wait for the rest; render here whatever is lost.
    for (;;) {
      if (now() - began > opt.budgetMs) {
        throw new Error("the parts did not all arrive in time — try again");
      }
      const lost = parts.find((p) => p.state === "lost");
      if (lost) {
        log(`rendering part ${lost.index + 1} here`);
        lost.f = 0;
        await renderHere(lost);
        continue;
      }
      if (parts.every((p) => p.state === "here" || p.state === "done")) break;
      await sleep(Math.min(opt.pollMs, 5000));
    }
  } finally {
    watching = false;
    await watcher;
  }

  // Fetch what the other jobs made (a part that cannot be fetched is rendered here).
  if (reporter) reporter.stage("finishing");
  for (const p of parts) {
    if (p.files) continue;
    const video = path.join(tmp, `v-${pad(p.index)}.ts`);
    const audio = path.join(tmp, `a-${pad(p.index)}.aac`);
    try {
      await getFile(supabase, videoPath(dir, p.index), video);
      await getFile(supabase, audioPath(dir, p.index), audio);
      p.files = { video, audio };
    } catch (e) {
      log(`part ${p.index + 1} could not be fetched (${(e && e.message) || e}); rendering it here`);
      await renderHere(p);
    }
  }

  const outPath = path.join(tmp, "out.mp4");
  const options2 = heldOptions(held);
  await renderer.combineChunks({
    outputLocation: outPath,
    videoFiles: parts.map((p) => p.files.video),
    audioFiles: parts.map((p) => p.files.audio),
    codec: "h264",
    fps: composition.fps,
    framesPerChunk: framesPerPart,
    preferLossless: false,
    compositionDurationInFrames: total,
    ...(options2.audioBitrate ? { audioBitrate: options2.audioBitrate } : {}),
  });
  const lostCount = parts.filter((p) => p.state === "here" && p.index !== 0).length;
  log(`joined ${K} parts${lostCount ? ` (${lostCount} rendered here after their jobs were lost)` : ""}`);
  return outPath;
}

module.exports = {
  renderInParts,
  runPartJob,
  renderPart,
  requestParts,
  removeDir,
  dirFor,
  planPath,
  notePath,
  videoPath,
  audioPath,
  PartsUnavailable,
  PLAN_VERSION,
  BUCKET,
};
