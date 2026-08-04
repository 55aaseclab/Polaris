import path from "node:path";
import {
  WANGHAI_BACKUP_RUNTIME_ROOT,
  WANGHAI_CACHE_RUNTIME_ROOT,
  WANGHAI_WORKSPACES_RUNTIME_ROOT,
  vaultDataRelativePath,
} from "./scaffold.js";
import { polarisNetfsLocalExportRoot } from "../utils/paths.js";

export interface WanghaiHostDataRoots {
  backupRoot: string;
  cacheRoot: string;
  workspacesRoot: string;
}

export function resolveConfiguredWanghaiVaultDataRoot(importMetaUrl: string): string {
  return path.resolve(polarisNetfsLocalExportRoot(importMetaUrl));
}

export function resolveWanghaiHostDataRoots(
  importMetaUrl: string,
  scope: { tenantId: string; vaultId: string },
): WanghaiHostDataRoots {
  return resolveWanghaiHostDataRootsAtRoot(
    resolveConfiguredWanghaiVaultDataRoot(importMetaUrl),
    scope,
  );
}

/**
 * Resolve the tenant-qualified data layout below the Polaris vault export.
 *
 * Migration tooling uses this helper so copied data always lands at the exact
 * path mounted by Polaris provisioning.
 */
export function resolveWanghaiHostDataRootsAtRoot(
  vaultExportRoot: string,
  scope: { tenantId: string; vaultId: string },
): WanghaiHostDataRoots {
  const qualifiedRoot = path.join(
    path.resolve(vaultExportRoot),
    vaultDataRelativePath(scope.tenantId, scope.vaultId),
  );
  return {
    workspacesRoot: path.join(qualifiedRoot, path.basename(WANGHAI_WORKSPACES_RUNTIME_ROOT)),
    backupRoot: path.join(qualifiedRoot, path.basename(WANGHAI_BACKUP_RUNTIME_ROOT)),
    cacheRoot: path.join(qualifiedRoot, path.basename(WANGHAI_CACHE_RUNTIME_ROOT)),
  };
}
