import type { WanghaiMutationAdmission } from "./wanghai-mutation-admission.js";

export const POLARIS_ACTIVE_WORKSPACE_QUOTA_BYTES_ENV = "POLARIS_ACTIVE_WORKSPACE_QUOTA_BYTES";
export const DEFAULT_ACTIVE_WORKSPACE_QUOTA_BYTES = 256 * 1024 * 1024;

const MEBIBYTE = 1024 * 1024;
const JSON_MUTATION_OVERHEAD_BYTES = 4 * MEBIBYTE;
const MULTIPART_MUTATION_OVERHEAD_BYTES = 8 * MEBIBYTE;
const MANUAL_REVIEW_EXPORT_OVERHEAD_BYTES = 16 * MEBIBYTE;
const MAX_ACTIVE_WORKSPACE_QUOTA_BYTES = 1024 * 1024 * 1024 * 1024;

export class WanghaiWorkspaceQuotaError extends Error {
  constructor(
    message: string,
    readonly statusCode: 503 | 507,
  ) {
    super(message);
    this.name = "WanghaiWorkspaceQuotaError";
  }
}

/**
 * Development defaults to the reviewed 0.3 profile value. A configured
 * release profile must supply the value that release-profile.mjs verifies.
 */
export function activeWorkspaceQuotaBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env[POLARIS_ACTIVE_WORKSPACE_QUOTA_BYTES_ENV] ?? "").trim();
  if (!raw) {
    if (String(env.POLARIS_RELEASE_PROFILE ?? "").trim()) {
      throw new WanghaiWorkspaceQuotaError(
        `${POLARIS_ACTIVE_WORKSPACE_QUOTA_BYTES_ENV} is required for the configured release profile`,
        503,
      );
    }
    return DEFAULT_ACTIVE_WORKSPACE_QUOTA_BYTES;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new WanghaiWorkspaceQuotaError(
      `${POLARIS_ACTIVE_WORKSPACE_QUOTA_BYTES_ENV} must be a positive byte count`,
      503,
    );
  }
  const bytes = Number(raw);
  if (
    !Number.isSafeInteger(bytes)
    || bytes < MEBIBYTE
    || bytes > MAX_ACTIVE_WORKSPACE_QUOTA_BYTES
  ) {
    throw new WanghaiWorkspaceQuotaError(
      `${POLARIS_ACTIVE_WORKSPACE_QUOTA_BYTES_ENV} is outside the supported range`,
      503,
    );
  }
  return bytes;
}

/**
 * This is a Polaris estimate, not a Wanghai limit. It deliberately reserves
 * more than request bytes for atomic metadata writes and bounded derived work.
 */
export function estimateWanghaiWorkspaceGrowth(input: {
  admission: WanghaiMutationAdmission;
  measuredUsageBytes: number;
  requestBodyBytes: number;
}): number {
  const { action } = input.admission;
  const requestBodyBytes = validateBytes(input.requestBodyBytes, "Wanghai request body");
  const measuredUsageBytes = validateBytes(input.measuredUsageBytes, "Wanghai measured usage");
  if (action.method === "DELETE") return 0;

  const overheadBytes = action.id === "manual-review.export"
    ? MANUAL_REVIEW_EXPORT_OVERHEAD_BYTES
    : action.body === "multipart"
      ? MULTIPART_MUTATION_OVERHEAD_BYTES
      : JSON_MUTATION_OVERHEAD_BYTES;
  const requestEstimate = requestBodyBytes + overheadBytes;
  if (!Number.isSafeInteger(requestEstimate)) {
    throw new WanghaiWorkspaceQuotaError("Wanghai quota estimate exceeds the supported range", 503);
  }
  // An export can materialize a review result from existing workspace inputs.
  // Reserving the observed workspace size keeps that route conservative.
  return action.id === "manual-review.export"
    ? Math.max(requestEstimate, measuredUsageBytes)
    : requestEstimate;
}

function validateBytes(value: unknown, label: string): number {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new WanghaiWorkspaceQuotaError(`${label} is invalid`, 503);
  }
  return bytes;
}
