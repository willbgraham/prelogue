// "Did you mean gmail.com?" — catches the mistyped addresses that bounce.
//
// A sign-in code sent to gmail.con never arrives: the visitor waits, gives up,
// and the bounce counts against our sending reputation (bounces are what get
// an email account suspended). Of the signups made during the 2026 sign-in
// outage, about 3 in 100 had a mistyped domain: gmail.con, gnail.com,
// hotmail.co, and a bare "gmail".
//
// This only ever SUGGESTS. Real domains sit one letter from famous ones
// (cloud.com is not a mistyped icloud.com), so the caller must always let the
// visitor keep exactly what they typed.

/** Providers worth suggesting: where nearly all mistyped consumer addresses belong. */
const FUZZY_TARGETS = [
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "icloud.com",
  "comcast.net",
  "verizon.net",
  "protonmail.com",
  "sbcglobal.net",
];

/**
 * Short names are matched exactly, never by "one letter off": too many real
 * domains are one edit from aol.com or me.com (ao.com, ms.com, he.com).
 */
const EXACT_TARGETS = ["aol.com", "live.com", "msn.com", "me.com", "mac.com", "proton.me"];

/** Real domains that look like a typo of a target. Never "corrected". */
const REAL_LOOKALIKES = new Set([
  "googlemail.com",
  "ymail.com",
  "mail.com",
  "email.com",
  "gmx.com",
  "cloud.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "hotmail.de",
  "hotmail.it",
  "hotmail.es",
  "outlook.co.uk",
  "outlook.fr",
  "outlook.de",
  "outlook.es",
  "outlook.it",
  "yahoo.co.uk",
  "yahoo.ca",
  "yahoo.fr",
  "yahoo.de",
  "yahoo.es",
  "yahoo.it",
  "yahoo.co.in",
  "yahoo.com.au",
  "yahoo.com.br",
  "live.co.uk",
  "live.ca",
  "live.fr",
  "pm.me",
]);

/** Endings that are not real top-level domains, mapped to the one that was meant. */
const TLD_TYPOS: Record<string, string> = {
  con: "com",
  cmo: "com",
  ocm: "com",
  comm: "com",
  como: "com",
  coom: "com",
  vom: "com",
  xom: "com",
  cpm: "com",
  cim: "com",
  clm: "com",
  c0m: "com",
  nte: "net",
  ent: "net",
  nett: "net",
  ogr: "org",
  orgg: "org",
};

/** Edits to turn a into b, where swapping two neighbouring letters counts as one. Stops caring past 2. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => [i, ...new Array<number>(cols - 1).fill(0)]);
  for (let j = 1; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

function fixDomain(domain: string): string | null {
  const targets = [...FUZZY_TARGETS, ...EXACT_TARGETS];
  if (targets.includes(domain) || REAL_LOOKALIKES.has(domain)) return null;

  // "name@gmail" — browsers accept it as an email address; no mail server does.
  if (!domain.includes(".")) {
    return targets.find((t) => t.slice(0, t.lastIndexOf(".")) === domain) ?? null;
  }

  // An ending that isn't a real top-level domain is wrong whoever the provider is.
  const dot = domain.lastIndexOf(".");
  const tld = TLD_TYPOS[domain.slice(dot + 1)];
  const candidate = tld ? `${domain.slice(0, dot)}.${tld}` : domain;
  if (targets.includes(candidate)) return candidate;
  if (REAL_LOOKALIKES.has(candidate)) return tld ? candidate : null;

  const near = FUZZY_TARGETS.filter((t) => editDistance(candidate, t) === 1);
  if (near.length === 1) return near[0];
  return tld ? candidate : null;
}

/**
 * The address the visitor probably meant, or null when what they typed looks
 * fine. Never changes the part before the @.
 */
export function suggestEmail(email: string): string | null {
  const typed = email.trim();
  const at = typed.lastIndexOf("@");
  if (at < 1 || at === typed.length - 1) return null;
  const fixed = fixDomain(typed.slice(at + 1).toLowerCase());
  return fixed ? `${typed.slice(0, at)}@${fixed}` : null;
}
