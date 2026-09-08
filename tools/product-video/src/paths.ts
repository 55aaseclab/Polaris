import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VideoError } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const TOOL_ROOT = path.resolve(__dirname, "..");
export const TOOL_SCHEMAS_DIR = path.join(TOOL_ROOT, "schemas");

export function toolVersion(): string {
  return fs.readFileSync(path.join(TOOL_ROOT, "VERSION"), "utf-8").trim();
}

export function videoCaseDir(workspaceRoot: string, videoId: string): string {
  return path.join(workspaceRoot, "产品管理", "交付归档", "videos", videoId);
}

export function assertSafeWorkspaceRelative(relativePath: string, label: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) {
    throw new VideoError(`${label}: empty or invalid path`, 2);
  }
  if (normalized.split("/").some((part) => part === ".." || part === ".")) {
    throw new VideoError(`${label}: path must not contain '.' or '..' segments: ${relativePath}`, 2);
  }
  if (path.isAbsolute(relativePath)) {
    throw new VideoError(`${label}: absolute paths are not allowed: ${relativePath}`, 2);
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
    throw new VideoError(`${label}: path escapes workspace: ${relativePath}`, 2);
  }
  return absolute;
}

export function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath).split(path.sep).join("/");
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new VideoError(`path is outside workspace: ${absolutePath}`, 1);
  }
  return relative;
}

/** Like toWorkspaceRelative, but returns null when the path is outside the workspace. */
export function tryWorkspaceRelative(workspaceRoot: string, absolutePath: string): string | null {
  const relative = path.relative(workspaceRoot, absolutePath).split(path.sep).join("/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative;
}

export function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function findFfmpeg(): string {
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(process.env.HOME ?? "", ".local/bin/ffmpeg"),
    "ffmpeg",
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (candidate === "ffmpeg") return "ffmpeg";
    if (fs.existsSync(candidate)) return candidate;
  }
  return "ffmpeg";
}

export function findFfprobe(): string {
  const candidates = [
    process.env.FFPROBE_PATH,
    path.join(process.env.HOME ?? "", ".local/bin/ffprobe"),
    "ffprobe",
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (candidate === "ffprobe") return "ffprobe";
    if (fs.existsSync(candidate)) return candidate;
  }
  return "ffprobe";
}
