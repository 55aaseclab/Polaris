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

export function polarisDataRoot(
  importMetaUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const root = repoRoot(importMetaUrl);
  const configured = environment.POLARIS_DATA_ROOT?.trim()
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

export function polarisCacheRoot(
  importMetaUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(polarisDataRoot(importMetaUrl, environment), "cache");
}

export function polarisControlRoot(
  importMetaUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(polarisDataRoot(importMetaUrl, environment), "control");
}

export function polarisUsersRoot(importMetaUrl: string): string {
  return path.join(polarisControlRoot(importMetaUrl), "users");
}

export function polarisStateRoot(importMetaUrl: string): string {
  return path.join(polarisControlRoot(importMetaUrl), "state");
}

export function polarisDomainPacksRoot(
  importMetaUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(polarisControlRoot(importMetaUrl, environment), "domain-packs");
}

function resolveOptionalConfiguredPath(importMetaUrl: string, envKey: string): string | null {
  const root = repoRoot(importMetaUrl);
  const configured = process.env[envKey]?.trim()
    || (readEnvFileValue(path.join(root, ".env.dev"), envKey) ?? "");
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(root, configured);
  }
  return null;
}

export function polarisNetfsLocalExportRoot(importMetaUrl: string): string {
  const configured = resolveOptionalConfiguredPath(importMetaUrl, "POLARIS_NETFS_LOCAL_EXPORT_ROOT");
  if (configured) {
    return configured;
  }
  return path.join(polarisDataRoot(importMetaUrl), "vault-data");
}

export function polarisVaultDataRoot(importMetaUrl: string): string {
  return polarisNetfsLocalExportRoot(importMetaUrl);
}

export function polarisBackupKeyRoot(
  importMetaUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(polarisControlRoot(importMetaUrl, environment), "backup-keys");
}

export function polarisConfigDockerRoot(importMetaUrl: string): string {
  return path.join(repoRoot(importMetaUrl), "config", "docker");
}
