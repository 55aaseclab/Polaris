import fs from "node:fs";
import path from "node:path";
import { polarisControlRoot } from "./paths.js";

const DEFAULT_CONTROL_MUTATION_LOCK_TTL_MS = 30_000;
const DEFAULT_CONTROL_MUTATION_LOCK_TIMEOUT_BUFFER_MS = 5_000;

function lockTtlMs(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(
    environment.POLARIS_CONTROL_MUTATION_LOCK_TTL_MS ?? "",
  );
  if (Number.isFinite(configured) && configured >= 100) {
    return Math.floor(configured);
  }
  return DEFAULT_CONTROL_MUTATION_LOCK_TTL_MS;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeScope(scope: string): string {
  const normalized = scope.trim();
  if (!normalized || !/^[a-z0-9][a-z0-9_.-]*$/u.test(normalized)) {
    throw new Error(`Invalid Polaris control mutation lock scope '${scope}'`);
  }
  return normalized;
}

async function refreshLock(lockPath: string): Promise<void> {
  const now = new Date();
  await fs.promises.utimes(lockPath, now, now);
}

async function clearStaleLock(
  lockPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(lockPath);
    if (Date.now() - stats.mtimeMs < lockTtlMs(environment)) {
      return false;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  await fs.promises.rm(lockPath, { recursive: true, force: true });
  return true;
}

export async function withControlMutationLock<T>(
  importMetaUrl: string,
  scope: string,
  fn: () => Promise<T>,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const normalizedScope = normalizeScope(scope);
  const lockPath = path.join(
    polarisControlRoot(importMetaUrl, environment),
    ".locks",
    `${normalizedScope}.lock`,
  );
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  await fs.promises.chmod(path.dirname(lockPath), 0o700);

  const startedAt = Date.now();
  const timeoutMs = lockTtlMs(environment) + DEFAULT_CONTROL_MUTATION_LOCK_TIMEOUT_BUFFER_MS;
  for (;;) {
    try {
      await fs.promises.mkdir(lockPath, { mode: 0o700 });
      await refreshLock(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw error;
      }
      await clearStaleLock(lockPath, environment);
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          `Timed out waiting for the Polaris control mutation lock '${normalizedScope}'`,
        );
      }
      await sleepMs(25);
    }
  }

  const heartbeat = setInterval(() => {
    void refreshLock(lockPath).catch(() => {
      // Ignore release races while the lock is being removed.
    });
  }, Math.max(100, Math.min(1_000, Math.floor(lockTtlMs(environment) / 4))));
  heartbeat.unref();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await fs.promises.rm(lockPath, { recursive: true, force: true });
  }
}
