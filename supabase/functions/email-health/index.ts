// Is our email provider alive? Service-role only; sends nothing.
//
// Exists because of a nine-week outage: the provider suspended our account, so
// every sign-in code, export email, nudge, and contact-form notification
// failed — and the canary's own alert emails rode the same dead account, so
// nobody was told. This asks the provider a harmless read question with the
// exact credential the other functions use, so the canary can fail loudly (via
// GitHub's own notification, which doesn't depend on our email) the day it
// dies.
//
// It also reports which provider is live and that provider's accept-and-
// discard test address, which the canary needs for its real sign-in-code check.
import { emailHealth } from "../_shared/sendEmail.ts";
import { isServiceRole } from "../_shared/serviceRole.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const auth = req.headers.get("Authorization") ?? "";
  if (!isServiceRole(auth.replace(/^Bearer\s+/i, ""))) return json({ error: "Not authorized" }, 403);
  return json(await emailHealth());
});
