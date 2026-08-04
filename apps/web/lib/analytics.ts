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
