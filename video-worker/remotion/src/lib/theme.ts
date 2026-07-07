// Prelogue "paper" palette — mirrors apps/web globals.css @theme tokens so the
// rendered video matches the site's table-read player.
export const theme = {
  paper: "#faf7ef", // stage / script background (player uses this literal)
  ivory: "#f4eedf",
  ink: "#2a2420",
  brick: "#bc4026",
  tan: "#d9ccb0",
  muted: "#736249",
  taupe: "#5e5141",
} as const;

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;
export const TOP_H = 608; // 1080×608 ≈ 16:9 video screen
export const BOTTOM_H = HEIGHT - TOP_H; // 1312 scrolling-script panel

// Pacing fallbacks (seconds) for lines without audio.
export const SILENT_SEC = 1.2;
export const GAP_SEC = 0.25; // small breath between lines
