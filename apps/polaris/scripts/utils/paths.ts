import fs from "node:fs";
import path from "node:path";
import { resolveRepoRoot } from "./repo-root.js";

function readEnvFileValue(filePath: string, key: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/u);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const currentKey = trimmed.slice(0, separatorIndex).trim();
    if (currentKey !== key) {
      continue;
    }
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    return rawValue.replace(/^['"]|['"]$/gu, "").trim() || null;
  }
  return null;
}

export function repoRoot(importMetaUrl: string): string {
  return resolveRepoRoot(importMetaUrl);
}

export function repoRelativePath(importMetaUrl: string, filePath: string): string {
  return path.relative(repoRoot(importMetaUrl), filePath) || ".";
}

export function polarisDataRoot(importMetaUrl: string): string {
  const root = repoRoot(importMetaUrl);
  const configured = process.env.POLARIS_DATA_ROOT?.trim()
    || (readEnvFileValue(path.join(root, ".env.dev"), "POLARIS_DATA_ROOT") ?? "");
  if (!configured) {
    throw new Error(
      `POLARIS_DATA_ROOT is required for Polaris runtime paths (repo root: ${root})`,
    );
  }
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(root, configured);
}

export function polarisUsersRoot(importMetaUrl: string): string {
  return path.join(polarisDataRoot(importMetaUrl), "users");
}

export function polarisStateRoot(importMetaUrl: string): string {
  return path.join(polarisDataRoot(importMetaUrl), "state");
}

export function polarisNetfsLocalExportRoot(importMetaUrl: string): string {
  const root = repoRoot(importMetaUrl);
  const configured = process.env.POLARIS_NETFS_LOCAL_EXPORT_ROOT?.trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(root, configured);
  }
  return path.join(polarisDataRoot(importMetaUrl), "exports", "workspaces");
}

export function polarisConfigDockerRoot(importMetaUrl: string): string {
  return path.join(repoRoot(importMetaUrl), "config", "docker");
}
