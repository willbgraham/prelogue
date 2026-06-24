import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Transpile the shared monorepo package (TS source, no build step).
  transpilePackages: ["@prelogue/shared"],
  // Self-contained app inside a larger repo — pin the workspace root so Next
  // doesn't infer a stray parent lockfile.
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
