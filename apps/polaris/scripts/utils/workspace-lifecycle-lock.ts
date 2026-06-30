import fs from "node:fs";
import path from "node:path";
import { polarisUsersRoot } from "./paths.js";
import { withUserMutationLock } from "./user-mutation-lock.js";

const DEFAULT_WORKSPACE_LIFECYCLE_LOCK_TTL_MS = 30_000;
const DEFAULT_WORKSPACE_LIFECYCLE_LOCK_TIMEOUT_BUFFER_MS = 5_000;

function workspaceLifecycleLocksRoot(importMetaUrl: string): string {
  return path.join(
    polarisUsersRoot(importMetaUrl),
    ".locks",
    "workspace-lifecycle",
  );
}

function workspaceLifecycleLockTtlMs(): number {
  const configured = Number(
    process.env.POLARIS_WORKSPACE_LIFECYCLE_LOCK_TTL_MS ?? "",
  );
  if (Number.isFinite(configured) && configured >= 100) {
    return Math.floor(configured);
  }
  return DEFAULT_WORKSPACE_LIFECYCLE_LOCK_TTL_MS;
}

function workspaceLifecycleLockTimeoutMs(): number {
  return (
    workspaceLifecycleLockTtlMs() +
    DEFAULT_WORKSPACE_LIFECYCLE_LOCK_TIMEOUT_BUFFER_MS
  );
}

function normalizeWorkspaceLockSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("workspace is required for the Polaris workspace lifecycle lock");
  }
  return trimmed.replace(/[^a-zA-Z0-9_.-]+/g, "-");
}

function workspaceLifecycleLockName(userId: string, workspace: string): string {
  return `${userId.trim()}--${normalizeWorkspaceLockSegment(workspace)}`;
}

function workspaceLifecycleLockPath(
  importMetaUrl: string,
  userId: string,
  workspace: string,
): string {
  return path.join(
    workspaceLifecycleLocksRoot(importMetaUrl),
    `${workspaceLifecycleLockName(userId, workspace)}.lock`,
  );
}

function workspaceLifecycleHeartbeatPath(
  importMetaUrl: string,
  userId: string,
  workspace: string,
): string {
  return path.join(
    workspaceLifecycleLockPath(importMetaUrl, userId, workspace),
    "heartbeat",
  );
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function touchHeartbeat(
  importMetaUrl: string,
  userId: string,
  workspace: string,
): Promise<void> {
  const heartbeatPath = workspaceLifecycleHeartbeatPath(
    importMetaUrl,
    userId,
    workspace,
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
  workspace: string,
): NodeJS.Timeout {
  const intervalMs = Math.max(
    100,
    Math.min(1_000, Math.floor(workspaceLifecycleLockTtlMs() / 4)),
  );
  const timer = setInterval(() => {
    void touchHeartbeat(importMetaUrl, userId, workspace).catch(() => {
      // Ignore release races while the lock is being removed.
    });
  }, intervalMs);
  timer.unref();
  return timer;
}

async function tryClearStaleLock(
  importMetaUrl: string,
  userId: string,
  workspace: string,
): Promise<boolean> {
  const heartbeatPath = workspaceLifecycleHeartbeatPath(
    importMetaUrl,
    userId,
    workspace,
  );
  const lockPath = workspaceLifecycleLockPath(importMetaUrl, userId, workspace);
  try {
    const stats = await fs.promises.stat(heartbeatPath).catch(async (error) => {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return fs.promises.stat(lockPath);
      }
      throw error;
    });
    if (Date.now() - stats.mtimeMs < workspaceLifecycleLockTtlMs()) {
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

export async function withWorkspaceLifecycleLock<T>(
  importMetaUrl: string,
  userId: string,
  workspace: string,
  fn: () => Promise<T>,
): Promise<T> {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error("userId is required for the Polaris workspace lifecycle lock");
  }
  const normalizedWorkspace = normalizeWorkspaceLockSegment(workspace);
  const lockPath = workspaceLifecycleLockPath(
    importMetaUrl,
    normalizedUserId,
    normalizedWorkspace,
  );
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  const timeoutMs = workspaceLifecycleLockTimeoutMs();
  for (;;) {
    try {
      await fs.promises.mkdir(lockPath);
      await touchHeartbeat(
        importMetaUrl,
        normalizedUserId,
        normalizedWorkspace,
      );
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw error;
      }
      await tryClearStaleLock(
        importMetaUrl,
        normalizedUserId,
        normalizedWorkspace,
      );
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          `Timed out waiting for the Polaris workspace lifecycle lock for '${normalizedUserId}:${normalizedWorkspace}'`,
        );
      }
      await sleepMs(25);
    }
  }

  const heartbeat = startHeartbeat(
    importMetaUrl,
    normalizedUserId,
    normalizedWorkspace,
  );
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await fs.promises.rm(lockPath, { recursive: true, force: true });
  }
}

export async function withWorkspaceMutationLock<T>(
  importMetaUrl: string,
  userId: string,
  workspace: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withUserMutationLock(importMetaUrl, userId, async () =>
    withWorkspaceLifecycleLock(importMetaUrl, userId, workspace, fn)
  );
}
