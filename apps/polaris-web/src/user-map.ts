export type PolarisRole = "admin" | "user";
export type PolarisPlan = "free" | "pro";

export interface UserMapEntry {
  polarisUserId: string;
  role: PolarisRole;
  plan: PolarisPlan;
}

export const explicitUserMap: Record<string, UserMapEntry> = {};
