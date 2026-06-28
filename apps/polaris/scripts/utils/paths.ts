import path from "node:path";
import { resolveRepoRoot } from "./repo-root.js";

export function repoRoot(importMetaUrl: string): string {
  return resolveRepoRoot(importMetaUrl);
}

export function polarisDataRoot(importMetaUrl: string): string {
  const root = repoRoot(importMetaUrl);
  const configured = process.env.POLARIS_DATA_ROOT?.trim();
  if (!configured) {
    return path.join(root, "config");
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
