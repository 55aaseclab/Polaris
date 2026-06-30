import path from "node:path";
import { resolveRepoRoot } from "./repo-root.js";

export function repoRoot(importMetaUrl: string): string {
  return resolveRepoRoot(importMetaUrl);
}

export function polarisDataRoot(importMetaUrl: string): string {
  const root = repoRoot(importMetaUrl);
  const configured = process.env.POLARIS_DATA_ROOT?.trim();
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
