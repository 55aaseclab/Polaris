import { createHash } from "node:crypto";
import {
  type GatewayRateLimitResult,
  PolarisControlStore,
} from "./control-store.js";
import type { WanghaiGatewayRole } from "../security/wanghai-assertions.js";

export const POLARIS_WANGHAI_RATE_LIMIT_READS_ENV =
  "POLARIS_WANGHAI_RATE_LIMIT_READS_PER_MINUTE";
export const POLARIS_WANGHAI_RATE_LIMIT_MUTATIONS_ENV =
  "POLARIS_WANGHAI_RATE_LIMIT_MUTATIONS_PER_MINUTE";
export const POLARIS_WANGHAI_RATE_LIMIT_UPLOADS_ENV =
  "POLARIS_WANGHAI_RATE_LIMIT_UPLOADS_PER_MINUTE";

export const DEFAULT_WANGHAI_RATE_LIMITS = {
  read: 600,
  mutation: 60,
  upload: 10,
} as const;

export type WanghaiGatewayRequestCategory = "read" | "mutation" | "upload";

export interface WanghaiGatewayPolicyInput {
  tenantId: string;
  vaultId: string;
  userId: string;
  role: WanghaiGatewayRole;
  method?: string;
  pathname: string;
  contentType?: string;
  store: PolarisControlStore;
  env?: NodeJS.ProcessEnv;
  nowSeconds?: number;
}

export interface WanghaiGatewayPolicyDecision {
  allowed: boolean;
  category: WanghaiGatewayRequestCategory;
  statusCode?: 400 | 403 | 429;
  rateLimit?: GatewayRateLimitResult;
}

export class WanghaiGatewayPolicyError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 503 = 503,
  ) {
    super(message);
    this.name = "WanghaiGatewayPolicyError";
  }
}

export function checkWanghaiGatewayPolicy(
  input: WanghaiGatewayPolicyInput,
): WanghaiGatewayPolicyDecision {
  const category = classifyWanghaiGatewayRequest(input);
  const normalizedPath = normalizePathname(input.pathname);
  if (!roleAllowsWanghaiRequest(input.role, category, normalizedPath)) {
    return { allowed: false, category, statusCode: 403 };
  }

  const limits = configuredWanghaiRateLimits(input.env);
  let rateLimit: GatewayRateLimitResult;
  try {
    rateLimit = input.store.consumeGatewayRateLimit({
      bucketKey: gatewayRateLimitBucketKey({
        category,
        tenantId: input.tenantId,
        vaultId: input.vaultId,
        userId: input.userId,
      }),
      limit: limits[category],
      nowSeconds: input.nowSeconds,
    });
  } catch {
    // A missing or unavailable control store must not turn into an unbounded
    // gateway. The caller returns a 503 and keeps the surface private.
    throw new WanghaiGatewayPolicyError("Wanghai gateway policy is unavailable");
  }
  return {
    allowed: rateLimit.allowed,
    category,
    statusCode: rateLimit.allowed ? undefined : 429,
    rateLimit,
  };
}

export function classifyWanghaiGatewayRequest(
  input: Pick<WanghaiGatewayPolicyInput, "method" | "pathname" | "contentType">,
): WanghaiGatewayRequestCategory {
  const method = String(input.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return "read";
  }
  const pathname = normalizePathname(input.pathname);
  const contentType = String(input.contentType ?? "").toLowerCase();
  if (
    contentType.startsWith("multipart/form-data;")
    || /\/assets(?:\/|$)/u.test(pathname)
  ) {
    return "upload";
  }
  return "mutation";
}

export function roleAllowsWanghaiRequest(
  role: WanghaiGatewayRole,
  category: WanghaiGatewayRequestCategory,
  pathname: string,
): boolean {
  if (category === "read") return true;
  if (role === "viewer") return false;
  // External outreach side effects remain an explicit admin capability owned
  // by Polaris, not a body-controlled permission in the surface.
  if (/^\/api\/workspaces\/[^/]+\/outreach(?:\/|$)/u.test(pathname)) {
    return role === "admin";
  }
  return true;
}

export function configuredWanghaiRateLimits(
  env: NodeJS.ProcessEnv = process.env,
): Record<WanghaiGatewayRequestCategory, number> {
  return {
    read: configuredLimit(
      env[POLARIS_WANGHAI_RATE_LIMIT_READS_ENV],
      POLARIS_WANGHAI_RATE_LIMIT_READS_ENV,
      DEFAULT_WANGHAI_RATE_LIMITS.read,
    ),
    mutation: configuredLimit(
      env[POLARIS_WANGHAI_RATE_LIMIT_MUTATIONS_ENV],
      POLARIS_WANGHAI_RATE_LIMIT_MUTATIONS_ENV,
      DEFAULT_WANGHAI_RATE_LIMITS.mutation,
    ),
    upload: configuredLimit(
      env[POLARIS_WANGHAI_RATE_LIMIT_UPLOADS_ENV],
      POLARIS_WANGHAI_RATE_LIMIT_UPLOADS_ENV,
      DEFAULT_WANGHAI_RATE_LIMITS.upload,
    ),
  };
}

export function gatewayRateLimitBucketKey(input: {
  category: WanghaiGatewayRequestCategory;
  tenantId: string;
  vaultId: string;
  userId: string;
}): string {
  const material = [
    "polaris-wanghai-rate-v1",
    input.category,
    input.tenantId,
    input.vaultId,
    input.userId,
  ].join("\0");
  return `v1-${createHash("sha256").update(material, "utf8").digest("hex")}`;
}

function configuredLimit(
  rawValue: string | undefined,
  name: string,
  fallback: number,
): number {
  const raw = String(rawValue ?? "").trim();
  if (!raw) return fallback;
  if (!/^\d+$/u.test(raw)) {
    throw new WanghaiGatewayPolicyError(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000_000) {
    throw new WanghaiGatewayPolicyError(`${name} must be between 1 and 1000000`);
  }
  return value;
}

function normalizePathname(pathname: string): string {
  const raw = String(pathname ?? "").trim();
  if (!raw || raw.length > 4_096) {
    throw new WanghaiGatewayPolicyError("Wanghai gateway path is invalid", 400);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new WanghaiGatewayPolicyError("Wanghai gateway path is invalid", 400);
  }
  if (decoded.includes("\u0000")) {
    throw new WanghaiGatewayPolicyError("Wanghai gateway path is invalid", 400);
  }
  return decoded;
}
