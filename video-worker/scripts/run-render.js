// Re-renders an EXISTING script (admin "Re-render" / "Change voices"), invoked by
// the render-one GitHub Actions workflow with a script_id. Env: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY. Args: <script_id> [variant] [submission_ids csv].
//
// variant "ocr" is not a render at all: it reads a scanned PDF into script
// lines (src/ocr.js). It rides this workflow because the workflow already
// exists and already has the credentials; nothing Remotion is loaded for it.

const scriptId = process.argv[2];
const variant = process.argv[3] || "ai";
const submissionIds = (process.argv[4] || "")
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
  const { renderScene, exportAudio } = require("../src/renderScene");
  const supabase = makeClient(supabaseUrl, serviceKey);
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
      });
}

const label = variant === "ocr" ? "SCAN" : "RENDER";
startJob()
  .then((r) => {
    console.log(`${label} DONE`, JSON.stringify(r));
    process.exit(0);
  })
  .catch((e) => {
    console.error(`${label} FAIL`, (e && e.message) || e);
    process.exit(1);
  });
