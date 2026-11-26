// Nudge scheduler: asks send-nudge to email the writers who uploaded but never
// paid. One email per writer, ever; who is due, and about which script, is
// decided inside the function (supabase/functions/_shared/nudgePick.ts).
//
// This runs on GitHub, on a PUBLIC repository: anyone can read its log. So it
// prints counts and nothing else — never a title, an address or an id. (It
// used to print every candidate's title and the address of everyone it
// emailed.) Whatever the function answers, only its numbers are read.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. DRY_RUN=1 asks what a run
// would do; nothing is sent and nothing is written.

const URL_BASE = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY = process.env.DRY_RUN === "1";
const MAX_PER_RUN = 10;

if (!URL_BASE || !KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

const count = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);

(async () => {
  let status = 0;
  let out = null;
  try {
    const res = await fetch(`${URL_BASE}/functions/v1/send-nudge`, {
      method: "POST",
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ run: true, max: MAX_PER_RUN, dry_run: DRY }),
      signal: AbortSignal.timeout(120_000),
    });
    status = res.status;
    out = await res.json().catch(() => null);
  } catch (e) {
    console.error(`could not reach send-nudge: ${e && e.name === "TimeoutError" ? "no answer in two minutes" : "network error"}`);
    process.exit(1);
  }
  if (status !== 200 || !out || out.run !== true) {
    // An answer without `run` is the function from before this script: it does
    // not know how to run by itself. Say so; do not print what it said.
    console.error(`send-nudge did not run (HTTP ${status}). Nothing was sent by this job.`);
    process.exit(1);
  }

  const held = out.held && typeof out.held === "object" ? out.held : {};
  const why = [
    ["paid", "have paid before"],
    ["nudged_before", "were nudged before"],
    ["nothing_to_cast", "have no script that parsed with dialogue"],
    ["house", "house account"],
    ["test_account", "test accounts"],
    ["no_address", "have no address"],
    ["refused", "at addresses the mail provider will not send to"],
  ]
    .filter(([k]) => count(held[k]) > 0)
    .map(([k, words]) => `${count(held[k])} ${words}`);

  console.log(
    `${count(out.writers)} writer(s) with a locked script 20 hours to 14 days old (${count(out.scripts)} script(s))${DRY ? " — DRY RUN, nothing sent" : ""}`
  );
  console.log(`  ${DRY ? "would be nudged" : "nudged"}: ${count(DRY ? out.would_send : out.sent)}`);
  if (count(out.waiting)) console.log(`  waiting for the next run (${MAX_PER_RUN} a run): ${count(out.waiting)}`);
  if (why.length) console.log(`  held back: ${why.join("; ")}`);
  if (count(out.failed)) {
    console.error(`  ${count(out.failed)} could not be sent and will be tried again next run`);
    process.exit(1);
  }
})();
