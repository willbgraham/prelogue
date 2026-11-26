/**
 * Fire a Meta pixel conversion event. No-ops when the pixel hasn't loaded
 * (ad blockers, SSR, local dev), so callers never need to guard.
 */
export function track(event: string, params?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  const fbq = (window as unknown as { fbq?: (...a: unknown[]) => void }).fbq;
  if (typeof fbq !== "function") return;
  try {
    fbq("track", event, params);
  } catch {
    /* never let analytics break a flow */
  }
}

/** Fire an event at most once per browser, keyed by id (e.g. a purchase whose
 *  success URL the user might reload). */
export function trackOnce(key: string, event: string, params?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  try {
    const k = `pl:evt:${key}`;
    if (window.localStorage.getItem(k)) return;
    window.localStorage.setItem(k, "1");
  } catch {
    /* private mode — fall through and just fire it */
  }
  track(event, params);
}

const PENDING_KEY = "pl:evt:pending";
type PendingEvent = { key: string; event: string; params?: Record<string, unknown> };

function readPending(): PendingEvent[] {
  const raw = window.sessionStorage.getItem(PENDING_KEY);
  const list: unknown = raw ? JSON.parse(raw) : [];
  return Array.isArray(list)
    ? list.filter(
        (p): p is PendingEvent =>
          !!p && typeof p.key === "string" && typeof p.event === "string"
      )
    : [];
}

/**
 * `trackOnce`, for the moment just before this page is left by a full page
 * load (signing in). An event fired at that moment is often never sent: the
 * browser drops the old page's requests as the new one loads. So the event is
 * noted here and fired by the next page, once the pixel is there
 * (`flushPendingEvents`, run by the pixel component on every page load).
 */
export function trackOnceOnNextPage(
  key: string,
  event: string,
  params?: Record<string, unknown>
) {
  if (typeof window === "undefined") return;
  try {
    const list = readPending();
    if (!list.some((p) => p.key === key)) list.push({ key, event, params });
    window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-10)));
  } catch {
    // No session storage (some private modes): fire it now, the old way.
    trackOnce(key, event, params);
  }
}

/**
 * Fire the events noted by `trackOnceOnNextPage`. The pixel's own snippet runs
 * a moment after the page becomes interactive, so this looks for it for a few
 * seconds. If there is no pixel on this page at all (blocked, or switched off),
 * the events are let go WITHOUT being marked as fired, so a later sign-in on
 * this browser can still count.
 */
export function flushPendingEvents(tries = 40, everyMs = 250) {
  if (typeof window === "undefined") return;
  let list: PendingEvent[];
  try {
    list = readPending();
  } catch {
    return;
  }
  if (!list.length) return;
  const clear = () => {
    try {
      window.sessionStorage.removeItem(PENDING_KEY);
    } catch {
      /* nothing to clear */
    }
  };
  const attempt = (left: number) => {
    const fbq = (window as unknown as { fbq?: unknown }).fbq;
    if (typeof fbq === "function") {
      clear();
      for (const p of list) trackOnce(p.key, p.event, p.params);
      return;
    }
    if (left <= 0) {
      clear();
      return;
    }
    window.setTimeout(() => attempt(left - 1), everyMs);
  };
  attempt(tries);
}
