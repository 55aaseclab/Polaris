import { stripWanghaiBasePath } from "@/lib/paths";

export type WanghaiGatewayRole = "viewer" | "operator" | "admin";

export type WanghaiRuntimeMode = "polaris" | "standalone";

export const WANGHAI_RUNTIME_MODE_ENV = "WANGHAI_RUNTIME_MODE";
export const WANGHAI_GATEWAY_FRAME_ANCESTORS_ENV = "WANGHAI_GATEWAY_FRAME_ANCESTORS";
export const WANGHAI_STANDALONE_IDENTITY_SECRET_ENV = "WANGHAI_STANDALONE_IDENTITY_SECRET";
export const WANGHAI_STANDALONE_TENANT_ID_ENV = "WANGHAI_STANDALONE_TENANT_ID";
export const WANGHAI_STANDALONE_VAULT_ID_ENV = "WANGHAI_STANDALONE_VAULT_ID";
export const WANGHAI_STANDALONE_FRAME_ANCESTORS_ENV = "WANGHAI_STANDALONE_FRAME_ANCESTORS";
export const WANGHAI_GATEWAY_ASSERTION_HEADER = "x-polaris-wanghai-assertion";
export const WANGHAI_GATEWAY_REQUEST_ID_HEADER = "x-polaris-request-id";
export const WANGHAI_STANDALONE_IDENTITY_HEADER = "x-wanghai-standalone-identity";
export const WANGHAI_STANDALONE_REQUEST_ID_HEADER = "x-wanghai-standalone-request-id";
export const WANGHAI_STANDALONE_ISSUER = "wanghai-standalone-proxy" as const;
export const WANGHAI_STANDALONE_READ_CAPABILITY = "wanghai.read";
export const MAX_WANGHAI_GATEWAY_ASSERTION_TTL_SECONDS = 120;

export interface VerifiedPolarisGatewayClaims {
  v: 1;
  iss: "polaris";
  aud: "wanghai";
  sub: string;
  tenant_id: string;
  vault_id: string;
  role: WanghaiGatewayRole;
  request_id: string;
  iat: number;
  exp: number;
  admission?: VerifiedWanghaiMutationAdmission;
  quota_measurement?: "active_workspace";
}

export interface VerifiedStandaloneGatewayClaims {
  v: 1;
  iss: typeof WANGHAI_STANDALONE_ISSUER;
  aud: "wanghai";
  sub: string;
  tenant_id: string;
  vault_id: string;
  role: WanghaiGatewayRole;
  capabilities: string[];
  request_id: string;
  request_method: string;
  request_target: string;
  iat: number;
  exp: number;
  admission?: VerifiedWanghaiMutationAdmission;
}

export type VerifiedWanghaiGatewayClaims =
  | VerifiedPolarisGatewayClaims
  | VerifiedStandaloneGatewayClaims;

export interface VerifiedWanghaiMutationAdmission {
  action: string;
  action_version: 1;
  workspace_id: string;
  idempotency_key: string;
  request_hash: string;
  expected_version?: number;
  quota_reservation_id?: string;
}

export class WanghaiGatewayAuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: 401 | 403 | 503 = 401,
  ) {
    super(message);
    this.name = "WanghaiGatewayAuthError";
  }
}

export async function verifyWanghaiGatewayRequest(
  request: Request,
): Promise<VerifiedWanghaiGatewayClaims> {
  return wanghaiRuntimeMode() === "standalone"
    ? verifyStandaloneGatewayRequest(request)
    : verifyPolarisGatewayRequest(request);
}

export function wanghaiRuntimeMode(
  env: NodeJS.ProcessEnv = process.env,
): WanghaiRuntimeMode {
  const configured = String(env[WANGHAI_RUNTIME_MODE_ENV] ?? "").trim();
  const mode = configured || "standalone";
  if (mode !== "polaris" && mode !== "standalone") {
    throw new WanghaiGatewayAuthError(
      `${WANGHAI_RUNTIME_MODE_ENV} must be polaris or standalone`,
      503,
    );
  }
  return mode;
}

async function verifyPolarisGatewayRequest(
  request: Request,
): Promise<VerifiedPolarisGatewayClaims> {
  if (
    request.headers.has(WANGHAI_STANDALONE_IDENTITY_HEADER)
    || request.headers.has(WANGHAI_STANDALONE_REQUEST_ID_HEADER)
  ) {
    throw new WanghaiGatewayAuthError(
      "A standalone identity envelope is not accepted in Polaris mode",
    );
  }
  const { secret, tenantId: expectedTenant, vaultId: expectedVault } = gatewayVerificationConfig();
  const claims = await readSignedEnvelope(
    request,
    WANGHAI_GATEWAY_ASSERTION_HEADER,
    secret,
    "A valid Polaris gateway assertion is required",
  );
  if (!isGatewayClaims(claims)) {
    throw new WanghaiGatewayAuthError("The Polaris gateway assertion is invalid");
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.exp <= now
    || claims.iat > now + 30
    || claims.exp - claims.iat > MAX_WANGHAI_GATEWAY_ASSERTION_TTL_SECONDS
  ) {
    throw new WanghaiGatewayAuthError(
      "The Polaris gateway assertion has expired or has an invalid lifetime",
    );
  }
  if (claims.tenant_id !== expectedTenant || claims.vault_id !== expectedVault) {
    throw new WanghaiGatewayAuthError("The Polaris gateway assertion scope is invalid");
  }
  const requestId = request.headers.get(WANGHAI_GATEWAY_REQUEST_ID_HEADER)?.trim() ?? "";
  if (!requestId || requestId !== claims.request_id) {
    throw new WanghaiGatewayAuthError("The Polaris gateway request ID is invalid");
  }
  return claims;
}

async function verifyStandaloneGatewayRequest(
  request: Request,
): Promise<VerifiedStandaloneGatewayClaims> {
  if (
    request.headers.has(WANGHAI_GATEWAY_ASSERTION_HEADER)
    || request.headers.has(WANGHAI_GATEWAY_REQUEST_ID_HEADER)
  ) {
    throw new WanghaiGatewayAuthError(
      "A Polaris gateway assertion is not accepted in standalone mode",
    );
  }
  const {
    secret,
    tenantId: expectedTenant,
    vaultId: expectedVault,
  } = standaloneGatewayVerificationConfig();
  const claims = await readSignedEnvelope(
    request,
    WANGHAI_STANDALONE_IDENTITY_HEADER,
    secret,
    "A valid standalone identity envelope is required",
  );
  if (!isStandaloneGatewayClaims(claims)) {
    throw new WanghaiGatewayAuthError("The standalone identity envelope is invalid");
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.exp <= now
    || claims.iat > now + 30
    || claims.exp - claims.iat > MAX_WANGHAI_GATEWAY_ASSERTION_TTL_SECONDS
  ) {
    throw new WanghaiGatewayAuthError(
      "The standalone identity envelope has expired or has an invalid lifetime",
    );
  }
  if (claims.tenant_id !== expectedTenant || claims.vault_id !== expectedVault) {
    throw new WanghaiGatewayAuthError("The standalone identity scope is invalid");
  }
  const requestId = request.headers.get(WANGHAI_STANDALONE_REQUEST_ID_HEADER)?.trim() ?? "";
  if (!requestId || requestId !== claims.request_id) {
    throw new WanghaiGatewayAuthError("The standalone identity request ID is invalid");
  }
  if (claims.request_method !== request.method.toUpperCase()) {
    throw new WanghaiGatewayAuthError("The standalone identity method scope is invalid");
  }
  // Next and other HTTP layers may normalize query values while preserving
  // the same request semantics. Verify the normalized, surface-relative
  // target so an asset path such as `assets/foo.png` has one signed form.
  const requestTarget = canonicalRequestTarget(request);
  if (claims.request_target !== requestTarget) {
    throw new WanghaiGatewayAuthError("The standalone identity route scope is invalid");
  }
  return claims;
}

function canonicalRequestTarget(request: Request): string {
  const requestUrl = new URL(request.url);
  const search = requestUrl.searchParams.toString();
  return `${stripWanghaiBasePath(requestUrl.pathname)}${search ? `?${search}` : ""}`;
}

/**
 * The usage endpoint is a Polaris-to-Wanghai control-plane call, not a browser
 * surface. It accepts only its dedicated signed purpose claim.
 */
export async function assertWanghaiQuotaMeasurementRequest(
  request: Request,
): Promise<VerifiedWanghaiGatewayClaims> {
  const claims = await verifyWanghaiGatewayRequest(request);
  if (
    claims.iss !== "polaris"
    || request.method.toUpperCase() !== "GET"
    || claims.quota_measurement !== "active_workspace"
    || claims.admission !== undefined
  ) {
    throw new WanghaiGatewayAuthError("A Polaris quota measurement assertion is required", 403);
  }
  return claims;
}

/**
 * The shell embeds Wanghai from a separate Polaris origin. X-Frame-Options
 * cannot express that relationship, so use a strict, configured CSP source
 * list instead. Standalone mode defaults to same-origin framing unless an
 * operator explicitly configures additional origins.
 */
export function wanghaiGatewayFrameAncestorsDirective(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const mode = wanghaiRuntimeMode(env);
  const envName = mode === "polaris"
    ? WANGHAI_GATEWAY_FRAME_ANCESTORS_ENV
    : WANGHAI_STANDALONE_FRAME_ANCESTORS_ENV;
  const configured = String(env[envName] ?? "")
    .split(/\s+/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.length === 0) {
    if (mode === "standalone") return "frame-ancestors 'self'";
    throw new WanghaiGatewayAuthError(`${envName} is required`, 503);
  }
  const origins = [...new Set(
    configured
      .filter((value) => value !== "self" && value !== "'self'")
      .map((value) => normalizeFrameAncestorOrigin(value, envName)),
  )];
  return `frame-ancestors 'self'${origins.length > 0 ? ` ${origins.join(" ")}` : ""}`;
}

export function isWanghaiGatewayReady(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const mode = wanghaiRuntimeMode(env);
    if (mode === "polaris") gatewayVerificationConfig(env);
    else standaloneGatewayVerificationConfig(env);
    wanghaiGatewayFrameAncestorsDirective(env);
    return true;
  } catch {
    return false;
  }
}

export function hasWanghaiStandaloneCapability(
  claims: VerifiedWanghaiGatewayClaims,
  capability: string,
): boolean {
  return claims.iss === WANGHAI_STANDALONE_ISSUER
    && claims.capabilities.includes(capability);
}

/**
 * Verify the HMAC envelope supplied by the trusted standalone proxy. The
 * envelope is deliberately separate from the Polaris assertion so a
 * standalone deployment cannot accidentally become a Polaris trust sink.
 */
async function readSignedEnvelope(
  request: Request,
  headerName: string,
  secret: string,
  invalidMessage: string,
): Promise<unknown> {
  const token = request.headers.get(headerName)?.trim() ?? "";
  const [encodedPayload, encodedSignature, ...extra] = token.split(".");
  if (
    !encodedPayload
    || !encodedSignature
    || extra.length > 0
    || token.length > 16_384
    || !isBase64Url(encodedPayload)
    || !isBase64Url(encodedSignature)
  ) {
    throw new WanghaiGatewayAuthError(invalidMessage);
  }

  let signature: Uint8Array;
  let payloadBytes: Uint8Array;
  try {
    signature = decodeBase64Url(encodedSignature);
    payloadBytes = decodeBase64Url(encodedPayload);
  } catch {
    throw new WanghaiGatewayAuthError(invalidMessage);
  }
  if (signature.byteLength !== 32) {
    throw new WanghaiGatewayAuthError(invalidMessage);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "HMAC" },
    key,
    signature as unknown as BufferSource,
    new TextEncoder().encode(encodedPayload),
  );
  if (!valid) throw new WanghaiGatewayAuthError(invalidMessage);

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch {
    throw new WanghaiGatewayAuthError(invalidMessage);
  }
}

function isStandaloneGatewayClaims(value: unknown): value is VerifiedStandaloneGatewayClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "v",
    "iss",
    "aud",
    "sub",
    "tenant_id",
    "vault_id",
    "role",
    "capabilities",
    "request_id",
    "request_method",
    "request_target",
    "iat",
    "exp",
    "admission",
  ]);
  if (Object.keys(claims).some((key) => !allowedKeys.has(key))) return false;
  const issuedAt = claims.iat;
  const expiresAt = claims.exp;
  const capabilities = claims.capabilities;
  const boundedString = (candidate: unknown, maxLength = 256): candidate is string =>
    typeof candidate === "string"
    && candidate.length > 0
    && candidate.length <= maxLength
    && !/[\u0000-\u001f\u007f]/u.test(candidate);
  return claims.v === 1
    && claims.iss === WANGHAI_STANDALONE_ISSUER
    && claims.aud === "wanghai"
    && boundedString(claims.sub)
    && boundedString(claims.tenant_id)
    && boundedString(claims.vault_id)
    && (claims.role === "viewer" || claims.role === "operator" || claims.role === "admin")
    && Array.isArray(capabilities)
    && capabilities.length > 0
    && capabilities.length <= 64
    && capabilities.every((capability) => isStandaloneCapability(capability))
    && new Set(capabilities).size === capabilities.length
    && boundedString(claims.request_id, 128)
    && typeof claims.request_method === "string"
    && /^[A-Z]{3,16}$/u.test(claims.request_method)
    && typeof claims.request_target === "string"
    && isStandaloneRequestTarget(claims.request_target)
    && typeof issuedAt === "number"
    && typeof expiresAt === "number"
    && Number.isSafeInteger(issuedAt)
    && Number.isSafeInteger(expiresAt)
    && expiresAt > issuedAt
    && (claims.admission === undefined || isMutationAdmission(claims.admission));
}

function isStandaloneCapability(value: unknown): value is string {
  return typeof value === "string"
    && /^[a-z][a-z0-9.-]{0,127}$/u.test(value);
}

function isStandaloneRequestTarget(value: string): boolean {
  return value.length > 0
    && value.length <= 4_096
    && value.startsWith("/")
    && !value.startsWith("//")
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function gatewayVerificationConfig(
  env: NodeJS.ProcessEnv = process.env,
): { secret: string; tenantId: string; vaultId: string } {
  const secret = String(env.WANGHAI_GATEWAY_ASSERTION_SECRET ?? "").trim();
  const tenantId = requiredGatewayConfigValue(env, "WANGHAI_GATEWAY_TENANT_ID");
  const vaultId = requiredGatewayConfigValue(env, "WANGHAI_GATEWAY_VAULT_ID");
  if (secret.length < 32) {
    throw new WanghaiGatewayAuthError(
      "Wanghai gateway verification requires a secret of at least 32 characters",
      503,
    );
  }
  return { secret, tenantId, vaultId };
}

function standaloneGatewayVerificationConfig(
  env: NodeJS.ProcessEnv = process.env,
): { secret: string; tenantId: string; vaultId: string } {
  const secret = String(env[WANGHAI_STANDALONE_IDENTITY_SECRET_ENV] ?? "").trim();
  const tenantId = requiredGatewayConfigValue(env, WANGHAI_STANDALONE_TENANT_ID_ENV);
  const vaultId = requiredGatewayConfigValue(env, WANGHAI_STANDALONE_VAULT_ID_ENV);
  requiredGatewayConfigValue(env, "WANGHAI_DATA_ROOT");
  if (secret.length < 32) {
    throw new WanghaiGatewayAuthError(
      "Standalone identity verification requires a secret of at least 32 characters",
      503,
    );
  }
  return { secret, tenantId, vaultId };
}

function requiredGatewayConfigValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = String(env[name] ?? "").trim();
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new WanghaiGatewayAuthError(
      "Wanghai gateway verification is not configured",
      503,
    );
  }
  return value;
}

function isGatewayClaims(value: unknown): value is VerifiedPolarisGatewayClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  const issuedAt = claims.iat;
  const expiresAt = claims.exp;
  const boundedString = (candidate: unknown, maxLength = 256): candidate is string =>
    typeof candidate === "string"
    && candidate.length > 0
    && candidate.length <= maxLength
    && !/[\u0000-\u001f\u007f]/u.test(candidate);
  return claims.v === 1
    && claims.iss === "polaris"
    && claims.aud === "wanghai"
    && boundedString(claims.sub)
    && boundedString(claims.tenant_id)
    && boundedString(claims.vault_id)
    && (claims.role === "viewer" || claims.role === "operator" || claims.role === "admin")
    && boundedString(claims.request_id, 128)
    && typeof issuedAt === "number"
    && typeof expiresAt === "number"
    && Number.isSafeInteger(issuedAt)
    && Number.isSafeInteger(expiresAt)
    && expiresAt > issuedAt
    && (claims.admission === undefined || isMutationAdmission(claims.admission))
    && (claims.quota_measurement === undefined || claims.quota_measurement === "active_workspace")
    && !(claims.admission !== undefined && claims.quota_measurement !== undefined);
}

function isMutationAdmission(value: unknown): value is VerifiedWanghaiMutationAdmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const admission = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "action",
    "action_version",
    "workspace_id",
    "idempotency_key",
    "request_hash",
    "expected_version",
    "quota_reservation_id",
  ]);
  if (Object.keys(admission).some((key) => !allowedKeys.has(key))) return false;
  const visibleAscii = (candidate: unknown, maxLength: number): candidate is string =>
    typeof candidate === "string"
    && candidate.length > 0
    && candidate.length <= maxLength
    && /^[\x21-\x7e]+$/u.test(candidate);
  const expectedVersion = admission.expected_version;
  const quotaReservationId = admission.quota_reservation_id;
  return admission.action_version === 1
    && typeof admission.action === "string"
    && /^[a-z][a-z0-9.-]{0,127}$/u.test(admission.action)
    && typeof admission.workspace_id === "string"
    && /^[a-z][a-z0-9-]{0,62}$/u.test(admission.workspace_id)
    && visibleAscii(admission.idempotency_key, 128)
    && typeof admission.request_hash === "string"
    && /^[0-9a-f]{64}$/u.test(admission.request_hash)
    && (expectedVersion === undefined
      || (typeof expectedVersion === "number"
        && Number.isSafeInteger(expectedVersion)
        && expectedVersion >= 0))
    && (quotaReservationId === undefined || visibleAscii(quotaReservationId, 128));
}

function normalizeFrameAncestorOrigin(value: string, envName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WanghaiGatewayAuthError(
      `${envName} must contain HTTP(S) origins only`,
      503,
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new WanghaiGatewayAuthError(
      `${envName} must contain HTTP(S) origins only`,
      503,
    );
  }
  return parsed.origin;
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/u.test(value);
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
