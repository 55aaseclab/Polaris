import fs from "node:fs";
import path from "node:path";
import { polarisUsersRoot } from "../utils/paths.js";

const USER_MAP_PATH = path.join(polarisUsersRoot(import.meta.url), "user-map.json");
const USER_MAP_LOCK_PATH = `${USER_MAP_PATH}.lock`;
const DEFAULT_USER_MAP_LOCK_TTL_MS = 30_000;
const DEFAULT_USER_MAP_LOCK_TIMEOUT_BUFFER_MS = 5_000;

export type PolarisRole = "admin" | "user";
export type PolarisPlan = "free" | "pro";

export interface PortalUserMapEntry {
  polarisUserId: string;
  role: PolarisRole;
  plan: PolarisPlan;
}

export interface PortalUserAccessSummary {
  polarisUserId: string;
  role: PolarisRole;
  plan: PolarisPlan;
  clerkUsernames: string[];
  clerkUserIds: string[];
}

interface UserMapFile {
  users: Record<string, PortalUserMapEntry>;
  userIds?: Record<string, PortalUserMapEntry>;
}

export class UserMapConflictError extends Error {}

export interface UserMapEntrySnapshot {
  clerkUsernameEntries: Record<string, PortalUserMapEntry>;
  clerkUserIdEntries: Record<string, PortalUserMapEntry>;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function userMapLockTtlMs(): number {
  const configured = Number(process.env.POLARIS_USER_MAP_LOCK_TTL_MS ?? "");
  if (Number.isFinite(configured) && configured >= 100) {
    return Math.floor(configured);
  }
  return DEFAULT_USER_MAP_LOCK_TTL_MS;
}

function userMapLockTimeoutMs(): number {
  return userMapLockTtlMs() + DEFAULT_USER_MAP_LOCK_TIMEOUT_BUFFER_MS;
}

function userMapLockHeartbeatPath(): string {
  return path.join(USER_MAP_LOCK_PATH, "heartbeat");
}

async function touchUserMapLockHeartbeat(): Promise<void> {
  const heartbeatPath = userMapLockHeartbeatPath();
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

function startUserMapLockHeartbeat(): NodeJS.Timeout {
  const intervalMs = Math.max(100, Math.min(1_000, Math.floor(userMapLockTtlMs() / 4)));
  const timer = setInterval(() => {
    void touchUserMapLockHeartbeat().catch(() => {
      // Ignore cleanup races while the lock is being released.
    });
  }, intervalMs);
  timer.unref();
  return timer;
}

async function tryClearStaleUserMapLock(): Promise<boolean> {
  const heartbeatPath = userMapLockHeartbeatPath();
  try {
    const stats = await fs.promises.stat(heartbeatPath)
      .catch(async (error) => {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          return fs.promises.stat(USER_MAP_LOCK_PATH);
        }
        throw error;
      });
    if (Date.now() - stats.mtimeMs < userMapLockTtlMs()) {
      return false;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  await fs.promises.rm(USER_MAP_LOCK_PATH, { recursive: true, force: true });
  return true;
}

export async function withUserMapLock<T>(fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const timeoutMs = userMapLockTimeoutMs();
  for (;;) {
    try {
      await fs.promises.mkdir(USER_MAP_LOCK_PATH);
      await touchUserMapLockHeartbeat();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw error;
      }
      await tryClearStaleUserMapLock();
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error("Timed out waiting for the Polaris user-map lock");
      }
      await sleepMs(25);
    }
  }
  const heartbeat = startUserMapLockHeartbeat();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await fs.promises.rm(USER_MAP_LOCK_PATH, { recursive: true, force: true });
  }
}

function normalizeClerkUsername(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeClerkUserId(value: string): string {
  return value.trim();
}

function bootstrapAdminTokens(): Set<string> {
  return new Set(
    String(process.env.POLARIS_BOOTSTRAP_ADMIN_USERS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function withRoleOverrides(
  entry: PortalUserMapEntry,
  identities: string[],
): PortalUserMapEntry {
  const overrides = bootstrapAdminTokens();
  if (identities.some((value) => overrides.has(value.trim().toLowerCase()))) {
    return {
      ...entry,
      role: "admin",
    };
  }
  return entry;
}

function hasBootstrapAdminOverride(identities: string[]): boolean {
  const overrides = bootstrapAdminTokens();
  return identities.some((value) => overrides.has(value.trim().toLowerCase()));
}

export function readUserMap(): UserMapFile {
  if (!fs.existsSync(USER_MAP_PATH)) {
    return { users: {} };
  }
  return JSON.parse(fs.readFileSync(USER_MAP_PATH, "utf8")) as UserMapFile;
}

function snapshotEntriesForPolarisUserId(
  current: UserMapFile,
  polarisUserId: string,
): UserMapEntrySnapshot {
  return {
    clerkUsernameEntries: Object.fromEntries(
      Object.entries(current.users)
        .filter(([, entry]) => entry.polarisUserId === polarisUserId),
    ),
    clerkUserIdEntries: Object.fromEntries(
      Object.entries(current.userIds ?? {})
        .filter(([, entry]) => entry.polarisUserId === polarisUserId),
    ),
  };
}

function deleteEntriesForPolarisUserId(
  current: UserMapFile,
  polarisUserId: string,
): UserMapEntrySnapshot {
  const snapshot = snapshotEntriesForPolarisUserId(current, polarisUserId);
  for (const clerkUsername of Object.keys(snapshot.clerkUsernameEntries)) {
    delete current.users[clerkUsername];
  }
  for (const clerkUserId of Object.keys(snapshot.clerkUserIdEntries)) {
    delete current.userIds?.[clerkUserId];
  }
  return snapshot;
}

export function writeUserMap(value: UserMapFile): void {
  fs.mkdirSync(path.dirname(USER_MAP_PATH), { recursive: true });
  const tempPath = `${USER_MAP_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, USER_MAP_PATH);
}

export function findUserMapEntry(input: string | {
  clerkUserId?: string;
  clerkUsername?: string;
}): PortalUserMapEntry | null {
  const current = readUserMap();
  if (typeof input === "string") {
    const normalized = normalizeClerkUsername(input);
    const entry = current.users[normalized] ?? null;
    return entry ? withRoleOverrides(entry, [normalized, entry.polarisUserId]) : null;
  }
  const clerkUserId = normalizeClerkUserId(input.clerkUserId ?? "");
  if (clerkUserId && current.userIds?.[clerkUserId]) {
    const entry = current.userIds[clerkUserId] ?? null;
    return entry ? withRoleOverrides(entry, [clerkUserId, entry.polarisUserId]) : null;
  }
  const clerkUsername = normalizeClerkUsername(input.clerkUsername ?? "");
  if (!clerkUsername) {
    return null;
  }
  const entry = current.users[clerkUsername] ?? null;
  return entry ? withRoleOverrides(entry, [clerkUsername, entry.polarisUserId]) : null;
}

export function findUserMapEntriesForPolarisUserId(
  polarisUserId: string,
): Array<{ clerkUsername: string; entry: PortalUserMapEntry }> {
  return Object.entries(readUserMap().users)
    .filter(([, entry]) => entry.polarisUserId === polarisUserId)
    .map(([clerkUsername, entry]) => ({
      clerkUsername,
      entry: withRoleOverrides(entry, [clerkUsername, entry.polarisUserId]),
    }));
}

export function readUserAccessSummary(
  polarisUserId: string,
): PortalUserAccessSummary | null {
  const current = readUserMap();
  const usernameEntries = Object.entries(current.users)
    .filter(([, entry]) => entry.polarisUserId === polarisUserId);
  const userIdEntries = Object.entries(current.userIds ?? {})
    .filter(([, entry]) => entry.polarisUserId === polarisUserId);
  const seed = usernameEntries[0]?.[1] ?? userIdEntries[0]?.[1] ?? null;
  const identities = [
    polarisUserId,
    ...usernameEntries.map(([key]) => key),
    ...userIdEntries.map(([key]) => key),
  ];
  if (!seed) {
    if (!hasBootstrapAdminOverride(identities)) {
      return null;
    }
    return {
      polarisUserId,
      role: "admin",
      plan: "free",
      clerkUsernames: [],
      clerkUserIds: [],
    };
  }
  const effective = withRoleOverrides(seed, identities);
  return {
    polarisUserId,
    role: effective.role,
    plan: effective.plan,
    clerkUsernames: usernameEntries.map(([clerkUsername]) => clerkUsername).sort(),
    clerkUserIds: userIdEntries.map(([clerkUserId]) => clerkUserId).sort(),
  };
}

export function listUserAccessSummaries(): PortalUserAccessSummary[] {
  const current = readUserMap();
  const userIds = new Set<string>([
    ...Object.values(current.users).map((entry) => entry.polarisUserId),
    ...Object.values(current.userIds ?? {}).map((entry) => entry.polarisUserId),
    ...bootstrapAdminTokens(),
  ]);
  return Array.from(userIds)
    .map((polarisUserId) => readUserAccessSummary(polarisUserId))
    .filter((entry): entry is PortalUserAccessSummary => Boolean(entry))
    .sort((left, right) => left.polarisUserId.localeCompare(right.polarisUserId));
}

export async function upsertUserMapEntry(
  clerkUsername: string,
  entry: PortalUserMapEntry,
): Promise<PortalUserMapEntry> {
  const normalized = normalizeClerkUsername(clerkUsername);
  if (!normalized) {
    throw new Error("Clerk username is required");
  }
  return withUserMapLock(async () => {
    const current = readUserMap();
    const existing = current.users[normalized];
    if (existing && existing.polarisUserId !== entry.polarisUserId) {
      throw new UserMapConflictError(
        `Clerk username '${normalized}' is already mapped to Polaris user '${existing.polarisUserId}'`,
      );
    }
    current.users[normalized] = {
      polarisUserId: entry.polarisUserId,
      role: entry.role,
      plan: entry.plan,
    };
    writeUserMap(current);
    return current.users[normalized];
  });
}

export async function upsertUserMapEntries(input: {
  clerkUsername?: string;
  clerkUserId?: string;
  entry: PortalUserMapEntry;
}): Promise<void> {
  const normalizedUsername = normalizeClerkUsername(input.clerkUsername ?? "");
  const normalizedUserId = normalizeClerkUserId(input.clerkUserId ?? "");
  if (!normalizedUsername && !normalizedUserId) {
    throw new Error("Clerk identity is required");
  }
  await withUserMapLock(async () => {
    const current = readUserMap();
    current.userIds ??= {};
    if (normalizedUsername) {
      const existing = current.users[normalizedUsername];
      if (existing && existing.polarisUserId !== input.entry.polarisUserId) {
        throw new UserMapConflictError(
          `Clerk username '${normalizedUsername}' is already mapped to Polaris user '${existing.polarisUserId}'`,
        );
      }
    }
    if (normalizedUserId) {
      const existing = current.userIds[normalizedUserId];
      if (existing && existing.polarisUserId !== input.entry.polarisUserId) {
        throw new UserMapConflictError(
          `Clerk user id '${normalizedUserId}' is already mapped to Polaris user '${existing.polarisUserId}'`,
        );
      }
    }
    if (normalizedUsername) {
      current.users[normalizedUsername] = {
        polarisUserId: input.entry.polarisUserId,
        role: input.entry.role,
        plan: input.entry.plan,
      };
    }
    if (normalizedUserId) {
      current.userIds[normalizedUserId] = {
        polarisUserId: input.entry.polarisUserId,
        role: input.entry.role,
        plan: input.entry.plan,
      };
    }
    writeUserMap(current);
  });
}

export async function upsertUserMapUserId(
  clerkUserId: string,
  entry: PortalUserMapEntry,
): Promise<PortalUserMapEntry> {
  const normalized = normalizeClerkUserId(clerkUserId);
  if (!normalized) {
    throw new Error("Clerk user id is required");
  }
  return withUserMapLock(async () => {
    const current = readUserMap();
    current.userIds ??= {};
    const existing = current.userIds[normalized];
    if (existing && existing.polarisUserId !== entry.polarisUserId) {
      throw new UserMapConflictError(
        `Clerk user id '${normalized}' is already mapped to Polaris user '${existing.polarisUserId}'`,
      );
    }
    current.userIds[normalized] = {
      polarisUserId: entry.polarisUserId,
      role: entry.role,
      plan: entry.plan,
    };
    writeUserMap(current);
    return current.userIds[normalized];
  });
}

export async function deleteUserMapEntry(clerkUsername: string): Promise<boolean> {
  const normalized = normalizeClerkUsername(clerkUsername);
  if (!normalized) {
    return false;
  }
  return withUserMapLock(async () => {
    const current = readUserMap();
    if (!current.users[normalized]) {
      return false;
    }
    delete current.users[normalized];
    writeUserMap(current);
    return true;
  });
}

export async function deleteUserMapEntriesForPolarisUserId(
  polarisUserId: string,
): Promise<{
  clerkUsernames: string[];
  clerkUserIds: string[];
}> {
  return withUserMapLock(async () => {
    const current = readUserMap();
    const removed = deleteEntriesForPolarisUserId(current, polarisUserId);
    const removedUsernames = Object.keys(removed.clerkUsernameEntries);
    const removedUserIds = Object.keys(removed.clerkUserIdEntries);
    if (removedUsernames.length === 0 && removedUserIds.length === 0) {
      return {
        clerkUsernames: [],
        clerkUserIds: [],
      };
    }
    writeUserMap(current);
    return {
      clerkUsernames: removedUsernames,
      clerkUserIds: removedUserIds,
    };
  });
}

export async function deleteUserMapEntriesWithSnapshot(
  polarisUserId: string,
): Promise<UserMapEntrySnapshot> {
  return withUserMapLock(async () => {
    const current = readUserMap();
    const removed = deleteEntriesForPolarisUserId(current, polarisUserId);
    const removedUsernames = Object.keys(removed.clerkUsernameEntries);
    const removedUserIds = Object.keys(removed.clerkUserIdEntries);
    if (removedUsernames.length > 0 || removedUserIds.length > 0) {
      writeUserMap(current);
    }
    return removed;
  });
}

export async function withDeletedUserMapEntries<T>(
  polarisUserId: string,
  fn: (snapshot: UserMapEntrySnapshot) => Promise<T>,
): Promise<T> {
  return withUserMapLock(async () => {
    const current = readUserMap();
    const snapshot = deleteEntriesForPolarisUserId(current, polarisUserId);
    const removedUsernames = Object.keys(snapshot.clerkUsernameEntries);
    const removedUserIds = Object.keys(snapshot.clerkUserIdEntries);
    if (removedUsernames.length > 0 || removedUserIds.length > 0) {
      writeUserMap(current);
    }
    try {
      return await fn(snapshot);
    } catch (error) {
      const rollback = readUserMap();
      rollback.userIds ??= {};
      for (const [clerkUsername, entry] of Object.entries(snapshot.clerkUsernameEntries)) {
        rollback.users[clerkUsername] = entry;
      }
      for (const [clerkUserId, entry] of Object.entries(snapshot.clerkUserIdEntries)) {
        rollback.userIds[clerkUserId] = entry;
      }
      writeUserMap(rollback);
      throw error;
    }
  });
}

export async function updateUserAccessEntry(
  polarisUserId: string,
  patch: Partial<Pick<PortalUserMapEntry, "role" | "plan">>,
): Promise<PortalUserAccessSummary> {
  await withUserMapLock(async () => {
    const current = readUserMap();
    let touched = false;
    for (const entry of Object.values(current.users)) {
      if (entry.polarisUserId !== polarisUserId) {
        continue;
      }
      if (patch.role) {
        entry.role = patch.role;
      }
      if (patch.plan) {
        entry.plan = patch.plan;
      }
      touched = true;
    }
    for (const entry of Object.values(current.userIds ?? {})) {
      if (entry.polarisUserId !== polarisUserId) {
        continue;
      }
      if (patch.role) {
        entry.role = patch.role;
      }
      if (patch.plan) {
        entry.plan = patch.plan;
      }
      touched = true;
    }
    if (!touched) {
      throw new Error(`Polaris user '${polarisUserId}' does not have a Clerk mapping yet`);
    }
    writeUserMap(current);
  });
  const updated = readUserAccessSummary(polarisUserId);
  if (!updated) {
    throw new Error(`Polaris user '${polarisUserId}' access could not be reloaded`);
  }
  return updated;
}
