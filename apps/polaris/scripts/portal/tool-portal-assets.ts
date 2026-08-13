import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../utils/paths.js";

const TOOL_PORTAL_ROOT = path.join(
  repoRoot(import.meta.url),
  "apps",
  "polaris-tool-portal",
  "dist",
);

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export function toolPortalAssetRoot(): string {
  return TOOL_PORTAL_ROOT;
}

export function hasToolPortalAssets(): boolean {
  return fs.existsSync(path.join(TOOL_PORTAL_ROOT, "index.html"));
}

export function readToolPortalAsset(name: string): {
  body: Buffer;
  contentType: string;
} | null {
  const normalized = name.replace(/^\/+/, "");
  if (!isAllowedToolPortalAssetName(normalized)) {
    return null;
  }
  const filePath = path.join(TOOL_PORTAL_ROOT, normalized);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }
  return {
    body: fs.readFileSync(filePath),
    contentType: CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream",
  };
}

export function isToolPortalDocumentPath(pathname: string): boolean {
  if (pathname === "/tools" || pathname === "/tools/") {
    return true;
  }
  if (!pathname.startsWith("/tools/")) {
    return false;
  }
  if (pathname.startsWith("/tools/assets/")) {
    return false;
  }
  return !path.basename(pathname).includes(".");
}

export function toolPortalFallbackHtml(): string {
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Polaris Tool Portal</title></head><body><main id=\"root\"><p>Polaris Tool Portal assets are not built.</p></main></body></html>";
}

function isAllowedToolPortalAssetName(name: string): boolean {
  return /^(?:index\.html|tools\.(?:js|css)|assets\/[A-Za-z0-9._-]+\.(?:png|svg|webp))$/u
    .test(name);
}
