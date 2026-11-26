// The sign-in page's rules that need no browser: where a visitor may be sent
// once signed in, and what to say when a code can't be sent or is refused.
// Kept apart from the page so each can be checked on its own.

export type AuthFailure = { message?: string; status?: number; code?: string };

/**
 * Where to go after signing in: a path on this site, and nothing else.
 *
 * The page leaves by a full page load to this address, so the address must not
 * be able to name another site. A leading "/" alone doesn't prove that: a
 * browser reads "/\evil.com", and "/" + a tab + "/evil.com", as "//evil.com",
 * which is another site entirely. So the address is resolved the way the
 * browser will resolve it, and it has to come out on this site.
 */
export function safeNext(raw: string | null | undefined, origin: string): string {
  if (!raw || !raw.startsWith("/")) return "/";
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin) return "/";
    const path = `${url.pathname}${url.search}${url.hash}`;
    // "/.//evil.com" resolves, on this site, to the path "//evil.com" — which
    // read a second time is another site. The answer is what gets loaded, so
    // the answer itself must pass.
    if (new URL(path, origin).origin !== origin) return "/";
    // Signing in must not lead back to the sign-in form.
    if (/^\/sign-(?:in|up)(?:[/?#]|$)/.test(path)) return "/";
    return path;
  } catch {
    return "/";
  }
}

/**
 * What to say when a code could not be SENT.
 *
 * Never a raw auth error. When our email provider was down, the server
 * answered 500 and the auth library's message was the literal string "{}" —
 * which is what every new visitor saw for nine weeks, with no idea whether
 * to retry, wait, or give up. Say what happened and give them a way in.
 */
export function sendCodeMessage(err: AuthFailure): string {
  const m = (err.message ?? "").trim();
  if (err.status === 429) {
    // One code per address per minute, and the service says how long is left.
    // That is nearly always someone pressing "Resend" a few seconds after the
    // first code went out, so point them at the email already on its way.
    const wait = /after (\d+) seconds?/i.exec(m);
    if (wait) {
      const n = Number(wait[1]);
      return `A code went out to you moments ago. Look for that email first (the spam folder too). You can ask for another in ${n} second${n === 1 ? "" : "s"}.`;
    }
    return "Too many attempts in a short time — give it a minute and try again.";
  }
  const unreadable = !m || m === "{}" || m.startsWith("{") || (err.status ?? 0) >= 500;
  if (unreadable) {
    return "We couldn't send your code — that's a problem on our side, not yours. Try again in a few minutes, or email hello@prelogue.studio and we'll get you in.";
  }
  return m;
}

/**
 * What to say when a code was REFUSED. Never the auth service's own words
 * ("Token has expired or is invalid"), which tell a visitor nothing they can
 * act on.
 */
export function verifyMessage(err: AuthFailure): string {
  const status = err.status ?? 0;
  if (status === 429) {
    return "Too many tries in a short time. Give it a minute, then try again.";
  }
  if (status === 0 || status >= 500) {
    return "We couldn't check your code just now. That is our side or the connection, not your code. Try again in a moment.";
  }
  return "That code didn't work. Check it against the newest email from us: an older code stops working as soon as a new one is sent. Or send a new code below.";
}
