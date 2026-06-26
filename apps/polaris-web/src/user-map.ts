import rawMap from "../config/user-map.json";

export type PolarisRole = "admin" | "user";
export type PolarisPlan = "free" | "pro";

export interface UserMapEntry {
  polarisUserId: string;
  role: PolarisRole;
  plan: PolarisPlan;
}

interface UserMapFile {
  users?: Record<string, UserMapEntry>;
}

const parsed = rawMap as UserMapFile;

export const explicitUserMap: Record<string, UserMapEntry> = Object.fromEntries(
  Object.entries(parsed.users ?? {}).map(([key, value]) => [
    key.trim().toLowerCase(),
    {
      polarisUserId: String(value.polarisUserId).trim(),
      role: value.role,
      plan: value.plan,
    },
  ]),
);
