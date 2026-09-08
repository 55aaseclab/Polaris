import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRootEnv } from "./load-env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PACKAGE_ROOT = path.resolve(__dirname, "..");
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");
export const SCHEMAS_DIR = path.join(REPO_ROOT, "schemas");
export const DATA_ROOT_ENV = "POLARIS_BUSINESS_DATA_ROOT";
export const RUNTIME_MODE_ENV = "POLARIS_BUSINESS_RUNTIME_MODE";
export const POLARIS_WORKSPACES_ROOT_ENV = "POLARIS_BUSINESS_VAULT_WORKSPACES_ROOT";
export const POLARIS_BACKUPS_ROOT_ENV = "POLARIS_BUSINESS_VAULT_BACKUPS_ROOT";
export const POLARIS_CACHE_ROOT_ENV = "POLARIS_BUSINESS_VAULT_CACHE_ROOT";
export const POLARIS_DATA_ROOT = "/vault";
export const POLARIS_WORKSPACES_ROOT = "/vault/workspaces";
export const POLARIS_BACKUPS_ROOT = "/vault/backups";
export const POLARIS_CACHE_ROOT = "/vault/cache";
export const WORKSPACES_ROOT_ENV = "POLARIS_BUSINESS_WORKSPACES_ROOT";
export const BACKUP_ROOT_ENV = "POLARIS_BUSINESS_BACKUP_ROOT";
export const CACHE_ROOT_ENV = "POLARIS_BUSINESS_CACHE_ROOT";

function resolveConfiguredDataRoot(): string {
  loadRootEnv();
  const mode = String(process.env[RUNTIME_MODE_ENV] ?? "standalone").trim();
  if (mode !== "polaris" && mode !== "standalone") {
    throw new Error(`${RUNTIME_MODE_ENV} must be polaris or standalone`);
  }
  if (mode === "polaris") {
    validatePolarisRoots();
    return POLARIS_DATA_ROOT;
  }
  const configured = String(process.env[DATA_ROOT_ENV] ?? "").trim();
  if (!configured) {
    throw new Error(
      `Missing required environment variable: ${DATA_ROOT_ENV} for local business tools`,
    );
  }
  return path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(REPO_ROOT, configured);
}

function validatePolarisRoot(environmentName: string, expected: string): string {
  const configured = String(process.env[environmentName] ?? "").trim();
  if (configured && (!path.isAbsolute(configured) || path.resolve(configured) !== expected)) {
    throw new Error(`Polaris mode must use the fixed ${expected} root`);
  }
  return expected;
}

function validatePolarisRoots(): void {
  validatePolarisRoot(POLARIS_WORKSPACES_ROOT_ENV, POLARIS_WORKSPACES_ROOT);
  validatePolarisRoot(POLARIS_BACKUPS_ROOT_ENV, POLARIS_BACKUPS_ROOT);
  validatePolarisRoot(POLARIS_CACHE_ROOT_ENV, POLARIS_CACHE_ROOT);
}

let cachedDataRoot: string | undefined;
let cachedWorkspacesDir: string | undefined;
let cachedBackupDir: string | undefined;
let cachedCacheDir: string | undefined;

/**
 * Resolve the business data root. In integrated mode this is the private
 * vault mount; local mode requires POLARIS_BUSINESS_DATA_ROOT.
 */
export function getDataRoot(): string {
  if (cachedDataRoot === undefined) {
    cachedDataRoot = resolveConfiguredDataRoot();
  }
  return cachedDataRoot;
}

/**
 * Workspace data is always below the configured Polaris business data root.
 */
export function getWorkspacesDir(): string {
  if (cachedWorkspacesDir === undefined) {
    cachedWorkspacesDir = process.env[RUNTIME_MODE_ENV]?.trim() === "polaris"
      ? validatePolarisRoot(POLARIS_WORKSPACES_ROOT_ENV, POLARIS_WORKSPACES_ROOT)
      : path.join(getDataRoot(), "workspaces");
  }
  return cachedWorkspacesDir;
}

/**
 * Cache data is always below the configured Polaris business data root.
 */
export function getCacheDir(): string {
  if (cachedCacheDir === undefined) {
    cachedCacheDir = process.env[RUNTIME_MODE_ENV]?.trim() === "polaris"
      ? validatePolarisRoot(POLARIS_CACHE_ROOT_ENV, POLARIS_CACHE_ROOT)
      : path.join(getDataRoot(), "cache");
  }
  return cachedCacheDir;
}

export function getBackupDir(): string {
  if (cachedBackupDir === undefined) {
    cachedBackupDir = process.env[RUNTIME_MODE_ENV]?.trim() === "polaris"
      ? validatePolarisRoot(POLARIS_BACKUPS_ROOT_ENV, POLARIS_BACKUPS_ROOT)
      : path.join(getDataRoot(), "backups");
  }
  return cachedBackupDir;
}

export function getNamedCacheDir(name: string): string {
  if (!name || name.includes("..") || path.isAbsolute(name)) {
    throw new Error(`Invalid cache directory name: ${name}`);
  }
  return path.join(getCacheDir(), name);
}

/** @deprecated Use getWorkspacesDir(). */
export const workspacesDir = getWorkspacesDir;

/**
 * @deprecated Use getWorkspacesDir(). This getter is only for legacy imports
 * that treat WORKSPACES_DIR as a string path.
 */
export function readWorkspacesDir(): string {
  return getWorkspacesDir();
}

/** @deprecated Use getCacheDir(). */
export const cacheDir = getCacheDir;

/**
 * @deprecated Use getCacheDir().
 */
export function readCacheDir(): string {
  return getCacheDir();
}

export function resetRepoRootCachesForTests(): void {
  cachedDataRoot = undefined;
  cachedWorkspacesDir = undefined;
  cachedBackupDir = undefined;
  cachedCacheDir = undefined;
}

// Legacy export name. Prefer getWorkspacesDir().
export { getWorkspacesDir as WORKSPACES_DIR };
