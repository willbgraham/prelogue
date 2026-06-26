import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Transpile the shared monorepo package (TS source, no build step).
  transpilePackages: ["@prelogue/shared"],
  // Pin Turbopack's root to THIS app dir (the build cwd). It must NOT be set
  // above Vercel's Root Directory (apps/web) — a higher root makes the build
  // root itself a level up from where Vercel serves, producing a 404 on every
  // route despite a "Ready" build.
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
