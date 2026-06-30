import fs from "node:fs";
import path from "node:path";
import { polarisUsersRoot } from "../utils/paths.js";

const USER_MAP_PATH = path.join(polarisUsersRoot(import.meta.url), "user-map.json");
const USER_MAP_LOCK_PATH = `${USER_MAP_PATH}.lock`;

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
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withUserMapLock<T>(fn: () => T): T {
  const startedAt = Date.now();
  const timeoutMs = 5000;
  while (true) {
    try {
      fs.mkdirSync(USER_MAP_LOCK_PATH);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw error;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error("Timed out waiting for the Polaris user-map lock");
      }
      sleepMs(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(USER_MAP_LOCK_PATH, { recursive: true, force: true });
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

export function upsertUserMapEntry(
  clerkUsername: string,
  entry: PortalUserMapEntry,
): PortalUserMapEntry {
  const normalized = normalizeClerkUsername(clerkUsername);
  if (!normalized) {
    throw new Error("Clerk username is required");
  }
  return withUserMapLock(() => {
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

export function upsertUserMapUserId(
  clerkUserId: string,
  entry: PortalUserMapEntry,
): PortalUserMapEntry {
  const normalized = normalizeClerkUserId(clerkUserId);
  if (!normalized) {
    throw new Error("Clerk user id is required");
  }
  return withUserMapLock(() => {
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

export function deleteUserMapEntry(clerkUsername: string): boolean {
  const normalized = normalizeClerkUsername(clerkUsername);
  if (!normalized) {
    return false;
  }
  return withUserMapLock(() => {
    const current = readUserMap();
    if (!current.users[normalized]) {
      return false;
    }
    delete current.users[normalized];
    writeUserMap(current);
    return true;
  });
}

export function deleteUserMapEntriesForPolarisUserId(polarisUserId: string): string[] {
  return withUserMapLock(() => {
    const current = readUserMap();
    const removedUsernames = Object.entries(current.users)
      .filter(([, entry]) => entry.polarisUserId === polarisUserId)
      .map(([clerkUsername]) => clerkUsername);
    const removedUserIds = Object.entries(current.userIds ?? {})
      .filter(([, entry]) => entry.polarisUserId === polarisUserId)
      .map(([clerkUserId]) => clerkUserId);
    if (removedUsernames.length === 0 && removedUserIds.length === 0) {
      return [];
    }
    for (const clerkUsername of removedUsernames) {
      delete current.users[clerkUsername];
    }
    for (const clerkUserId of removedUserIds) {
      delete current.userIds?.[clerkUserId];
    }
    writeUserMap(current);
    return removedUsernames;
  });
}

export function updateUserAccessEntry(
  polarisUserId: string,
  patch: Partial<Pick<PortalUserMapEntry, "role" | "plan">>,
): PortalUserAccessSummary {
  withUserMapLock(() => {
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
