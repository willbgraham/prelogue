/**
 * A short-lived pass that lets parse-script ask extract-script-text to read ONE
 * stored file. parse-script has already checked that the caller owns the script
 * (or is an admin / the service role); the ticket carries that decision across
 * the function-to-function call so the extractor doesn't repeat three database
 * round trips on every slice of a long script.
 *
 * Format:  base64url(JSON {p: storage path, e: expiry ms}) + "." + base64url(HMAC-SHA256)
 * The key is derived from a secret both functions already hold and nobody else
 * does (the service-role key), so a ticket can't be forged or altered, and it
 * names one file and dies in two minutes, so a leaked one is close to useless.
 * It travels in the request body, which the platform does not log.
 */

const TICKET_TTL_MS = 120_000;
const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// (Return type left to inference: backed by a plain ArrayBuffer, which is what
// WebCrypto's types ask for on every TypeScript version.)
function unb64url(s: string) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  // Namespaced so the raw service key is never used directly as an HMAC key
  // for anything else.
  return await crypto.subtle.importKey(
    "raw",
    enc.encode(`prelogue/extract-ticket/v1:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signTicket(
  path: string,
  secret: string,
  now: number = Date.now()
): Promise<string> {
  if (!secret) throw new Error("extract ticket: no signing secret");
  const payload = b64url(enc.encode(JSON.stringify({ p: path, e: now + TICKET_TTL_MS })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

/** The storage path the ticket grants, or null if it is forged, altered or expired. */
export async function verifyTicket(
  ticket: unknown,
  secret: string,
  now: number = Date.now()
): Promise<string | null> {
  if (typeof ticket !== "string" || !secret) return null;
  const dot = ticket.indexOf(".");
  if (dot <= 0 || dot !== ticket.lastIndexOf(".")) return null;
  const payload = ticket.slice(0, dot);
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      unb64url(ticket.slice(dot + 1)),
      enc.encode(payload)
    );
    if (!ok) return null;
    const body = JSON.parse(new TextDecoder().decode(unb64url(payload)));
    if (typeof body?.p !== "string" || !body.p || typeof body?.e !== "number") return null;
    if (now > body.e) return null;
    return body.p;
  } catch {
    return null;
  }
}
