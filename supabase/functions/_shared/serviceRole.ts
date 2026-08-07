/**
 * Is this request authenticated as the service role (our own backend — the
 * render worker, ops scripts, internal fn-to-fn calls)?
 *
 * Comparing the bearer to SUPABASE_SERVICE_ROLE_KEY by string is brittle: a
 * project can hold several valid secret keys (legacy `eyJ…` JWTs and the newer
 * `sb_secret_…` format), and the one injected into the function's env need not
 * be the one the caller holds. That mismatch silently made the render worker
 * look like an ordinary user — it got metered for credits against the house
 * account and every render would have failed with 402.
 *
 * So: accept an exact key match, OR a JWT whose role claim is service_role.
 * Reading the claim without verifying the signature is safe here because the
 * Functions gateway validates the JWT before the function ever runs (these
 * functions are deployed with JWT verification on); an unsigned or forged token
 * never reaches this code.
 */
export function isServiceRole(authHeader: string | null | undefined): boolean {
  const bearer = (authHeader ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return false;

  const envKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (envKey && bearer === envKey) return true;

  // Legacy keys are JWTs: {header}.{payload}.{sig}
  const parts = bearer.split(".");
  if (parts.length !== 3) return false;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));
    return payload?.role === "service_role";
  } catch {
    return false;
  }
}
