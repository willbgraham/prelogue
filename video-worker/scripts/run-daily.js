// Runs the full daily pipeline once: Claude scene → hidden house-account script
// → Remotion render → daily-renders bucket + daily_renders row. Invoked by the
// GitHub Actions schedule. Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// ANTHROPIC_API_KEY (optional ANTHROPIC_MODEL).
const { makeClient } = require("../src/supabaseData");
const { generateAndRenderDaily } = require("../src/daily");

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SR;

if (!supabaseUrl || !serviceKey) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

const supabase = makeClient(supabaseUrl, serviceKey);

generateAndRenderDaily({ supabase, supabaseUrl, serviceKey })
  .then((r) => {
    console.log("DAILY DONE", JSON.stringify(r));
    process.exit(0);
  })
  .catch((e) => {
    console.error("DAILY FAIL", (e && e.message) || e);
    process.exit(1);
  });
