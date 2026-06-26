import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../");
const USER_MAP_PATH = path.join(REPO_ROOT, "apps", "polaris-web", "config", "user-map.json");

export type PolarisRole = "admin" | "user";
export type PolarisPlan = "free" | "pro";

export interface PortalUserMapEntry {
  polarisUserId: string;
  role: PolarisRole;
  plan: PolarisPlan;
}

interface UserMapFile {
  users: Record<string, PortalUserMapEntry>;
}

export class UserMapConflictError extends Error {}

function normalizeClerkUsername(value: string): string {
  return value.trim().toLowerCase();
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

export function findUserMapEntry(clerkUsername: string): PortalUserMapEntry | null {
  const normalized = normalizeClerkUsername(clerkUsername);
  return readUserMap().users[normalized] ?? null;
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
  if (removedUsernames.length === 0) {
    return [];
  }
  for (const clerkUsername of removedUsernames) {
    delete current.users[clerkUsername];
  }
  writeUserMap(current);
  return removedUsernames;
}
