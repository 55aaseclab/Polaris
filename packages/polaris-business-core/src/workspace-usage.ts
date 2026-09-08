import fs from "node:fs";
import path from "node:path";
import { getWorkspacesDir } from "./repo.js";

export const DEFAULT_MAX_WORKSPACE_USAGE_ENTRIES = 100_000;

export type WorkspaceUsage = {
  usageBytes: number;
  fileCount: number;
  entryCount: number;
};

export class WorkspaceUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceUsageError";
  }
}

/**
 * Measures logical workspace bytes without following symlinks outside the
 * mounted vault. Polaris owns quota decisions; this is only a bounded source
 * measurement for its reconciliation ledger.
 */
export function measureWorkspaceUsage(input: {
  rootDir?: string;
  maxEntries?: number;
} = {}): WorkspaceUsage {
  const rootDir = path.resolve(input.rootDir ?? getWorkspacesDir());
  const maxEntries = normalizeMaxEntries(input.maxEntries);
  const rootStat = readRoot(rootDir);
  if (!rootStat) {
    return { usageBytes: 0, fileCount: 0, entryCount: 0 };
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new WorkspaceUsageError("Workspace usage root is invalid");
  }

  let usageBytes = 0;
  let fileCount = 0;
  let entryCount = 0;
  const directories = [rootDir];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw workspaceUsageError(error);
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(entryPath);
      } catch (error) {
        if (isNotFoundError(error)) continue;
        throw workspaceUsageError(error);
      }
      entryCount += 1;
      if (entryCount > maxEntries) {
        throw new WorkspaceUsageError("Workspace usage exceeds the entry limit");
      }
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        directories.push(entryPath);
        continue;
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
        throw new WorkspaceUsageError("Workspace usage contains an invalid entry size");
      }
      usageBytes += stat.size;
      if (!Number.isSafeInteger(usageBytes)) {
        throw new WorkspaceUsageError("Workspace usage exceeds the supported range");
      }
      if (stat.isFile()) fileCount += 1;
    }
  }
  return { usageBytes, fileCount, entryCount };
}

function normalizeMaxEntries(value: number | undefined): number {
  const maxEntries = value ?? DEFAULT_MAX_WORKSPACE_USAGE_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > 1_000_000) {
    throw new WorkspaceUsageError("Workspace usage entry limit is invalid");
  }
  return maxEntries;
}

function readRoot(rootDir: string): fs.Stats | null {
  try {
    return fs.lstatSync(rootDir);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw workspaceUsageError(error);
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function workspaceUsageError(error: unknown): WorkspaceUsageError {
  if (error instanceof WorkspaceUsageError) return error;
  return new WorkspaceUsageError("Workspace usage cannot be measured");
}
