import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CatalogError } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const TOOL_ROOT = path.resolve(__dirname, "..");
export const TEMPLATES_DIR = path.join(TOOL_ROOT, "templates");
export const TOOL_SCHEMAS_DIR = path.join(TOOL_ROOT, "schemas");

export function toolVersion(): string {
  return fs.readFileSync(path.join(TOOL_ROOT, "VERSION"), "utf-8").trim();
}

/** Legacy/compat path used by product-gallery workflows. */
export function catalogCaseDir(workspaceRoot: string, catalogId: string): string {
  const assetsRoot = fs.existsSync(path.join(workspaceRoot, "assets"))
    ? path.join(workspaceRoot, "assets")
    : workspaceRoot;
  return path.join(
    assetsRoot,
    "产品管理",
    "交付归档",
    "catalogs",
    catalogId,
  );
}

/** Preferred case root for content-production jobs. */
export function contentCaseDir(workspaceRoot: string, jobId: string): string {
  const assetsRoot = fs.existsSync(path.join(workspaceRoot, "assets"))
    ? path.join(workspaceRoot, "assets")
    : workspaceRoot;
  return path.join(
    assetsRoot,
    "产品管理",
    "交付归档",
    "content-production",
    jobId,
  );
}

/**
 * product-catalog kind still lands under catalogs/ so existing gallery
 * workflows keep working; other kinds use content-production/.
 */
export function jobCaseDir(
  workspaceRoot: string,
  jobId: string,
  contentKind: "product-catalog" | "carousel" | "video",
): string {
  if (contentKind === "product-catalog") {
    return catalogCaseDir(workspaceRoot, jobId);
  }
  return contentCaseDir(workspaceRoot, jobId);
}

export function assertSafeWorkspaceRelative(relativePath: string, label: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) {
    throw new CatalogError(`${label}: empty or invalid path`, 2);
  }
  if (normalized.split("/").some((part) => part === ".." || part === ".")) {
    throw new CatalogError(`${label}: path must not contain '.' or '..' segments: ${relativePath}`, 2);
  }
  if (path.isAbsolute(relativePath)) {
    throw new CatalogError(`${label}: absolute paths are not allowed: ${relativePath}`, 2);
  }
  return normalized;
}

export function resolveUnderWorkspace(
  workspaceRoot: string,
  relativePath: string,
  label: string,
): string {
  const safe = assertSafeWorkspaceRelative(relativePath, label);
  const absolute = path.resolve(workspaceRoot, safe);
  const root = path.resolve(workspaceRoot) + path.sep;
  if (absolute !== path.resolve(workspaceRoot) && !absolute.startsWith(root)) {
    throw new CatalogError(`${label}: path escapes workspace: ${relativePath}`, 2);
  }
  return absolute;
}

export function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath).split(path.sep).join("/");
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new CatalogError(`path is outside workspace: ${absolutePath}`, 1);
  }
  return relative;
}

export function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}
