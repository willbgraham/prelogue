// Cast design system — single source of truth for all colors, spacing, typography
export const colors = {
  bg: "#0a0a0f",
  card: "#16161f",
  cardBorder: "#2a2a3d",
  elevated: "#1e1e2e",
  primary: "#6c5ce7",
  primaryMuted: "rgba(108, 92, 231, 0.15)",
  primaryText: "#ffffff",
  text: "#ffffff",
  textSecondary: "#8b8b9e",
  textMuted: "#4a4a5e",
  red: "#ff7675",
  redMuted: "rgba(255, 118, 117, 0.15)",
  yellow: "#fdcb6e",
  yellowMuted: "rgba(253, 203, 110, 0.15)",
  teal: "#00cec9",
  tealMuted: "rgba(0, 206, 201, 0.15)",
  green: "#00b894",
  greenMuted: "rgba(0, 184, 148, 0.15)",
  pink: "#e84393",
  orange: "#e17055",
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
