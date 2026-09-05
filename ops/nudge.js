// Nudge scheduler — finds writers who uploaded but never paid and asks
// send-nudge to email each one (once per script, guards live server-side).
//
// Candidate = a locked script 20 hours to 14 days old. The lower bound gives
// people a day to convert on their own; the upper bound stops us emailing the
// long-cold backlog forever. All real filtering (already paid, already
// nudged, house account, unlocked meanwhile) happens inside send-nudge, so
// this script can stay a dumb list-and-invoke loop.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. DRY_RUN=1 lists candidates
// and what send-nudge WOULD be asked, without invoking it.

const URL_BASE = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY = process.env.DRY_RUN === "1";
const MAX_PER_RUN = 10;

if (!URL_BASE || !KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}` };

(async () => {
  const newest = new Date(Date.now() - 20 * 3600_000).toISOString();
  const oldest = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();
  const res = await fetch(
    `${URL_BASE}/rest/v1/scripts?select=id,title,writer_id,created_at` +
      `&full_read_unlocked=eq.false&created_at=lt.${newest}&created_at=gt.${oldest}` +
      `&order=created_at.asc&limit=${MAX_PER_RUN}`,
    { headers: svc }
  );
  const candidates = await res.json();
  if (!Array.isArray(candidates)) {
    console.error("candidate query failed:", JSON.stringify(candidates).slice(0, 200));
    process.exit(1);
  }
  console.log(`${candidates.length} candidate script(s)${DRY ? " (DRY RUN — nothing sent)" : ""}`);

  for (const c of candidates) {
    if (DRY) {
      console.log(`  would nudge: "${c.title}" (${c.id.slice(0, 8)}, uploaded ${c.created_at.slice(0, 16)})`);
      continue;
    }
    const out = await fetch(`${URL_BASE}/functions/v1/send-nudge`, {
      method: "POST",
      headers: { ...svc, "Content-Type": "application/json" },
      body: JSON.stringify({ script_id: c.id }),
    })
      .then((r) => r.json())
      .catch((e) => ({ error: String(e) }));
    console.log(`  "${c.title}": ${JSON.stringify(out)}`);
  }
})();
