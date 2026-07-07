// Idempotently create the infra the daily pipeline needs that the service role
// CAN create (unlike the SQL migration): the private `daily-renders` bucket and
// the "Prelogue Originals" house account that owns every generated script.
// Env: SUPABASE_URL, SR (service role). Prints the house account id.
const crypto = require("crypto");
const { makeClient } = require("../src/supabaseData");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SR = process.env.SR;
const HOUSE_EMAIL = "originals@prelogue.studio";
const HOUSE_USERNAME = "prelogue-originals";

async function ensureBucket(supabase) {
  const { data: buckets } = await supabase.storage.listBuckets();
  if ((buckets || []).some((b) => b.name === "daily-renders")) {
    console.log("bucket daily-renders: exists");
    return;
  }
  const { error } = await supabase.storage.createBucket("daily-renders", { public: false });
  if (error && !/exist/i.test(error.message)) throw error;
  console.log("bucket daily-renders: created (private)");
}

async function ensureHouseAccount(supabase) {
  const { data: existing } = await supabase
    .from("users")
    .select("id")
    .eq("username", HOUSE_USERNAME)
    .maybeSingle();
  if (existing) {
    console.log("house account: exists", existing.id);
    return existing.id;
  }
  const { data, error } = await supabase.auth.admin.createUser({
    email: HOUSE_EMAIL,
    email_confirm: true,
    password: crypto.randomUUID() + "Aa1!",
    user_metadata: { display_name: "Prelogue Originals" },
  });
  let id = data && data.user && data.user.id;
  if (error && !/already|registered|exists/i.test(error.message)) throw error;
  if (!id) {
    const { data: list } = await supabase.auth.admin.listUsers();
    const u = (list && list.users || []).find((x) => (x.email || "").toLowerCase() === HOUSE_EMAIL);
    id = u && u.id;
  }
  if (!id) throw new Error("could not resolve house account id");
  await supabase
    .from("users")
    .update({ display_name: "Prelogue Originals", username: HOUSE_USERNAME, role: "writer" })
    .eq("id", id);
  console.log("house account: created", id);
  return id;
}

async function main() {
  if (!SUPABASE_URL || !SR) throw new Error("SUPABASE_URL and SR env vars are required");
  const supabase = makeClient(SUPABASE_URL, SR);
  await ensureBucket(supabase);
  const houseId = await ensureHouseAccount(supabase);
  console.log(`\n✓ HOUSE_ACCOUNT_ID=${houseId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
