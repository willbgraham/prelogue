// The nudge to a writer who uploaded but never paid: the first ten lines of
// their script are free to voice (owner preview), and this email says so.
// Called by ops/nudge.js on a schedule; service-role only.
//
// ONE nudge per writer, ever, about the script of theirs most worth hearing
// (the rule is in _shared/nudgePick.ts):
//
//   { run: true, max?, dry_run? }   find who is due and email them, up to `max`
//                                   (dry_run: decide, send nothing, write nothing)
//   { script_id }                   the same rule for that script's writer. Kept
//                                   for the scheduler script as it was, and for
//                                   use by hand.
//
// Guards, as before: never a writer who has paid for anything, never the house
// account, never a script that has been unlocked.
//
// Answers and log lines never carry an address or a title. The scheduler runs
// on a public repository and its log can be read by anyone.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { brandEmail } from "../_shared/brandEmail.ts";
import { sendEmail } from "../_shared/sendEmail.ts";
import { isServiceRole } from "../_shared/serviceRole.ts";
import { countLines, pickNudges, readsAsScript, type Held, type LockedScript } from "../_shared/nudgePick.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SITE = "https://prelogue.studio";
const HOUSE_WRITER = "e13e3e11";
const PAID_REASONS = ["unlock_grant", "topup", "plan_grant"];
// A day to convert by themselves; after two weeks the upload has gone cold.
const YOUNGEST_HOURS = 20;
const OLDEST_DAYS = 14;
const DEFAULT_MAX = 10;
const HARD_MAX = 25;
const PAGE = 1000;
// Addresses that accept mail and deliver nowhere (checks and test accounts).
const SINK = /@(blackhole\.postmarkapp\.com|resend\.dev)$/i;

// deno-lint-ignore no-explicit-any
type Admin = any;
type ScriptRow = LockedScript & { title: string; slug: string | null };
type LockedRow = Omit<ScriptRow, "reads_as_script">;
type Marker = { id: string; created_at: string; payload: Record<string, unknown> | null };
type NotToday = "nudged_before" | "no_address" | "test_account";
type Outcome = "sent" | "nudged_before" | "refused" | "failed";

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const chunks = <T>(list: T[], n = 80): T[][] =>
  Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n));

/** Every row of a query, a thousand at a time: one request never returns more. */
async function everyRow<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message?: string } | null }>
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`query failed: ${error.message ?? "no reason given"}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return out;
  }
}

/** Everything the rule needs, in as few questions as the tables allow. */
async function gather(admin: Admin, now: number) {
  const { data: adminUser } = await admin.from("users").select("id").eq("is_admin", true).limit(1).maybeSingle();
  if (!adminUser) throw new Error("no admin user to keep the record under");

  const youngest = new Date(now - YOUNGEST_HOURS * 3600_000).toISOString();
  const oldest = new Date(now - OLDEST_DAYS * 24 * 3600_000).toISOString();
  const locked = await everyRow<LockedRow>((from, to) =>
    admin
      .from("scripts")
      .select("id, title, slug, writer_id, created_at, page_count")
      .eq("full_read_unlocked", false)
      .lt("created_at", youngest)
      .gt("created_at", oldest)
      .order("created_at", { ascending: true })
      .range(from, to)
  );
  const writers = [...new Set(locked.map((s) => s.writer_id))];

  const paid = new Set<string>();
  for (const ids of chunks(writers)) {
    const rows = await everyRow<{ user_id: string }>((from, to) =>
      admin.from("credit_ledger").select("user_id").in("user_id", ids).in("reason", PAID_REASONS).range(from, to)
    );
    for (const r of rows) paid.add(r.user_id);
  }

  // The record of nudges already sent: a notifications row for the admin, who
  // reads it as a log. Rows from before this rule name a script, not a
  // writer, so each is traced back to its writer, and its address is kept in
  // case the script has since been deleted.
  const markers = await everyRow<Marker>((from, to) =>
    admin
      .from("notifications")
      .select("id, created_at, payload")
      .eq("user_id", adminUser.id)
      .eq("type", "nudge_email")
      .order("created_at", { ascending: true })
      .range(from, to)
  );
  const nudged = new Set<string>();
  const nudgedAddresses = new Set<string>();
  const unnamed: string[] = [];
  for (const m of markers) {
    const p = m.payload ?? {};
    if (typeof p.writer_id === "string" && p.writer_id) nudged.add(p.writer_id);
    else if (typeof p.script_id === "string" && p.script_id) unnamed.push(p.script_id);
    if (typeof p.email === "string" && p.email) nudgedAddresses.add(p.email.toLowerCase());
  }
  const known = new Map(locked.map((s) => [s.id, s.writer_id]));
  for (const ids of chunks([...new Set(unnamed)].filter((id) => !known.has(id)))) {
    const { data, error } = await admin.from("scripts").select("id, writer_id").in("id", ids);
    if (error) throw new Error(`query failed: ${error.message ?? "no reason given"}`);
    for (const r of data ?? []) known.set(r.id, r.writer_id);
  }
  for (const id of unnamed) {
    const writer = known.get(id);
    if (writer) nudged.add(writer);
  }

  // How each script parsed, asked only about the scripts of writers who could
  // still be due: a parse is large, and most writers are already ruled out.
  const open = locked.filter(
    (s) => !s.writer_id.startsWith(HOUSE_WRITER) && !paid.has(s.writer_id) && !nudged.has(s.writer_id)
  );
  const speaks = new Set<string>();
  for (const ids of chunks(open.map((s) => s.id), 4)) {
    const { data, error } = await admin.from("scripts").select("id, parsed_json").in("id", ids);
    if (error) throw new Error(`query failed: ${error.message ?? "no reason given"}`);
    for (const r of data ?? []) if (readsAsScript(countLines(r.parsed_json))) speaks.add(r.id);
  }

  const scripts: ScriptRow[] = locked.map((s) => ({ ...s, reads_as_script: speaks.has(s.id) }));
  return { adminId: adminUser.id as string, scripts, paid, nudged, nudgedAddresses };
}

/** The writer's address, or why they are not to be written to after all. */
async function addressOf(admin: Admin, writerId: string, nudgedAddresses: Set<string>): Promise<{ to: string } | NotToday> {
  const { data: writerAuth } = await admin.auth.admin.getUserById(writerId);
  const to: string | undefined = writerAuth?.user?.email;
  if (!to) return "no_address";
  if (SINK.test(to) || /\+canary@/i.test(to)) return "test_account";
  // Nudged about a script that has since been deleted: only the address still says so.
  if (nudgedAddresses.has(to.toLowerCase())) return "nudged_before";
  return { to };
}

/** Email one writer about one script, leaving the record that makes it the only time. */
async function nudge(admin: Admin, adminId: string, script: ScriptRow, to: string): Promise<Outcome> {
  // The record goes down first, and the email is sent only if this record is
  // the first for the writer. Two runs at once then send one email, not two.
  const { data: mine, error: claimError } = await admin
    .from("notifications")
    .insert({
      user_id: adminId,
      type: "nudge_email",
      payload: {
        writer_id: script.writer_id,
        script_id: script.id,
        script_title: script.title,
        email: to,
        message: `Nudged ${to} about "${script.title}"`,
      },
    })
    .select("id, created_at")
    .single();
  if (claimError || !mine) return "failed";
  const { data: all } = await admin
    .from("notifications")
    .select("id, created_at")
    .eq("user_id", adminId)
    .eq("type", "nudge_email")
    .eq("payload->>writer_id", script.writer_id)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if ((all ?? []).length > 0 && all[0].id !== mine.id) {
    await admin.from("notifications").delete().eq("id", mine.id);
    return "nudged_before";
  }

  const link = `${SITE}/script/${script.slug ?? script.id}`;
  const result = await sendEmail({
    to,
    subject: `Hear the first lines of "${script.title}" — free`,
    html: brandEmail({
      heading: `“${script.title}” is parsed and ready to speak`,
      bodyHtml: [
        `<p style="margin:0 0 14px;">Your script is uploaded and parsed — and the <strong style="color:#2A2420;">first ten lines are now free to hear</strong>, with the full cast of voices to choose from.</p>`,
        `<p style="margin:0 0 14px;">Open it, pick a voice for each character (there are more than 20,000), and press play. No charge, no card — it's your own opening, performed.</p>`,
        `<p style="margin:0 0 14px;">If it makes you want the rest: one $29 unlock covers the entire script, MP3 and video downloads included.</p>`,
      ].join(""),
      cta: { label: "Hear your opening — free", url: link },
      footnote:
        "You're receiving this once because you uploaded a script on prelogue.studio. Reply if you'd rather not hear from us.",
    }),
    tag: "nudge",
    // The writer didn't ask for this one, so it isn't transactional.
    stream: "broadcast",
  });
  if (result.sent) return "sent";

  // An address the provider will not send to (an earlier bounce, a complaint,
  // an unsubscribe) stays on record, so it isn't tried again every run. Any
  // other failure leaves no record: the next run tries again.
  if (/suppressed/i.test(result.reason)) {
    await admin
      .from("notifications")
      .update({
        payload: {
          writer_id: script.writer_id,
          script_id: script.id,
          script_title: script.title,
          email: to,
          message: `Not nudged (the address is suppressed): ${to}, "${script.title}"`,
        },
      })
      .eq("id", mine.id);
    return "refused";
  }
  await admin.from("notifications").delete().eq("id", mine.id);
  return "failed";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!isServiceRole(auth.replace(/^Bearer\s+/i, ""))) {
      return json({ error: "Not authorized" }, 403);
    }
    const body = await req.json().catch(() => null);
    const runAll = body?.run === true;
    const scriptId: string | null = typeof body?.script_id === "string" && body.script_id ? body.script_id : null;
    if (!runAll && !scriptId) return json({ error: "script_id required" }, 400);
    const dryRun = body?.dry_run === true;

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // One script: the reasons that need no wider look, in the old words.
    if (scriptId) {
      const { data: script } = await admin
        .from("scripts")
        .select("id, writer_id, full_read_unlocked")
        .eq("id", scriptId)
        .maybeSingle();
      if (!script) return json({ sent: false, reason: "script gone" });
      if (script.full_read_unlocked) return json({ sent: false, reason: "already unlocked" });
      if (script.writer_id.startsWith(HOUSE_WRITER)) return json({ sent: false, reason: "house" });
      const { data: paid } = await admin
        .from("credit_ledger")
        .select("id")
        .eq("user_id", script.writer_id)
        .in("reason", PAID_REASONS)
        .limit(1);
      if (paid?.length) return json({ sent: false, reason: "writer has paid before" });

      const g = await gather(admin, Date.now());
      if (g.nudged.has(script.writer_id)) return json({ sent: false, reason: "already nudged" });
      const picked = pickNudges({ scripts: g.scripts, paid: g.paid, nudged: g.nudged, house: HOUSE_WRITER });
      const choice = picked.choices.find((c) => c.writer_id === script.writer_id);
      // The script written about is the writer's best, which may not be this one.
      const about = choice && g.scripts.find((s) => s.id === choice.script_id);
      if (!about) return json({ sent: false, reason: "nothing of this writer's is due a nudge" });
      const who = await addressOf(admin, about.writer_id, g.nudgedAddresses);
      const outcome = typeof who === "string" ? who : dryRun ? "would send" : await nudge(admin, g.adminId, about, who.to);
      return json(
        outcome === "sent"
          ? { sent: true }
          : { sent: false, reason: outcome === "nudged_before" ? "already nudged" : outcome.replace(/_/g, " ") }
      );
    }

    const max = Math.max(0, Math.min(HARD_MAX, Number.isFinite(Number(body?.max)) ? Math.floor(Number(body.max)) : DEFAULT_MAX));
    const g = await gather(admin, Date.now());
    const picked = pickNudges({ scripts: g.scripts, paid: g.paid, nudged: g.nudged, house: HOUSE_WRITER });
    const held: Held & { no_address: number; test_account: number; refused: number } = {
      ...picked.held,
      no_address: 0,
      test_account: 0,
      refused: 0,
    };
    let sent = 0;
    let failed = 0;
    let waiting = 0;
    for (const choice of picked.choices) {
      const about = g.scripts.find((s) => s.id === choice.script_id)!;
      // Everyone due is looked up, so the counts are true; only `max` are sent to.
      const who = await addressOf(admin, about.writer_id, g.nudgedAddresses);
      if (typeof who === "string") {
        held[who]++;
        continue;
      }
      if (sent >= max) {
        waiting++;
        continue;
      }
      const outcome = dryRun ? "sent" : await nudge(admin, g.adminId, about, who.to);
      if (outcome === "sent") sent++;
      else if (outcome === "failed") failed++;
      else held[outcome]++;
    }
    console.log(
      `nudge run${dryRun ? " (dry)" : ""}: ${picked.writers} writers with a locked script in the window, ${sent} ${dryRun ? "would be " : ""}nudged, ${waiting} waiting, ${failed} failed`
    );
    return json({
      run: true,
      dry_run: dryRun,
      scripts: g.scripts.length,
      writers: picked.writers,
      [dryRun ? "would_send" : "sent"]: sent,
      waiting,
      failed,
      held,
    });
  } catch (err) {
    console.error("send-nudge error:", err instanceof Error ? err.message : "unknown");
    return json({ error: "Internal error" }, 500);
  }
});
