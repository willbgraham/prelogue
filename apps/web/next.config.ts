import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Transpile the shared monorepo package (TS source, no build step).
  transpilePackages: ["@prelogue/shared"],
  // Pin the workspace root to the monorepo root (one above apps/) so Turbopack
  // resolves the symlinked packages/shared and doesn't infer a stray lockfile.
  turbopack: {
    root: path.resolve(process.cwd(), "..", ".."),
  },
};

export default nextConfig;
