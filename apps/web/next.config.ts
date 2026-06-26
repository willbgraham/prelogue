import type { NextConfig } from "next";

// Self-contained app: all code lives under apps/web (shared utils vendored into
// lib/shared), so no monorepo transpile / workspace-root config is needed. This
// keeps the project root aligned with Vercel's Root Directory (apps/web).
const nextConfig: NextConfig = {};

export default nextConfig;
