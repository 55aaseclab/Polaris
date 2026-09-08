import fs from "node:fs";

type CacheEntry<T> = {
  fingerprint: string;
  value: T;
};

const fileResponseCache = new Map<string, CacheEntry<unknown>>();

function fileFingerprint(filePaths: readonly string[]) {
  return filePaths.map((filePath) => {
    try {
      const stat = fs.statSync(filePath);
      return `${filePath}:${stat.size}:${stat.mtimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return `${filePath}:missing`;
      throw error;
    }
  }).join("|");
}

/**
 * Retains a computed JSON payload while its source files are unchanged.
 * The fingerprint is checked on every request, so external workspace tools
 * can still update files without needing to notify the portal process.
 */
export function readCachedFileResponse<T>(key: string, filePaths: readonly string[], load: () => T): T {
  const fingerprint = fileFingerprint(filePaths);
  const cached = fileResponseCache.get(key) as CacheEntry<T> | undefined;
  if (cached?.fingerprint === fingerprint) return cached.value;

  const value = load();
  fileResponseCache.set(key, { fingerprint, value });
  return value;
}

export function invalidateCachedFileResponse(key: string) {
  fileResponseCache.delete(key);
}
