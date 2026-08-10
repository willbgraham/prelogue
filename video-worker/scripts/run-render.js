// Re-renders an EXISTING script (admin "Re-render" / "Change voices"), invoked by
// the render-one GitHub Actions workflow with a script_id. Env: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY. Args: <script_id> [variant] [submission_ids csv].
const { makeClient } = require("../src/supabaseData");
const { renderScene, exportAudio } = require("../src/renderScene");

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

const supabase = makeClient(supabaseUrl, serviceKey);

// variant "audio" skips Remotion entirely and just stitches the existing voice
// clips into one MP3 — which is why audio export has no page limit.
const job =
  variant === "audio"
    ? exportAudio({ supabase, supabaseUrl, serviceKey, scriptId })
    : renderScene({
        supabase,
        supabaseUrl,
        serviceKey,
        scriptId,
        variant,
        submissionIds: submissionIds.length ? submissionIds : undefined,
      });

job
  .then((r) => {
    console.log("RENDER DONE", JSON.stringify(r));
    process.exit(0);
  })
  .catch((e) => {
    console.error("RENDER FAIL", (e && e.message) || e);
    process.exit(1);
  });
