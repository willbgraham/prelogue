// End-to-end test of the real render path: renderScene() for a script →
// Remotion render → upload to daily-renders → daily_renders row.
// Env: SUPABASE_URL, SR (service role), optional SCRIPT_ID.
const { makeClient } = require("../src/supabaseData");
const { renderScene } = require("../src/renderScene");

const scriptId = process.env.SCRIPT_ID || "b0078900-0000-4000-8000-000000000009";
const supabase = makeClient(process.env.SUPABASE_URL, process.env.SR);

renderScene({
  supabase,
  supabaseUrl: process.env.SUPABASE_URL,
  serviceKey: process.env.SR,
  scriptId,
  variant: "ai",
})
  .then((r) => {
    console.log("DONE", JSON.stringify(r));
    process.exit(0);
  })
  .catch((e) => {
    console.error("FAIL", (e && e.message) || e);
    process.exit(1);
  });
