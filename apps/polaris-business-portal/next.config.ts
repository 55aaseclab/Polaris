import type { NextConfig } from "next";
import { loadRootEnv } from "@polaris/business-core/load-env";
import { normalizeAllowedDevOrigins } from "./lib/dev-origins";

// One shared env file at the monorepo root for portal + CLI + tools.
loadRootEnv();

const distDir = process.env.ADMIN_PORTAL_DIST_DIR?.trim();
const allowedDevOrigins = normalizeAllowedDevOrigins(
  process.env.WANGHAI_LOCAL_DEV_ALLOWED_ORIGIN,
);

const nextConfig: NextConfig = {
  ...(distDir ? { distDir } : {}),
  ...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),
  basePath: "/wanghai",
  transpilePackages: ["@polaris/business-core", "polaris-workflow"],
  webpack(config) {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
