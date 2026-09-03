// Production canary — walks the customer-critical path every few hours so
// breakage emails hello@ before a customer does. Every check below maps to an
// incident a real paying customer actually hit first:
//
//   site/demo down        → the egress restriction outage (login + contact dead)
//   voice list hang       → the ElevenLabs incident (picker spun forever)
//   clip doesn't serve    → the silent-read class (1000-item signing cap)
//   webhook gate wrong    → payments would stop granting unlocks
//   paired ledger debits  → the concurrent-generation double-billing race
//   zombie renders        → the OOM'd MP4 stuck "processing" for hours
//   dead download links   → the emailed NoSuchKey after a re-export
//
// Read-only by design: never generates audio, never spends credits, never
// touches customer rows. Alerts ride the existing contact-form plumbing
// (contact_messages row + send-contact fn → hello@ + /admin/messages), so the
// workflow needs no secrets beyond SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
// The process also exits 1 on any failure so GitHub's own workflow-failure
// notification acts as a second channel.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Optional: CANARY_TEST_ALERT=1
// injects a fake failure to prove the alert path end to end.

const URL_BASE = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SITE = "https://prelogue.studio";
const DEMO_SCRIPT = "b0078900-0000-4000-8000-000000000009";

if (!URL_BASE || !KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

const svc = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const failures = [];
const notes = [];

function fail(check, detail) {
  failures.push(`${check}: ${detail}`);
  console.error(`✗ ${check} — ${detail}`);
}
function ok(check, detail = "") {
  console.log(`✓ ${check}${detail ? ` — ${detail}` : ""}`);
}

async function timed(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: no response in ${ms / 1000}s`)), ms)),
  ]);
}

async function rest(path) {
  const res = await timed(fetch(`${URL_BASE}/rest/v1/${path}`, { headers: svc }), 15000, "rest");
  if (!res.ok) throw new Error(`REST ${path.split("?")[0]} → HTTP ${res.status}`);
  return res.json();
}

// ── 1. The site a customer (and the ads) land on ──
async function checkSite() {
  try {
    const home = await timed(fetch(SITE, { redirect: "follow" }), 20000, "homepage");
    if (home.status !== 200) return fail("homepage", `HTTP ${home.status}`);
    const demo = await timed(fetch(`${SITE}/script/booth-nine`), 20000, "demo page");
    if (demo.status !== 200) return fail("demo page", `HTTP ${demo.status} (outage-class: SSR can't reach the backend)`);
    ok("site + demo page");
  } catch (e) {
    fail("site", e.message);
  }
}

// ── 2. Backend alive and unrestricted (the egress-outage signature) ──
async function checkBackend() {
  try {
    const res = await timed(
      fetch(`${URL_BASE}/rest/v1/users?select=id`, {
        method: "HEAD",
        headers: { ...svc, Prefer: "count=exact", Range: "0-0" },
      }),
      15000,
      "rest"
    );
    // A restricted project answers every endpoint with a violation message and
    // no content-range; a healthy HEAD count always carries one.
    if (!res.headers.get("content-range")) {
      return fail("backend", `REST returned no count (status ${res.status}) — project restricted or degraded`);
    }
    const auth = await timed(fetch(`${URL_BASE}/auth/v1/health`, { headers: { apikey: KEY } }), 15000, "auth");
    if (!auth.ok) return fail("auth", `health → HTTP ${auth.status} (sign-in emails likely failing)`);
    ok("backend REST + auth");
  } catch (e) {
    fail("backend", e.message);
  }
}

// ── 3. The demo read generates (dry) and its audio actually serves ──
async function checkDemoRead() {
  try {
    const res = await timed(
      fetch(`${URL_BASE}/functions/v1/generate-voice-cues`, {
        method: "POST",
        headers: { ...svc, "Content-Type": "application/json" },
        body: JSON.stringify({ script_id: DEMO_SCRIPT, dry_run: true }),
      }),
      20000,
      "generate-voice-cues"
    );
    const out = await res.json();
    if (out.error) return fail("demo read", `generate-voice-cues error: ${out.error}`);
    if (!out.manifest_path || !(out.total_lines > 0)) {
      return fail("demo read", `no manifest/lines (total_lines=${out.total_lines})`);
    }
    const mf = await timed(
      fetch(`${URL_BASE}/storage/v1/object/sign/scripts/${out.manifest_path}`, {
        method: "POST",
        headers: { ...svc, "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: 300 }),
      }),
      15000,
      "sign manifest"
    ).then((r) => r.json());
    if (!mf.signedURL) return fail("demo read", "couldn't sign the demo manifest");
    const manifest = await timed(fetch(`${URL_BASE}/storage/v1${mf.signedURL}`), 15000, "manifest").then((r) => r.json());
    const clip = manifest?.[0]?.audio_path;
    if (!clip) return fail("demo read", "manifest is empty");
    const cs = await timed(
      fetch(`${URL_BASE}/storage/v1/object/sign/scripts/${clip}`, {
        method: "POST",
        headers: { ...svc, "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: 300 }),
      }),
      15000,
      "sign clip"
    ).then((r) => r.json());
    const audio = await timed(
      fetch(`${URL_BASE}/storage/v1${cs.signedURL}`, { headers: { Range: "bytes=0-1023" } }),
      15000,
      "clip fetch"
    );
    if (audio.status !== 206 && audio.status !== 200) {
      return fail("demo read", `clip fetch → HTTP ${audio.status} (silent-read class)`);
    }
    ok("demo read + audio serving", `${out.total_lines} lines`);
  } catch (e) {
    fail("demo read", e.message);
  }
}

// ── 4. Voice list responds fast enough to be a working picker ──
async function checkVoices() {
  try {
    const res = await timed(
      fetch(`${URL_BASE}/functions/v1/list-voices`, {
        method: "POST",
        headers: { ...svc, "Content-Type": "application/json" },
        body: "{}",
      }),
      25000,
      "list-voices"
    );
    const out = await res.json();
    const n = out?.voices?.length ?? 0;
    if (n < 20) return fail("voice picker", `only ${n} voices (provider degraded?)`);
    ok("voice picker", `${n} voices${out.cached ? " (cached)" : ""}`);
  } catch (e) {
    fail("voice picker", `${e.message} — pickers are hanging for users (ElevenLabs-incident class)`);
  }
}

// ── 5. Payment webhook: deployed, JWT off, signature gate intact ──
async function checkWebhook() {
  try {
    const res = await timed(
      fetch(`${URL_BASE}/functions/v1/stripe-webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      15000,
      "stripe-webhook"
    );
    // 400 = reached the signature check (healthy). 401 = someone redeployed
    // without --no-verify-jwt and ALL payments are silently failing to grant.
    if (res.status === 401) return fail("stripe webhook", "401 — redeployed without --no-verify-jwt; unlocks are NOT being granted");
    if (res.status !== 400) return fail("stripe webhook", `unexpected HTTP ${res.status}`);
    ok("stripe webhook gate");
  } catch (e) {
    fail("stripe webhook", e.message);
  }
}

// ── 6. Emailed download links resolve (durable-link class) ──
async function checkDownloadLinks() {
  try {
    const rows = await rest(
      `daily_renders?select=id&status=eq.ready&order=created_at.desc&limit=1`
    );
    if (!rows.length) return ok("download links", "no ready exports to test");
    const res = await timed(
      fetch(`${URL_BASE}/functions/v1/download-export?render=${rows[0].id}`, { redirect: "manual" }),
      15000,
      "download-export"
    );
    if (res.status !== 302) return fail("download links", `expected 302, got ${res.status} (emailed links broken)`);
    ok("download links resolve");
  } catch (e) {
    fail("download links", e.message);
  }
}

// ── 7. Billing tripwire: paired generation debits (double-billing race) ──
async function checkLedger() {
  try {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const rows = await rest(
      `credit_ledger?select=user_id,delta,created_at&reason=eq.generation&created_at=gte.${since}&order=user_id,created_at`
    );
    let pairs = 0;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      if (
        a.user_id === b.user_id &&
        a.delta === b.delta &&
        Math.abs(new Date(b.created_at) - new Date(a.created_at)) < 30_000
      ) {
        pairs++;
      }
    }
    if (pairs >= 2) return fail("billing", `${pairs} paired generation debits in 24h — double-billing race may have regressed`);
    ok("billing ledger", `${rows.length} debits, no pair pattern`);
  } catch (e) {
    fail("billing", e.message);
  }
}

// ── 8. Render health: zombies and failure clusters ──
async function checkRenders() {
  try {
    const stale = new Date(Date.now() - 6.5 * 3600_000).toISOString();
    const zombies = await rest(
      `daily_renders?select=id,script_id,created_at&status=eq.processing&created_at=lt.${stale}`
    );
    if (zombies.length) {
      fail("renders", `${zombies.length} render(s) stuck processing >6.5h (zombie class): ${zombies.map((z) => z.id.slice(0, 8)).join(", ")}`);
    }
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const failed = await rest(
      `daily_renders?select=id,error&status=eq.failed&created_at=gte.${since}`
    );
    if (failed.length >= 3) {
      fail("renders", `${failed.length} failed render(s) in 24h — first error: ${(failed[0].error || "?").slice(0, 120)}`);
    } else if (!zombies.length) {
      ok("renders", `${failed.length} failure(s) in 24h, no zombies`);
    }
  } catch (e) {
    fail("renders", e.message);
  }
}

// ── Alert via the contact-form plumbing (email to hello@ + admin panel) ──
async function alert() {
  const body = [
    `The canary found ${failures.length} problem(s) at ${new Date().toISOString()}:`,
    "",
    ...failures.map((f) => `• ${f}`),
    "",
    notes.length ? `Notes: ${notes.join("; ")}` : "",
    "Run details: GitHub → Actions → Production canary.",
  ].join("\n");
  const id = crypto.randomUUID();
  const ins = await fetch(`${URL_BASE}/rest/v1/contact_messages`, {
    method: "POST",
    headers: { ...svc, "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      name: "Production Canary",
      email: "hello@prelogue.studio",
      topic: "ALERT",
      message: body,
    }),
  });
  if (!ins.ok) {
    console.error(`could not store alert (HTTP ${ins.status}) — relying on the workflow-failure email`);
    return;
  }
  const send = await fetch(`${URL_BASE}/functions/v1/send-contact`, {
    method: "POST",
    headers: { ...svc, "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  console.error(`alert email: ${JSON.stringify(send)}`);
}

(async () => {
  await Promise.all([checkSite(), checkBackend(), checkWebhook()]);
  await checkDemoRead();
  await Promise.all([checkVoices(), checkDownloadLinks(), checkLedger(), checkRenders()]);

  if (process.env.CANARY_TEST_ALERT === "1") fail("test", "synthetic failure (CANARY_TEST_ALERT=1) — the alert path works");

  if (failures.length) {
    await alert();
    process.exit(1);
  }
  console.log("canary: all clear");
})();
