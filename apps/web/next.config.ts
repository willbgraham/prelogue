import type { NextConfig } from "next";
import path from "node:path";

// Monorepo root (one level above apps/). Turbopack needs this to resolve the
// symlinked packages/shared; outputFileTracingRoot needs it so Vercel traces +
// bundles the right files for the serverless functions (without it the build is
// "Ready" but routes 404).
const root = path.resolve(process.cwd(), "..", "..");

const nextConfig: NextConfig = {
  transpilePackages: ["@prelogue/shared"],
  outputFileTracingRoot: root,
  turbopack: { root },
};

export default nextConfig;
