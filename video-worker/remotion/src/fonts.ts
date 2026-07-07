// Fonts must be loaded IN the composition (blocking) so headless Chrome paints
// the same glyphs/metrics the pre-measure (layout.ts) assumes — otherwise the
// scroll positions drift. Courier Prime = the mono screenplay face; Roboto Slab
// = headings, matching the web app (next/font/google in apps/web/app/layout.tsx).
import { loadFont as loadCourier } from "@remotion/google-fonts/CourierPrime";
import { loadFont as loadSlab } from "@remotion/google-fonts/RobotoSlab";

const courier = loadCourier("normal", { weights: ["400", "700"], subsets: ["latin"] });
const slab = loadSlab("normal", { weights: ["700"], subsets: ["latin"] });

export const MONO = courier.fontFamily; // Courier Prime
export const SLAB = slab.fontFamily; // Roboto Slab

export const fontsReady = Promise.all([courier.waitUntilDone(), slab.waitUntilDone()]);
