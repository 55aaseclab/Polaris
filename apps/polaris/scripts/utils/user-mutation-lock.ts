import fs from "node:fs";
import path from "node:path";
import { polarisUsersRoot } from "./paths.js";

const DEFAULT_USER_MUTATION_LOCK_TTL_MS = 30_000;
const DEFAULT_USER_MUTATION_LOCK_TIMEOUT_BUFFER_MS = 5_000;

function userMutationLocksRoot(importMetaUrl: string): string {
  return path.join(
    polarisUsersRoot(importMetaUrl),
    ".locks",
    "user-mutations",
  );
}

function userMutationLockTtlMs(): number {
  const configured = Number(process.env.POLARIS_USER_MUTATION_LOCK_TTL_MS ?? "");
  if (Number.isFinite(configured) && configured >= 100) {
    return Math.floor(configured);
  }
  return DEFAULT_USER_MUTATION_LOCK_TTL_MS;
}

function userMutationLockTimeoutMs(): number {
  return userMutationLockTtlMs() + DEFAULT_USER_MUTATION_LOCK_TIMEOUT_BUFFER_MS;
}

function userMutationLockPath(importMetaUrl: string, userId: string): string {
  return path.join(
    userMutationLocksRoot(importMetaUrl),
    `${userId.trim()}.lock`,
  );
}

function userMutationHeartbeatPath(importMetaUrl: string, userId: string): string {
  return path.join(userMutationLockPath(importMetaUrl, userId), "heartbeat");
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function touchHeartbeat(importMetaUrl: string, userId: string): Promise<void> {
  const heartbeatPath = userMutationHeartbeatPath(importMetaUrl, userId);
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

function startHeartbeat(importMetaUrl: string, userId: string): NodeJS.Timeout {
  const intervalMs = Math.max(
    100,
    Math.min(1_000, Math.floor(userMutationLockTtlMs() / 4)),
  );
  const timer = setInterval(() => {
    void touchHeartbeat(importMetaUrl, userId).catch(() => {
      // Ignore release races while the lock is being removed.
    });
  }, intervalMs);
  timer.unref();
  return timer;
}

async function tryClearStaleLock(
  importMetaUrl: string,
  userId: string,
): Promise<boolean> {
  const heartbeatPath = userMutationHeartbeatPath(importMetaUrl, userId);
  const lockPath = userMutationLockPath(importMetaUrl, userId);
  try {
    const stats = await fs.promises.stat(heartbeatPath)
      .catch(async (error) => {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          return fs.promises.stat(lockPath);
        }
        throw error;
      });
    if (Date.now() - stats.mtimeMs < userMutationLockTtlMs()) {
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

export async function withUserMutationLock<T>(
  importMetaUrl: string,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error("userId is required for the Polaris user mutation lock");
  }
  const lockPath = userMutationLockPath(importMetaUrl, normalizedUserId);
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  const timeoutMs = userMutationLockTimeoutMs();
  for (;;) {
    try {
      await fs.promises.mkdir(lockPath);
      await touchHeartbeat(importMetaUrl, normalizedUserId);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw error;
      }
      await tryClearStaleLock(importMetaUrl, normalizedUserId);
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          `Timed out waiting for the Polaris user mutation lock for '${normalizedUserId}'`,
        );
      }
      await sleepMs(25);
    }
  }

  const heartbeat = startHeartbeat(importMetaUrl, normalizedUserId);
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await fs.promises.rm(lockPath, { recursive: true, force: true });
  }
}
