import fs from "node:fs";
import path from "node:path";
import { polarisUsersRoot } from "./paths.js";
import { withUserMutationLock } from "./user-mutation-lock.js";

const DEFAULT_VAULT_LIFECYCLE_LOCK_TTL_MS = 30_000;
const DEFAULT_VAULT_LIFECYCLE_LOCK_TIMEOUT_BUFFER_MS = 5_000;

function vaultLifecycleLocksRoot(importMetaUrl: string): string {
  return path.join(
    polarisUsersRoot(importMetaUrl),
    ".locks",
    "vault-lifecycle",
  );
}

function vaultLifecycleLockTtlMs(): number {
  const configured = Number(
    process.env.POLARIS_VAULT_LIFECYCLE_LOCK_TTL_MS ?? "",
  );
  if (Number.isFinite(configured) && configured >= 100) {
    return Math.floor(configured);
  }
  return DEFAULT_VAULT_LIFECYCLE_LOCK_TTL_MS;
}

function vaultLifecycleLockTimeoutMs(): number {
  return (
    vaultLifecycleLockTtlMs() +
    DEFAULT_VAULT_LIFECYCLE_LOCK_TIMEOUT_BUFFER_MS
  );
}

function normalizeVaultLockSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("vault is required for the Polaris vault lifecycle lock");
  }
  return trimmed.replace(/[^a-zA-Z0-9_.-]+/g, "-");
}

function vaultLifecycleLockName(userId: string, vault: string): string {
  return `${userId.trim()}--${normalizeVaultLockSegment(vault)}`;
}

function vaultLifecycleLockPath(
  importMetaUrl: string,
  userId: string,
  vault: string,
): string {
  return path.join(
    vaultLifecycleLocksRoot(importMetaUrl),
    `${vaultLifecycleLockName(userId, vault)}.lock`,
  );
}

function vaultLifecycleHeartbeatPath(
  importMetaUrl: string,
  userId: string,
  vault: string,
): string {
  return path.join(
    vaultLifecycleLockPath(importMetaUrl, userId, vault),
    "heartbeat",
  );
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function touchHeartbeat(
  importMetaUrl: string,
  userId: string,
  vault: string,
): Promise<void> {
  const heartbeatPath = vaultLifecycleHeartbeatPath(
    importMetaUrl,
    userId,
    vault,
  );
  const now = new Date();
  try {
    await fs.promises.utimes(heartbeatPath, now, now);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      await fs.promises.writeFile(heartbeatPath, "", "utf8");
      return;
    }
    throw error;
  }
}

function startHeartbeat(
  importMetaUrl: string,
  userId: string,
  vault: string,
): NodeJS.Timeout {
  const intervalMs = Math.max(
    100,
    Math.min(1_000, Math.floor(vaultLifecycleLockTtlMs() / 4)),
  );
  const timer = setInterval(() => {
    void touchHeartbeat(importMetaUrl, userId, vault).catch(() => {
      // Ignore release races while the lock is being removed.
    });
  }, intervalMs);
  timer.unref();
  return timer;
}

async function tryClearStaleLock(
  importMetaUrl: string,
  userId: string,
  vault: string,
): Promise<boolean> {
  const heartbeatPath = vaultLifecycleHeartbeatPath(
    importMetaUrl,
    userId,
    vault,
  );
  const lockPath = vaultLifecycleLockPath(importMetaUrl, userId, vault);
  try {
    const stats = await fs.promises.stat(heartbeatPath).catch(async (error) => {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return fs.promises.stat(lockPath);
      }
      throw error;
    });
    if (Date.now() - stats.mtimeMs < vaultLifecycleLockTtlMs()) {
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

export async function withVaultLifecycleLock<T>(
  importMetaUrl: string,
  userId: string,
  vault: string,
  fn: () => Promise<T>,
): Promise<T> {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error("userId is required for the Polaris vault lifecycle lock");
  }
  const normalizedVault = normalizeVaultLockSegment(vault);
  const lockPath = vaultLifecycleLockPath(
    importMetaUrl,
    normalizedUserId,
    normalizedVault,
  );
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  const timeoutMs = vaultLifecycleLockTimeoutMs();
  for (;;) {
    try {
      await fs.promises.mkdir(lockPath);
      await touchHeartbeat(
        importMetaUrl,
        normalizedUserId,
        normalizedVault,
      );
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw error;
      }
      await tryClearStaleLock(
        importMetaUrl,
        normalizedUserId,
        normalizedVault,
      );
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          `Timed out waiting for the Polaris vault lifecycle lock for '${normalizedUserId}:${normalizedVault}'`,
        );
      }
      await sleepMs(25);
    }
  }

  const heartbeat = startHeartbeat(
    importMetaUrl,
    normalizedUserId,
    normalizedVault,
  );
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await fs.promises.rm(lockPath, { recursive: true, force: true });
  }
}

export async function withVaultMutationLock<T>(
  importMetaUrl: string,
  userId: string,
  vault: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withUserMutationLock(importMetaUrl, userId, async () =>
    withVaultLifecycleLock(importMetaUrl, userId, vault, fn)
  );
}
