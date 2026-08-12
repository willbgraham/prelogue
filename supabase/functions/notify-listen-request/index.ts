// Listen-request notifications — in-app rows AND emails, both server-side.
//
//   { script_id, event: "created" }  → notify the WRITER someone is asking
//   { request_id, event: "decided" } → notify the REQUESTER approved/denied
//
// This function exists because clients can't do either half themselves: the
// RLS hardening (20260804100000) made notifications INSERT self-only, so the
// old client-side "insert a row for the other person" writes were silently
// dropped — and no email path existed at all. Service role does both here.
//
// Anti-abuse: the caller only ever passes ids + an event name. Every piece of
// email content (names, titles, links, the note) is loaded from the database,
// and the recipient is derived — the writer's auth email, or the address
// snapshotted on the request row. Callers must BE the involved party: the
// requester for "created", the script's writer for "decided". Duplicate calls
// are absorbed via the notifications table (created: one per request ever;
// decided: one per request+status per 30s window, so re-decisions still send).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { brandEmail, esc } from "../_shared/brandEmail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM = Deno.env.get("NOTIFY_FROM") ?? "Prelogue <notifications@send.prelogue.studio>";
const REPLY_TO = "hello@prelogue.studio";
const SITE = "https://prelogue.studio";

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function sendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY) return { sent: false, reason: "email provider not configured" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to, reply_to: REPLY_TO, subject, html }),
  });
  if (!res.ok) return { sent: false, error: (await res.text()).slice(0, 300) };
  return { sent: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { script_id, request_id, event } = await req.json();
    if (event !== "created" && event !== "decided") {
      return json({ error: "event must be created|decided" }, 400);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const {
      data: { user },
    } = await createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    }).auth.getUser();
    if (!user) return json({ error: "Not authorized" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ── created: the requester tells us their own new request exists ──
    if (event === "created") {
      if (!script_id) return json({ error: "script_id required" }, 400);
      const { data: reqRow } = await admin
        .from("listen_requests")
        .select("id, email, note, status, created_at")
        .eq("script_id", script_id)
        .eq("requester_id", user.id)
        .maybeSingle();
      if (!reqRow) return json({ error: "no request found" }, 404);
      if (reqRow.status !== "pending") return json({ error: "already decided" }, 409);
      // Replay guard: only a freshly created request may trigger the email.
      if (Date.now() - new Date(reqRow.created_at).getTime() > 15 * 60_000) {
        return json({ error: "request too old to notify" }, 409);
      }

      const { data: script } = await admin
        .from("scripts")
        .select("title, slug, writer_id")
        .eq("id", script_id)
        .single();
      if (!script) return json({ error: "script not found" }, 404);

      // One writer notification per request, ever.
      const { data: dupe } = await admin
        .from("notifications")
        .select("id")
        .eq("user_id", script.writer_id)
        .eq("type", "listen_request")
        .eq("payload->>request_id", reqRow.id)
        .maybeSingle();
      if (dupe) return json({ ok: true, deduped: true });

      const { data: requester } = await admin
        .from("users")
        .select("display_name, links")
        .eq("id", user.id)
        .single();
      const name = requester?.display_name || "Someone";
      const links = (requester?.links ?? {}) as Record<string, string>;

      await admin.from("notifications").insert({
        user_id: script.writer_id,
        type: "listen_request",
        payload: {
          request_id: reqRow.id,
          script_id,
          script_slug: script.slug,
          script_title: script.title,
          requester_name: name,
          message: `${name} asked to listen to "${script.title}"`,
        },
      });

      const { data: writerAuth } = await admin.auth.admin.getUserById(script.writer_id);
      const writerEmail = writerAuth?.user?.email;
      let emailResult: unknown = { sent: false, reason: "writer has no email" };
      if (writerEmail) {
        const rows = [
          `<p style="margin:0 0 14px;"><strong style="color:#2A2420;">${esc(name)}</strong> asked to listen to <strong style="color:#2A2420;">&ldquo;${esc(script.title)}&rdquo;</strong>.</p>`,
          `<p style="margin:0 0 6px;color:#2A2420;"><strong>Who they are</strong></p>`,
          `<p style="margin:0 0 14px;">${esc(reqRow.email ?? "")}${links.linkedin ? `<br>LinkedIn: ${esc(links.linkedin)}` : ""}${links.imdb ? `<br>IMDb: ${esc(links.imdb)}` : ""}</p>`,
          reqRow.note
            ? `<p style="margin:0 0 14px;padding:12px 16px;background:#EDE4CE;border-radius:8px;font-style:italic;">&ldquo;${esc(reqRow.note)}&rdquo;</p>`
            : "",
          `<p style="margin:0 0 14px;">Approve or deny from your script page — they'll be emailed your decision.</p>`,
        ].join("");
        emailResult = await sendEmail(
          writerEmail,
          `${name} wants to listen to "${script.title}"`,
          brandEmail({
            heading: `New listen request for “${script.title}”`,
            bodyHtml: rows,
            cta: { label: "Review the request", url: `${SITE}/script/${script.slug ?? script_id}` },
            footnote: "You're receiving this because someone requested access to your script on prelogue.studio.",
          })
        );
      }
      return json({ ok: true, email: emailResult });
    }

    // ── decided: the writer tells us they approved/denied ──
    if (!request_id) return json({ error: "request_id required" }, 400);
    const { data: reqRow } = await admin
      .from("listen_requests")
      .select("id, script_id, requester_id, email, status, decided_at")
      .eq("id", request_id)
      .maybeSingle();
    if (!reqRow) return json({ error: "request not found" }, 404);
    if (reqRow.status !== "approved" && reqRow.status !== "denied") {
      return json({ error: "request not decided yet" }, 409);
    }

    const { data: script } = await admin
      .from("scripts")
      .select("title, slug, writer_id")
      .eq("id", reqRow.script_id)
      .single();
    if (!script || script.writer_id !== user.id) return json({ error: "Not authorized" }, 403);

    // Absorb double-clicks, but let a real re-decision (deny→approve) email again.
    const { data: dupe } = await admin
      .from("notifications")
      .select("id")
      .eq("user_id", reqRow.requester_id)
      .eq("type", "listen_request_decided")
      .eq("payload->>request_id", reqRow.id)
      .eq("payload->>status", reqRow.status)
      .gte("created_at", new Date(Date.now() - 30_000).toISOString())
      .maybeSingle();
    if (dupe) return json({ ok: true, deduped: true });

    const approved = reqRow.status === "approved";
    await admin.from("notifications").insert({
      user_id: reqRow.requester_id,
      type: "listen_request_decided",
      payload: {
        request_id: reqRow.id,
        script_id: reqRow.script_id,
        script_slug: script.slug,
        script_title: script.title,
        status: reqRow.status,
        message: approved
          ? `You're approved to listen to "${script.title}"`
          : `Your listen request for "${script.title}" wasn't approved`,
      },
    });

    // Prefer the address snapshotted at request time; fall back to auth email.
    let to = reqRow.email;
    if (!to) {
      const { data: reqAuth } = await admin.auth.admin.getUserById(reqRow.requester_id);
      to = reqAuth?.user?.email ?? null;
    }
    let emailResult: unknown = { sent: false, reason: "requester has no email" };
    if (to) {
      const { data: writer } = await admin
        .from("users")
        .select("display_name")
        .eq("id", script.writer_id)
        .single();
      const writerName = writer?.display_name || "The writer";
      emailResult = approved
        ? await sendEmail(
            to,
            `You're approved to listen to "${script.title}"`,
            brandEmail({
              heading: `${writerName} approved you to listen to “${script.title}”`,
              bodyHtml: `<p style="margin:0 0 14px;">Your table read is ready. Sign in with <strong style="color:#2A2420;">${esc(to)}</strong> — this exact address — and press play.</p>`,
              cta: { label: "Listen now", url: `${SITE}/script/${script.slug ?? reqRow.script_id}` },
              footnote: "You're receiving this because you requested access to a script on prelogue.studio.",
            })
          )
        : await sendEmail(
            to,
            `About your listen request for "${script.title}"`,
            brandEmail({
              heading: `Your request for “${script.title}”`,
              bodyHtml: `<p style="margin:0 0 14px;">${esc(writerName)} isn't opening this script up right now, so your listen request wasn't approved. That's often about timing or a project's stage rather than anything about you.</p><p style="margin:0 0 14px;">There's plenty more being read aloud on Prelogue.</p>`,
              cta: { label: "Browse scripts on Discover", url: `${SITE}/discover` },
              footnote: "You're receiving this because you requested access to a script on prelogue.studio.",
            })
          );
    }
    return json({ ok: true, email: emailResult });
  } catch (err) {
    console.error("notify-listen-request error:", err);
    return json({ error: "Internal error" }, 500);
  }
});
