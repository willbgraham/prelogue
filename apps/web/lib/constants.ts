export const GENRES = [
  "Action",
  "Adventure",
  "Animation",
  "Comedy",
  "Crime",
  "Documentary",
  "Drama",
  "Family",
  "Fantasy",
  "Historical",
  "Horror",
  "Musical",
  "Mystery",
  "Romance",
  "Sci-Fi",
  "Thriller",
  "War",
  "Western",
] as const;

// ScriptRevolution-style listing metadata. Stored values are the slugs; labels
// are for display. `labelOf` maps a stored value back to its label.
export const FORMATS = [
  { value: "feature", label: "Feature" },
  { value: "tv_pilot", label: "TV Pilot" },
  { value: "web_series", label: "Web Series Pilot" },
  { value: "short", label: "Short" },
  { value: "episode", label: "Episode" },
] as const;

export const AGE_RATINGS = [
  { value: "everyone", label: "Everyone" },
  { value: "13", label: "13+" },
  { value: "17", label: "17+" },
] as const;

export const LISTING_STATUSES = [
  { value: "free", label: "Free to Read" },
  { value: "for_sale", label: "For Sale" },
  { value: "under_option", label: "Under Option" },
  { value: "seeking_finance", label: "Seeking Finance" },
  { value: "in_development", label: "In Development" },
  { value: "produced", label: "Produced" },
  { value: "sold", label: "Sold" },
] as const;

export const labelOf = (
  list: readonly { value: string; label: string }[],
  value?: string | null
): string | null => list.find((x) => x.value === value)?.label ?? null;
