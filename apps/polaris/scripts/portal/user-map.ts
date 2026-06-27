import fs from "node:fs";
import path from "node:path";
import { resolveRepoRoot } from "../utils/repo-root.js";

const REPO_ROOT = resolveRepoRoot(import.meta.url);
const USER_MAP_PATH = path.join(REPO_ROOT, "config", "users", "user-map.json");

export type PolarisRole = "admin" | "user";
export type PolarisPlan = "free" | "pro";

export interface PortalUserMapEntry {
  polarisUserId: string;
  role: PolarisRole;
  plan: PolarisPlan;
}

interface UserMapFile {
  users: Record<string, PortalUserMapEntry>;
  userIds?: Record<string, PortalUserMapEntry>;
}

export class UserMapConflictError extends Error {}

function normalizeClerkUsername(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeClerkUserId(value: string): string {
  return value.trim();
}

export function readUserMap(): UserMapFile {
  if (!fs.existsSync(USER_MAP_PATH)) {
    return { users: {} };
  }
  return JSON.parse(fs.readFileSync(USER_MAP_PATH, "utf8")) as UserMapFile;
}

export function writeUserMap(value: UserMapFile): void {
  fs.mkdirSync(path.dirname(USER_MAP_PATH), { recursive: true });
  fs.writeFileSync(USER_MAP_PATH, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function findUserMapEntry(input: string | {
  clerkUserId?: string;
  clerkUsername?: string;
}): PortalUserMapEntry | null {
  const current = readUserMap();
  if (typeof input === "string") {
    const normalized = normalizeClerkUsername(input);
    return current.users[normalized] ?? null;
  }
  const clerkUserId = normalizeClerkUserId(input.clerkUserId ?? "");
  if (clerkUserId && current.userIds?.[clerkUserId]) {
    return current.userIds[clerkUserId] ?? null;
  }
  const clerkUsername = normalizeClerkUsername(input.clerkUsername ?? "");
  return clerkUsername ? current.users[clerkUsername] ?? null : null;
}

export function findUserMapEntriesForPolarisUserId(
  polarisUserId: string,
): Array<{ clerkUsername: string; entry: PortalUserMapEntry }> {
  return Object.entries(readUserMap().users)
    .filter(([, entry]) => entry.polarisUserId === polarisUserId)
    .map(([clerkUsername, entry]) => ({ clerkUsername, entry }));
}

export function upsertUserMapEntry(
  clerkUsername: string,
  entry: PortalUserMapEntry,
): PortalUserMapEntry {
  const normalized = normalizeClerkUsername(clerkUsername);
  if (!normalized) {
    throw new Error("Clerk username is required");
  }
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
}

export function upsertUserMapUserId(
  clerkUserId: string,
  entry: PortalUserMapEntry,
): PortalUserMapEntry {
  const normalized = normalizeClerkUserId(clerkUserId);
  if (!normalized) {
    throw new Error("Clerk user id is required");
  }
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
}

export function deleteUserMapEntry(clerkUsername: string): boolean {
  const normalized = normalizeClerkUsername(clerkUsername);
  if (!normalized) {
    return false;
  }
  const current = readUserMap();
  if (!current.users[normalized]) {
    return false;
  }
  delete current.users[normalized];
  writeUserMap(current);
  return true;
}

export function deleteUserMapEntriesForPolarisUserId(polarisUserId: string): string[] {
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
}
