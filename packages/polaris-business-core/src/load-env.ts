import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keep REPO_ROOT local to avoid a circular import with repo.ts.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");

let loadedPath: string | null | undefined;

/**
 * Load key=value pairs from the repository-root `.env` into `process.env`.
 *
 * Existing environment variables are never overwritten, so shell exports and
 * container/runtime injection still win. Safe to call multiple times.
 *
 * @returns Absolute path of the loaded file, or null when missing.
 */
export function loadRootEnv(root = DEFAULT_REPO_ROOT): string | null {
  if (loadedPath !== undefined && root === DEFAULT_REPO_ROOT) {
    return loadedPath;
  }

  const envPath = path.join(root, ".env.dev");
  if (!fs.existsSync(envPath) || !fs.statSync(envPath).isFile()) {
    if (root === DEFAULT_REPO_ROOT) loadedPath = null;
    return null;
  }

  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;

    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    if (!key || key.startsWith("#")) continue;
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;

    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2
      && (value.startsWith("\"") || value.startsWith("'"))
      && value[0] === value.at(-1)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }

  if (root === DEFAULT_REPO_ROOT) loadedPath = envPath;
  return envPath;
}

/** Test helper: clear the load-once cache. */
export function resetRootEnvCacheForTests(): void {
  loadedPath = undefined;
}
