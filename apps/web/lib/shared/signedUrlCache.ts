/**
 * Batched, reusable signed URLs.
 *
 * Two problems this solves, both discovered the hard way:
 *
 * 1. createSignedUrls rejects more than 1000 paths per call. A feature-length
 *    read is well over that, so the whole call 400s, `data` comes back null,
 *    and every clip ends up with an empty src — the read looks generated and
 *    plays nothing. A paying customer hit exactly this on a 101-page script.
 *
 * 2. Every call mints a fresh token, so each page load produced URLs the CDN
 *    had never seen: 100% cache miss, and a full re-download of the entire read
 *    on every listen. That put the project 527% over its egress allowance.
 *    Reusing the same URL turns a replay into a 304 with an empty body.
 *
 * URLs are cached in localStorage keyed by bucket+path and reused until they
 * near expiry. Content-addressed audio paths never change contents, so a stale
 * URL can only be wrong by being expired — which the margin below covers.
 */

const BATCH = 500; // under Supabase's 1000-path ceiling, with room to spare
const DEFAULT_TTL = 7 * 24 * 3600; // 7 days
const REUSE_MARGIN = 6 * 3600; // don't hand out a URL expiring within 6h
const MAX_ENTRIES = 4000; // keep well inside the ~5MB localStorage budget
const STORE_KEY = "prelogue.signedUrls.v1";

type Entry = { url: string; exp: number };
type Store = Record<string, Entry>;

/**
 * Structural shape of the bits of a Supabase client this needs, so the helper
 * works with both the browser and server clients without importing either.
 * createSignedUrls reports failures per path, hence the nullable signedUrl.
 */
type StorageClient = {
  storage: {
    from(bucket: string): {
      createSignedUrls(
        paths: string[],
        expiresIn: number
      ): Promise<{ data: { signedUrl: string | null }[] | null }>;
    };
  };
};

function loadStore(): Store {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(STORE_KEY) || "{}") as Store;
  } catch {
    return {};
  }
}

function saveStore(store: Store) {
  if (typeof window === "undefined") return;
  const now = Date.now() / 1000;
  let entries = Object.entries(store).filter(([, e]) => e.exp > now);
  if (entries.length > MAX_ENTRIES) {
    // Keep the longest-lived; they're the ones most likely to be reused.
    entries.sort((a, b) => b[1].exp - a[1].exp);
    entries = entries.slice(0, MAX_ENTRIES);
  }
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Quota exceeded or storage disabled — signing still works, just uncached.
  }
}

/**
 * Sign `paths` in `bucket`, reusing cached URLs where possible. Returns a
 * path → URL map; a path missing from the map failed to sign.
 */
export async function signPathsCached(
  client: StorageClient,
  bucket: string,
  paths: string[],
  ttl: number = DEFAULT_TTL
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(paths.filter(Boolean))];
  if (!unique.length) return out;

  const now = Date.now() / 1000;
  const store = loadStore();
  const needed: string[] = [];
  for (const p of unique) {
    const hit = store[`${bucket}|${p}`];
    if (hit && hit.exp - now > REUSE_MARGIN) out.set(p, hit.url);
    else needed.push(p);
  }

  for (let i = 0; i < needed.length; i += BATCH) {
    const batch = needed.slice(i, i + BATCH);
    const { data } = await client.storage.from(bucket).createSignedUrls(batch, ttl);
    batch.forEach((p, j) => {
      const url = data?.[j]?.signedUrl;
      if (!url) return;
      out.set(p, url);
      store[`${bucket}|${p}`] = { url, exp: now + ttl };
    });
  }

  if (needed.length) saveStore(store);
  return out;
}
