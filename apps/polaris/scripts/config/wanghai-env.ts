import path from "node:path";
import { createHash } from "node:crypto";
import {
  WANGHAI_BACKUP_RUNTIME_ROOT,
  WANGHAI_CACHE_RUNTIME_ROOT,
  WANGHAI_WORKSPACES_RUNTIME_ROOT,
} from "./scaffold.js";
import { polarisWanghaiDataRoot } from "../utils/paths.js";

export interface WanghaiHostDataRoots {
  backupRoot: string;
  cacheRoot: string;
  workspacesRoot: string;
}

export function resolveConfiguredWanghaiDataRoot(importMetaUrl: string): string {
  return path.resolve(polarisWanghaiDataRoot(importMetaUrl));
}

export function resolveWanghaiHostDataRoots(
  importMetaUrl: string,
  scope: { tenantId: string; vaultId: string },
): WanghaiHostDataRoots {
  return resolveWanghaiHostDataRootsAtRoot(
    resolveConfiguredWanghaiDataRoot(importMetaUrl),
    scope,
  );
}

/**
 * Resolve the tenant-qualified data layout below an explicit host root.
 *
 * Migration tooling uses this helper so copied data always lands at the exact
 * path injected by Polaris provisioning.
 */
export function resolveWanghaiHostDataRootsAtRoot(
  dataRoot: string,
  scope: { tenantId: string; vaultId: string },
): WanghaiHostDataRoots {
  const root = path.resolve(dataRoot);
  const qualifiedRoot = path.join(
    root,
    "tenants",
    qualifiedDataToken(scope.tenantId),
    "vaults",
    qualifiedDataToken(scope.vaultId),
  );
  return {
    workspacesRoot: path.join(qualifiedRoot, path.basename(WANGHAI_WORKSPACES_RUNTIME_ROOT)),
    backupRoot: path.join(qualifiedRoot, path.basename(WANGHAI_BACKUP_RUNTIME_ROOT)),
    cacheRoot: path.join(qualifiedRoot, path.basename(WANGHAI_CACHE_RUNTIME_ROOT)),
  };
}

function qualifiedDataToken(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Wanghai data scope identifiers are required");
  }
  const readable = normalized
    .replace(/[^a-zA-Z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
  return `${readable || "scope"}-${digest}`;
}
