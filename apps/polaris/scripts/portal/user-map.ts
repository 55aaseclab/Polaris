import fs from "node:fs";
import path from "node:path";
import { polarisUsersRoot } from "../utils/paths.js";

const USER_MAP_PATH = path.join(polarisUsersRoot(import.meta.url), "user-map.json");
const USER_MAP_LOCK_PATH = `${USER_MAP_PATH}.lock`;
const DEFAULT_USER_MAP_LOCK_TTL_MS = 30_000;
const DEFAULT_USER_MAP_LOCK_TIMEOUT_BUFFER_MS = 5_000;

export type PolarisRole = "admin" | "user";
/** Feature richness tier. Kept for billing/entitlements; not product line. */
export type PolarisPlan = "free" | "pro";
/**
 * Subscription product line (what product the user is on).
 * Independent of free/pro — free/pro only means how many features within a line.
 */
export type PolarisSubscriptionLine = "coding" | "vertical";

export interface PortalUserMapEntry {
  polarisUserId: string;
  role: PolarisRole;
  plan: PolarisPlan;
  /** Defaults to coding when missing (older user-map rows). */
  line: PolarisSubscriptionLine;
}

export interface PortalUserAccessSummary {
  polarisUserId: string;
  role: PolarisRole;
  plan: PolarisPlan;
  line: PolarisSubscriptionLine;
  authingUsernames: string[];
  authingUserIds: string[];
}

interface UserMapFile {
  users: Record<string, PortalUserMapEntry>;
  userIds?: Record<string, PortalUserMapEntry>;
}

export class UserMapConflictError extends Error {}

export interface UserMapEntrySnapshot {
  authingUsernameEntries: Record<string, PortalUserMapEntry>;
  authingUserIdEntries: Record<string, PortalUserMapEntry>;
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

function normalizeAuthingUsername(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeAuthingUserId(value: string): string {
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

export function normalizePolarisPlan(value: unknown): PolarisPlan {
  return value === "pro" ? "pro" : "free";
}

export function normalizePolarisSubscriptionLine(value: unknown): PolarisSubscriptionLine {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "vertical" || raw === "wanghai" || raw === "polaris-vertical") {
    return "vertical";
  }
  return "coding";
}

/** Fill defaults for older user-map rows that only had role/plan. */
export function normalizePortalUserMapEntry(
  entry: Partial<PortalUserMapEntry> & Pick<PortalUserMapEntry, "polarisUserId">,
): PortalUserMapEntry {
  return {
    polarisUserId: entry.polarisUserId,
    role: entry.role === "admin" ? "admin" : "user",
    plan: normalizePolarisPlan(entry.plan),
    line: normalizePolarisSubscriptionLine(entry.line),
  };
}

function withRoleOverrides(
  entry: PortalUserMapEntry,
  identities: string[],
): PortalUserMapEntry {
  const normalized = normalizePortalUserMapEntry(entry);
  const overrides = bootstrapAdminTokens();
  if (identities.some((value) => overrides.has(value.trim().toLowerCase()))) {
    return {
      ...normalized,
      role: "admin",
    };
  }
  return normalized;
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
    authingUsernameEntries: Object.fromEntries(
      Object.entries(current.users)
        .filter(([, entry]) => entry.polarisUserId === polarisUserId),
    ),
    authingUserIdEntries: Object.fromEntries(
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
  for (const authingUsername of Object.keys(snapshot.authingUsernameEntries)) {
    delete current.users[authingUsername];
  }
  for (const authingUserId of Object.keys(snapshot.authingUserIdEntries)) {
    delete current.userIds?.[authingUserId];
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
  authingUserId?: string;
  authingUsername?: string;
}): PortalUserMapEntry | null {
  const current = readUserMap();
  if (typeof input === "string") {
    const normalized = normalizeAuthingUsername(input);
    const entry = current.users[normalized] ?? null;
    return entry ? withRoleOverrides(entry, [normalized, entry.polarisUserId]) : null;
  }
  const authingUserId = normalizeAuthingUserId(input.authingUserId ?? "");
  if (authingUserId && current.userIds?.[authingUserId]) {
    const entry = current.userIds[authingUserId] ?? null;
    return entry ? withRoleOverrides(entry, [authingUserId, entry.polarisUserId]) : null;
  }
  const authingUsername = normalizeAuthingUsername(input.authingUsername ?? "");
  if (!authingUsername) {
    return null;
  }
  const entry = current.users[authingUsername] ?? null;
  return entry ? withRoleOverrides(entry, [authingUsername, entry.polarisUserId]) : null;
}

export function findUserMapEntriesForPolarisUserId(
  polarisUserId: string,
): Array<{ authingUsername: string; entry: PortalUserMapEntry }> {
  return Object.entries(readUserMap().users)
    .filter(([, entry]) => entry.polarisUserId === polarisUserId)
    .map(([authingUsername, entry]) => ({
      authingUsername,
      entry: withRoleOverrides(entry, [authingUsername, entry.polarisUserId]),
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
      line: "coding",
      authingUsernames: [],
      authingUserIds: [],
    };
  }
  const effective = withRoleOverrides(seed, identities);
  return {
    polarisUserId,
    role: effective.role,
    plan: effective.plan,
    line: effective.line,
    authingUsernames: usernameEntries.map(([authingUsername]) => authingUsername).sort(),
    authingUserIds: userIdEntries.map(([authingUserId]) => authingUserId).sort(),
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
  authingUsername: string,
  entry: PortalUserMapEntry,
): Promise<PortalUserMapEntry> {
  const normalized = normalizeAuthingUsername(authingUsername);
  if (!normalized) {
    throw new Error("Authing username is required");
  }
  return withUserMapLock(async () => {
    const current = readUserMap();
    const existing = current.users[normalized];
    if (existing && existing.polarisUserId !== entry.polarisUserId) {
      throw new UserMapConflictError(
        `Authing username '${normalized}' is already mapped to Polaris user '${existing.polarisUserId}'`,
      );
    }
    current.users[normalized] = normalizePortalUserMapEntry(entry);
    writeUserMap(current);
    return current.users[normalized];
  });
}

export async function upsertUserMapEntries(input: {
  authingUsername?: string;
  authingUserId?: string;
  entry: PortalUserMapEntry;
}): Promise<void> {
  const normalizedUsername = normalizeAuthingUsername(input.authingUsername ?? "");
  const normalizedUserId = normalizeAuthingUserId(input.authingUserId ?? "");
  if (!normalizedUsername && !normalizedUserId) {
    throw new Error("Authing identity is required");
  }
  await withUserMapLock(async () => {
    const current = readUserMap();
    current.userIds ??= {};
    if (normalizedUsername) {
      const existing = current.users[normalizedUsername];
      if (existing && existing.polarisUserId !== input.entry.polarisUserId) {
        throw new UserMapConflictError(
          `Authing username '${normalizedUsername}' is already mapped to Polaris user '${existing.polarisUserId}'`,
        );
      }
    }
    if (normalizedUserId) {
      const existing = current.userIds[normalizedUserId];
      if (existing && existing.polarisUserId !== input.entry.polarisUserId) {
        throw new UserMapConflictError(
          `Authing user id '${normalizedUserId}' is already mapped to Polaris user '${existing.polarisUserId}'`,
        );
      }
    }
    const normalizedEntry = normalizePortalUserMapEntry(input.entry);
    if (normalizedUsername) {
      current.users[normalizedUsername] = normalizedEntry;
    }
    if (normalizedUserId) {
      current.userIds[normalizedUserId] = normalizedEntry;
    }
    writeUserMap(current);
  });
}

export async function upsertUserMapUserId(
  authingUserId: string,
  entry: PortalUserMapEntry,
): Promise<PortalUserMapEntry> {
  const normalized = normalizeAuthingUserId(authingUserId);
  if (!normalized) {
    throw new Error("Authing user id is required");
  }
  return withUserMapLock(async () => {
    const current = readUserMap();
    current.userIds ??= {};
    const existing = current.userIds[normalized];
    if (existing && existing.polarisUserId !== entry.polarisUserId) {
      throw new UserMapConflictError(
        `Authing user id '${normalized}' is already mapped to Polaris user '${existing.polarisUserId}'`,
      );
    }
    current.userIds[normalized] = normalizePortalUserMapEntry(entry);
    writeUserMap(current);
    return current.userIds[normalized];
  });
}

export async function deleteUserMapEntry(authingUsername: string): Promise<boolean> {
  const normalized = normalizeAuthingUsername(authingUsername);
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
  authingUsernames: string[];
  authingUserIds: string[];
}> {
  return withUserMapLock(async () => {
    const current = readUserMap();
    const removed = deleteEntriesForPolarisUserId(current, polarisUserId);
    const removedUsernames = Object.keys(removed.authingUsernameEntries);
    const removedUserIds = Object.keys(removed.authingUserIdEntries);
    if (removedUsernames.length === 0 && removedUserIds.length === 0) {
      return {
        authingUsernames: [],
        authingUserIds: [],
      };
    }
    writeUserMap(current);
    return {
      authingUsernames: removedUsernames,
      authingUserIds: removedUserIds,
    };
  });
}

export async function deleteUserMapEntriesWithSnapshot(
  polarisUserId: string,
): Promise<UserMapEntrySnapshot> {
  return withUserMapLock(async () => {
    const current = readUserMap();
    const removed = deleteEntriesForPolarisUserId(current, polarisUserId);
    const removedUsernames = Object.keys(removed.authingUsernameEntries);
    const removedUserIds = Object.keys(removed.authingUserIdEntries);
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
  const snapshot = await withUserMapLock(async () => {
    const current = readUserMap();
    const removed = deleteEntriesForPolarisUserId(current, polarisUserId);
    const removedUsernames = Object.keys(removed.authingUsernameEntries);
    const removedUserIds = Object.keys(removed.authingUserIdEntries);
    if (removedUsernames.length > 0 || removedUserIds.length > 0) {
      writeUserMap(current);
    }
    return removed;
  });
  try {
    return await fn(snapshot);
  } catch (error) {
    await withUserMapLock(async () => {
      const rollback = readUserMap();
      rollback.userIds ??= {};
      for (const [authingUsername, entry] of Object.entries(snapshot.authingUsernameEntries)) {
        rollback.users[authingUsername] = entry;
      }
      for (const [authingUserId, entry] of Object.entries(snapshot.authingUserIdEntries)) {
        rollback.userIds[authingUserId] = entry;
      }
      writeUserMap(rollback);
    });
    throw error;
  }
}

export async function updateUserAccessEntry(
  polarisUserId: string,
  patch: Partial<Pick<PortalUserMapEntry, "role" | "plan" | "line">>,
): Promise<PortalUserAccessSummary> {
  await withUserMapLock(async () => {
    const current = readUserMap();
    let touched = false;
    for (const [key, raw] of Object.entries(current.users)) {
      if (raw.polarisUserId !== polarisUserId) {
        continue;
      }
      const entry = normalizePortalUserMapEntry(raw);
      if (patch.role) {
        entry.role = patch.role;
      }
      if (patch.plan) {
        entry.plan = patch.plan;
      }
      if (patch.line) {
        entry.line = patch.line;
      }
      current.users[key] = entry;
      touched = true;
    }
    current.userIds ??= {};
    for (const [key, raw] of Object.entries(current.userIds)) {
      if (raw.polarisUserId !== polarisUserId) {
        continue;
      }
      const entry = normalizePortalUserMapEntry(raw);
      if (patch.role) {
        entry.role = patch.role;
      }
      if (patch.plan) {
        entry.plan = patch.plan;
      }
      if (patch.line) {
        entry.line = patch.line;
      }
      current.userIds[key] = entry;
      touched = true;
    }
    if (!touched) {
      throw new Error(`Polaris user '${polarisUserId}' does not have a Authing mapping yet`);
    }
    writeUserMap(current);
  });
  const updated = readUserAccessSummary(polarisUserId);
  if (!updated) {
    throw new Error(`Polaris user '${polarisUserId}' access could not be reloaded`);
  }
  return updated;
}
