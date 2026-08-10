import fs from "node:fs";
import path from "node:path";
import { isShellPath } from "@polaris/polaris-shell";
import { repoRoot } from "../utils/paths.js";

const PORTAL_ROOT = path.join(repoRoot(import.meta.url), "apps", "polaris-portal", "dist");

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

export function portalAssetRoot(): string {
  return PORTAL_ROOT;
}

export function hasPortalAssets(): boolean {
  return fs.existsSync(path.join(PORTAL_ROOT, "index.html"));
}

export function readPortalAsset(name: string): {
  body: Buffer;
  contentType: string;
} | null {
  const normalized = name.replace(/^\/+/, "");
  if (!/^(?:index\.html|shell\.(?:js|css))$/u.test(normalized)) {
    return null;
  }
  const filePath = path.join(PORTAL_ROOT, normalized);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }
  return {
    body: fs.readFileSync(filePath),
    contentType: CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream",
  };
}

export function isPortalDocumentPath(pathname: string): boolean {
  if (isShellPath(pathname)) {
    return true;
  }
  return /^\/v\/[^/]+\/wanghai\/?$/u.test(pathname);
}

export function portalFallbackHtml(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Polaris Portal</title></head><body><main id="app"><p>Polaris Portal assets are not built.</p></main></body></html>`;
}
