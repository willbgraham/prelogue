// Pure timeline builder (unit-testable). buildRows is a JS port of
// apps/web/lib/shared/buildRows.ts — the global element index MUST match
// generate-voice-cues + the voice manifest. buildTimeline turns rows + the
// manifest + probed durations into frame-accurate segments for Remotion.
const FPS = 30;
const SILENT_SEC = 1.2;
// No inter-line gap: lines flow back-to-back like the browser player (which
// advances on `ended`). A gap would leave the top screen black between lines.
const GAP_SEC = 0;

function buildRows(parsed, opts = {}) {
  if (!parsed || !parsed.scenes) return [];
  const actorUpper = opts.actorName ? opts.actorName.toUpperCase() : null;
  const rows = [];
  let g = 0;
  for (const scene of parsed.scenes) {
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
        rows.push({ elementIndex: idx, kind, character: el.character_name, text: el.text, sceneHeading: rowHeading });
      } else if (el.type === "action") {
        rows.push({ elementIndex: idx, kind: "narrator", text: el.text, sceneHeading: rowHeading });
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
function buildTimeline(rows, { manifestByIdx, clipsByIdx = new Map(), durationByKey, signedByKey }) {
  const segments = [];
  let cursor = 0;
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
    const durationFrames = Math.max(1, Math.ceil(durSec * FPS));
    segments.push({
      elementIndex: idx,
      startFrame: cursor,
      durationFrames,
      kind: row.kind,
      character: row.character,
      text: row.text,
      sceneHeading: row.sceneHeading,
      media,
    });
    cursor += durationFrames + Math.round(GAP_SEC * FPS);
  }
  return { fps: FPS, segments, totalFrames: cursor };
}

module.exports = { buildRows, buildTimeline, FPS };
