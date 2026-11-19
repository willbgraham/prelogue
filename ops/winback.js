// One-time "your sign-in code never arrived — it's fixed" email to the people
// who asked for a code during the Sep–Nov 2026 sign-in outage and never got in.
//
//   node ops/winback.js                    dry run: build the list; write a
//                                          preview of the email and the list
//                                          itself for review. Sends nothing.
//   node ops/winback.js --test you@x.co    send the email to that one address
//   node ops/winback.js --send --confirm N [--limit K]
//                                          send it. N must equal the "would
//                                          send" count from the dry run, so an
//                                          approved list can't silently grow.
//   --include-wrote-in                     also email people who reported the
//                                          problem through the contact form
//                                          (left out by default: they get a
//                                          personal reply)
//   --out DIR                              where the dry run writes its files
//
// Safe to re-run: anyone Postmark has already logged this email for is
// skipped, so a batch (--limit) can be continued the next day.
//
// It stops at the first error that isn't about one recipient. Sign-in codes
// share this Postmark account, so running into a plan limit or a suspension
// here must not be pushed through.
import dns from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Last sign-in email that was actually delivered, and the moment sign-in came
// back. Nobody who signed up in between could have received a code.
const OUTAGE_START = "2026-09-06 15:26:00+00";
const FIXED_AT = "2026-11-19 20:12:00+00";

const FROM = "Will at Prelogue <hello@prelogue.studio>";
const REPLY_TO = "hello@prelogue.studio";
const SUBJECT = "Your Prelogue sign-in code never arrived. It's fixed.";
const TAG = "winback";
const POSTMARK = process.env.POSTMARK_API ?? "https://api.postmarkapp.com";
const SUPABASE_API = process.env.SUPABASE_API ?? "https://api.supabase.com";

// Ours, test, or monitoring addresses — never customers.
const INTERNAL = [/@resend\.dev$/, /@blackhole\.postmarkapp\.com$/, /@prelogue\.studio$/, /\+canary@/];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

// The ops secrets live in a gitignored file; load it so this runs as-is.
function loadEnv() {
  const file = path.join(ROOT, ".env.supabase.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
loadEnv();
const { SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, POSTMARK_SERVER_TOKEN } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, POSTMARK_SERVER_TOKEN })) {
  if (!v) {
    console.error(`${k} is not set (expected in .env.supabase.local)`);
    process.exit(1);
  }
}

const { brandEmail } = await import(path.join(ROOT, "supabase/functions/_shared/brandEmail.ts"));
const { htmlToText } = await import(path.join(ROOT, "supabase/functions/_shared/sendEmail.ts"));
const { suggestEmail } = await import(path.join(ROOT, "apps/web/lib/emailTypo.ts"));

const p = (text) => `<p style="margin:0 0 14px;">${text}</p>`;
const HTML = brandEmail({
  heading: "Your sign-in code never arrived. That was our fault.",
  bodyHtml: [
    p(
      `Sometime in the last couple of months you asked Prelogue for a sign-in code, and it never came. Our email provider had stopped delivering and we didn't catch it. You did everything right; we didn't. I'm sorry.`
    ),
    p(`<strong style="color:#2A2420;">It's fixed now.</strong> Codes arrive within a few seconds.`),
    p(
      `If you came to hear a screenplay read aloud: upload yours and the first ten lines are free to hear, with more than a thousand voices to cast from.`
    ),
  ].join(""),
  cta: { label: "Sign in to Prelogue", url: "https://prelogue.studio/sign-in" },
  footnote:
    "You're getting this one email because you requested a sign-in code at prelogue.studio and it failed to send. We won't email you about it again.",
});
const TEXT = htmlToText(HTML);

async function sql(query) {
  const res = await fetch(`${SUPABASE_API}/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, read_only: true }),
  });
  if (!res.ok) throw new Error(`database query failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function postmark(method, route, body) {
  const res = await fetch(`${POSTMARK}${route}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": POSTMARK_SERVER_TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const message = (to) => ({
  From: FROM,
  To: to,
  ReplyTo: REPLY_TO,
  Subject: SUBJECT,
  HtmlBody: HTML,
  TextBody: TEXT,
  // Not something the recipient triggered, so it belongs on the broadcast
  // stream, where Postmark adds the unsubscribe link itself.
  MessageStream: "broadcast",
  Tag: TAG,
});

/**
 * Can this domain receive mail at all? One that doesn't exist, or that
 * publishes a "null MX" (a single empty exchange, meaning "we accept no
 * mail"), bounces every time. A lookup that merely fails is not evidence
 * either way, so it doesn't exclude anyone.
 */
const mailable = new Map();
async function canReceiveMail(domain) {
  if (!mailable.has(domain)) {
    mailable.set(
      domain,
      dns
        .resolveMx(domain)
        .then((mx) => mx.some((m) => m.exchange && m.exchange !== "."))
        .catch((err) => {
          if (err.code === "ENOTFOUND") return false;
          // No MX record at all: mail falls back to the domain's own address.
          if (err.code === "ENODATA") return dns.resolve4(domain).then((a) => a.length > 0).catch(() => false);
          return true;
        })
    );
  }
  return mailable.get(domain);
}

async function alreadySent() {
  const out = new Set();
  for (let offset = 0; ; offset += 500) {
    const { status, body } = await postmark(
      "GET",
      `/messages/outbound?count=500&offset=${offset}&tag=${TAG}&messagestream=broadcast`
    );
    if (status !== 200) throw new Error(`could not read Postmark's log (HTTP ${status}): ${body.Message ?? ""}`);
    for (const m of body.Messages ?? []) for (const r of m.Recipients ?? []) out.add(r.toLowerCase());
    if ((body.Messages ?? []).length < 500) return out;
  }
}

async function buildList() {
  const rows = await sql(`
    select lower(u.email) as email, to_char(u.created_at, 'YYYY-MM-DD') as signed_up,
      exists (select 1 from auth.sessions s where s.user_id = u.id and s.created_at >= '${FIXED_AT}') as back_in,
      exists (select 1 from public.scripts sc where sc.writer_id = u.id) as has_script,
      exists (select 1 from public.contact_messages c where lower(c.email) = lower(u.email)) as wrote_in
    from auth.users u
    where u.created_at >= '${OUTAGE_START}' and u.created_at < '${FIXED_AT}' and u.email is not null
    order by u.created_at`);
  const sent = await alreadySent();
  const seen = new Set();
  const list = [];
  for (const r of rows) {
    const domain = r.email.split("@")[1] ?? "";
    let status = "send";
    if (seen.has(r.email)) continue;
    seen.add(r.email);
    if (INTERNAL.some((re) => re.test(r.email))) status = "skip: internal or test address";
    else if (sent.has(r.email)) status = "skip: already sent";
    else if (r.back_in || r.has_script) status = "skip: has signed in since the fix";
    else if (r.wrote_in && !flag("--include-wrote-in")) status = "skip: wrote in (personal reply)";
    // Never "correct" an address and email the guess: it may be someone else's inbox.
    else if (suggestEmail(r.email)) status = "skip: address looks mistyped";
    else if (!(await canReceiveMail(domain))) status = "skip: domain cannot receive mail";
    list.push({ ...r, status });
  }
  return list;
}

function summarize(list) {
  const counts = {};
  for (const r of list) counts[r.status] = (counts[r.status] ?? 0) + 1;
  console.log(`${list.length} people asked for a sign-in code during the outage`);
  for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${k === "send" ? "would send" : k}`);
  }
}

// A refusal that is about this one address; anything else stops the run.
const RECIPIENT_ERRORS = new Set([300, 406]);

async function sendTo(to) {
  const { status, body } = await postmark("POST", "/email", message(to));
  if (status === 200 && body.ErrorCode === 0) return { ok: true };
  return { ok: false, perRecipient: RECIPIENT_ERRORS.has(body.ErrorCode), why: `${body.ErrorCode ?? status}: ${body.Message ?? "no reason given"}` };
}

if (flag("--test")) {
  const to = value("--test");
  if (!to || !to.includes("@")) {
    console.error("--test needs an address");
    process.exit(1);
  }
  const r = await sendTo(to);
  console.log(r.ok ? `test sent to ${to}` : `test NOT sent: ${r.why}`);
  process.exit(r.ok ? 0 : 1);
}

const list = await buildList();
const toSend = list.filter((r) => r.status === "send");
summarize(list);

if (!flag("--send")) {
  const out = value("--out") ?? fs.mkdtempSync(path.join(os.tmpdir(), "winback-"));
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "winback-preview.html"), `<!doctype html><meta charset="utf-8"><title>${SUBJECT}</title>${HTML}`);
  fs.writeFileSync(path.join(out, "winback-preview.txt"), `Subject: ${SUBJECT}\nFrom: ${FROM}\n\n${TEXT}\n`);
  fs.writeFileSync(
    path.join(out, "winback-recipients.csv"),
    ["email,signed_up,status", ...list.map((r) => `${r.email},${r.signed_up},${r.status}`)].join("\n") + "\n"
  );
  console.log(`\nDry run — nothing was sent. Review files are in ${out}`);
  console.log(`To send: node ops/winback.js --send --confirm ${toSend.length}   (add --limit 50 to send in batches)`);
  process.exit(0);
}

if (Number(value("--confirm")) !== toSend.length) {
  console.error(`\n--confirm must be ${toSend.length} (the current "would send" count). Nothing was sent.`);
  process.exit(1);
}
const batch = toSend.slice(0, Number(value("--limit") ?? toSend.length));
console.log(`\nsending to ${batch.length} of ${toSend.length}…`);
let sentCount = 0;
let skipped = 0;
for (const r of batch) {
  const out = await sendTo(r.email);
  if (out.ok) sentCount++;
  else if (out.perRecipient) {
    skipped++;
    console.log(`  skipped ${r.email.replace(/^[^@]*/, "***")} (${out.why})`);
  } else {
    console.error(`\nSTOPPED after ${sentCount} sent: Postmark refused with ${out.why}`);
    console.error("Nothing else was sent. This is an account-level problem — fix it before re-running; sign-in codes use the same account.");
    process.exit(1);
  }
  await new Promise((done) => setTimeout(done, 400));
}
console.log(`done: ${sentCount} sent, ${skipped} skipped, ${toSend.length - batch.length} left for a later run`);
