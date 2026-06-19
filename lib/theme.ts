// Prelogue design system — single source of truth for all colors, spacing, typography.
// Warm "vintage paper / typewriter" palette drawn from the app icon: parchment
// surfaces, espresso-brown ink, and a brick red-orange accent (the waveform).
export const colors = {
  bg: "#E9DFC9",        // parchment (app background)
  card: "#F4EEDF",      // ivory card surface (lifts off bg)
  cardBorder: "#D9CCB0",// muted tan border (visible on both bg and card)
  elevated: "#FBF7EC",  // highest surface — inputs, sheets
  primary: "#BC4026",   // brick red-orange (the icon waveform)
  primaryMuted: "rgba(188, 64, 38, 0.12)",
  primaryText: "#ffffff",
  text: "#2A2420",      // espresso ink (the icon "P")
  textSecondary: "#5E5141", // warm taupe
  textMuted: "#736249", // muted tan-brown
  red: "#A82F1C",       // deep red (destructive / errors)
  redMuted: "rgba(168, 47, 28, 0.12)",
  yellow: "#A9791F",    // ochre
  yellowMuted: "rgba(169, 121, 31, 0.16)",
  teal: "#2C7E75",      // muted teal
  tealMuted: "rgba(44, 126, 117, 0.14)",
  green: "#3C7A4E",     // forest green (success / unlocked)
  greenMuted: "rgba(60, 122, 78, 0.14)",
  pink: "#B23A72",      // deep rose
  orange: "#BC5A36",    // burnt orange
};

// Genre accent colors — earthy mid-deep tones that read on both the paper
// chrome and the dark performance screens. Single source for every genre chip.
export const genreColors: Record<string, string> = {
  Action: "#A8392A",
  Adventure: "#2E6E8E",
  Animation: "#2E8B57",
  Comedy: "#B07D16",
  Crime: "#574B3F",
  Documentary: "#6E6456",
  Drama: "#B5552F",
  Family: "#C06A4A",
  Fantasy: "#6A4C93",
  Historical: "#8A6A2E",
  Horror: "#7E2E2A",
  Musical: "#A8447A",
  Mystery: "#4C4A7A",
  Romance: "#B23A6B",
  "Sci-Fi": "#2C7E75",
  Thriller: "#9E3024",
  War: "#5C5448",
  Western: "#9C6B3F",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  full: 999,
};

export const fonts = {
  regular: { fontSize: 14, color: colors.text },
  small: { fontSize: 12, color: colors.textSecondary },
  caption: { fontSize: 11, color: colors.textMuted, fontWeight: "600" as const, textTransform: "uppercase" as const, letterSpacing: 1.2 },
  body: { fontSize: 15, color: colors.text, lineHeight: 22 },
  title: { fontSize: 20, color: colors.text, fontWeight: "700" as const },
  heading: { fontSize: 28, color: colors.text, fontWeight: "800" as const },
  hero: { fontSize: 36, color: colors.text, fontWeight: "800" as const },
};
