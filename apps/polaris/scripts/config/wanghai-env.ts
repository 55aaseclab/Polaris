import path from "node:path";
import {
  WANGHAI_BACKUP_RUNTIME_ROOT,
  WANGHAI_CACHE_RUNTIME_ROOT,
  WANGHAI_VAULTS_RUNTIME_ROOT,
} from "./scaffold.js";
import { polarisWanghaiDataRoot } from "../utils/paths.js";

export interface WanghaiHostDataRoots {
  backupRoot: string;
  cacheRoot: string;
  vaultsRoot: string;
}

export function resolveConfiguredWanghaiDataRoot(importMetaUrl: string): string {
  return path.resolve(polarisWanghaiDataRoot(importMetaUrl));
}

export function resolveWanghaiHostDataRoots(importMetaUrl: string): WanghaiHostDataRoots {
  const root = resolveConfiguredWanghaiDataRoot(importMetaUrl);
  return {
    vaultsRoot: path.join(root, path.basename(WANGHAI_VAULTS_RUNTIME_ROOT)),
    backupRoot: path.join(root, path.basename(WANGHAI_BACKUP_RUNTIME_ROOT)),
    cacheRoot: path.join(root, path.basename(WANGHAI_CACHE_RUNTIME_ROOT)),
  };
}
