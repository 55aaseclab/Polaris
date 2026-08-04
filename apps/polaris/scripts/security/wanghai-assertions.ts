import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export const WANGHAI_ASSERTION_ISSUER = "polaris";
export const WANGHAI_ASSERTION_AUDIENCE = "wanghai";
export const WANGHAI_ASSERTION_VERSION = 1;

export type WanghaiGatewayRole = "viewer" | "operator" | "admin";

export interface WanghaiAssertionAdmission {
  action: string;
  actionVersion: 1;
  workspaceId: string;
  idempotencyKey: string;
  requestHash: string;
  expectedVersion?: number;
  quotaReservationId?: string;
}

export interface WanghaiAdmissionClaims {
  action: string;
  action_version: 1;
  workspace_id: string;
  idempotency_key: string;
  request_hash: string;
  expected_version?: number;
  quota_reservation_id?: string;
}

export interface WanghaiAssertionClaims {
  v: 1;
  iss: typeof WANGHAI_ASSERTION_ISSUER;
  aud: typeof WANGHAI_ASSERTION_AUDIENCE;
  sub: string;
  tenant_id: string;
  vault_id: string;
  role: WanghaiGatewayRole;
  request_id: string;
  iat: number;
  exp: number;
  admission?: WanghaiAdmissionClaims;
}

export interface WanghaiLaunchClaims {
  v: 1;
  kind: "launch" | "session";
  jti: string;
  server_id: string;
  user_id: string;
  tenant_id: string;
  vault_id: string;
  role: WanghaiGatewayRole;
  iat: number;
  exp: number;
}

export function requireWanghaiGatewayMasterSecret(env = process.env): string {
  const secret = String(env.POLARIS_WANGHAI_GATEWAY_MASTER_SECRET ?? "").trim();
  if (secret.length < 32) {
    throw new Error(
      "POLARIS_WANGHAI_GATEWAY_MASTER_SECRET must contain at least 32 characters",
    );
  }
  return secret;
}

export function deriveWanghaiVaultAssertionSecret(
  masterSecret: string,
  tenantId: string,
  vaultId: string,
): string {
  const tenant = requireNonEmpty(tenantId, "tenantId");
  const vault = requireNonEmpty(vaultId, "vaultId");
  return createHmac("sha256", masterSecret)
    .update(`polaris-wanghai-v1\0${tenant}\0${vault}`, "utf8")
    .digest("base64url");
}

export function issueWanghaiAssertion(input: {
  secret: string;
  userId: string;
  tenantId: string;
  vaultId: string;
  role: WanghaiGatewayRole;
  requestId?: string;
  admission?: WanghaiAssertionAdmission;
  nowSeconds?: number;
  ttlSeconds?: number;
}): string {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? 60;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttl) || ttl <= 0) {
    throw new Error("Assertion time values must be positive integers");
  }
  const claims: WanghaiAssertionClaims = {
    v: 1,
    iss: WANGHAI_ASSERTION_ISSUER,
    aud: WANGHAI_ASSERTION_AUDIENCE,
    sub: requireNonEmpty(input.userId, "userId"),
    tenant_id: requireNonEmpty(input.tenantId, "tenantId"),
    vault_id: requireNonEmpty(input.vaultId, "vaultId"),
    role: input.role,
    request_id: input.requestId?.trim() || randomUUID(),
    iat: now,
    exp: now + ttl,
    ...(input.admission ? { admission: normalizeAdmission(input.admission) } : {}),
  };
  return signPayload(claims, input.secret);
}

export function issueWanghaiLaunchTicket(input: {
  masterSecret: string;
  serverId: string;
  userId: string;
  tenantId: string;
  vaultId: string;
  role: WanghaiGatewayRole;
  nowSeconds?: number;
  ttlSeconds?: number;
}): string {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? 60;
  const claims: WanghaiLaunchClaims = {
    v: 1,
    kind: "launch",
    jti: randomUUID(),
    server_id: requireNonEmpty(input.serverId, "serverId"),
    user_id: requireNonEmpty(input.userId, "userId"),
    tenant_id: requireNonEmpty(input.tenantId, "tenantId"),
    vault_id: requireNonEmpty(input.vaultId, "vaultId"),
    role: input.role,
    iat: now,
    exp: now + ttl,
  };
  return signPayload(claims, input.masterSecret);
}

export function issueWanghaiSession(input: {
  masterSecret: string;
  launch: WanghaiLaunchClaims;
  nowSeconds?: number;
  ttlSeconds?: number;
}): string {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? 15 * 60;
  const claims: WanghaiLaunchClaims = {
    ...input.launch,
    kind: "session",
    iat: now,
    exp: now + ttl,
  };
  return signPayload(claims, input.masterSecret);
}

export function verifyWanghaiLaunchToken(
  token: string,
  masterSecret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): WanghaiLaunchClaims {
  const claims = verifyPayload<WanghaiLaunchClaims>(token, masterSecret);
  if (claims.v !== 1 || (claims.kind !== "launch" && claims.kind !== "session")) {
    throw new Error("Invalid Wanghai launch token version");
  }
  if (
    !isUuid(claims.jti)
    || !claims.server_id
    || !claims.user_id
    || !claims.tenant_id
    || !claims.vault_id
  ) {
    throw new Error("Wanghai launch token is missing scope claims");
  }
  if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.exp <= nowSeconds) {
    throw new Error("Wanghai launch token has expired");
  }
  if (claims.iat > nowSeconds + 30) {
    throw new Error("Wanghai launch token is not yet valid");
  }
  return claims;
}

export function verifyWanghaiAssertion(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): WanghaiAssertionClaims {
  const claims = verifyPayload<WanghaiAssertionClaims>(token, secret);
  if (
    claims.v !== WANGHAI_ASSERTION_VERSION
    || claims.iss !== WANGHAI_ASSERTION_ISSUER
    || claims.aud !== WANGHAI_ASSERTION_AUDIENCE
  ) {
    throw new Error("Invalid Wanghai assertion claims");
  }
  if (!claims.sub || !claims.tenant_id || !claims.vault_id || !claims.request_id) {
    throw new Error("Wanghai assertion is missing scope claims");
  }
  if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.exp <= nowSeconds) {
    throw new Error("Wanghai assertion has expired");
  }
  if (claims.iat > nowSeconds + 30) {
    throw new Error("Wanghai assertion is not yet valid");
  }
  if (claims.admission !== undefined) {
    normalizeAdmissionClaims(claims.admission);
  }
  return claims;
}

export function wanghaiGatewayHostLabel(serverId: string): string {
  const value = requireNonEmpty(serverId, "serverId");
  return `v-${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24)}`;
}

function signPayload(payload: object, secret: string): string {
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret)
    .update(encodedPayload, "utf8")
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function verifyPayload<T>(token: string, secret: string): T {
  const [encodedPayload, encodedSignature, ...extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra.length > 0 || token.length > 16_384) {
    throw new Error("Malformed Wanghai token");
  }
  const expected = createHmac("sha256", secret)
    .update(encodedPayload, "utf8")
    .digest();
  const received = decodeBase64Url(encodedSignature);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("Invalid Wanghai token signature");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url(encodedPayload).toString("utf8"));
  } catch {
    throw new Error("Malformed Wanghai token payload");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Malformed Wanghai token claims");
  }
  return parsed as T;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("Malformed Wanghai token encoding");
  }
  return Buffer.from(value, "base64url");
}

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function normalizeAdmission(input: WanghaiAssertionAdmission): WanghaiAdmissionClaims {
  const action = requireBoundedToken(input.action, "admission.action", /^[a-z][a-z0-9.-]{0,127}$/u);
  const workspaceId = requireBoundedToken(
    input.workspaceId,
    "admission.workspaceId",
    /^[a-z][a-z0-9-]{0,62}$/u,
  );
  const idempotencyKey = requireBoundedToken(
    input.idempotencyKey,
    "admission.idempotencyKey",
    /^[\x21-\x7e]{1,128}$/u,
  );
  const requestHash = requireBoundedToken(
    input.requestHash,
    "admission.requestHash",
    /^[0-9a-f]{64}$/u,
  );
  if (input.actionVersion !== 1) {
    throw new Error("admission.actionVersion must be 1");
  }
  const expectedVersion = input.expectedVersion;
  if (
    expectedVersion !== undefined
    && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
  ) {
    throw new Error("admission.expectedVersion must be a non-negative integer");
  }
  const quotaReservationId = input.quotaReservationId === undefined
    ? undefined
    : requireBoundedToken(
        input.quotaReservationId,
        "admission.quotaReservationId",
        /^[\x21-\x7e]{1,128}$/u,
      );
  return {
    action,
    action_version: 1,
    workspace_id: workspaceId,
    idempotency_key: idempotencyKey,
    request_hash: requestHash,
    ...(expectedVersion === undefined ? {} : { expected_version: expectedVersion }),
    ...(quotaReservationId === undefined ? {} : { quota_reservation_id: quotaReservationId }),
  };
}

function normalizeAdmissionClaims(value: unknown): WanghaiAdmissionClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Wanghai assertion admission is invalid");
  }
  const candidate = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "action",
    "action_version",
    "workspace_id",
    "idempotency_key",
    "request_hash",
    "expected_version",
    "quota_reservation_id",
  ]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    throw new Error("Wanghai assertion admission contains unsupported claims");
  }
  return normalizeAdmission({
    action: String(candidate.action ?? ""),
    actionVersion: candidate.action_version as 1,
    workspaceId: String(candidate.workspace_id ?? ""),
    idempotencyKey: String(candidate.idempotency_key ?? ""),
    requestHash: String(candidate.request_hash ?? ""),
    expectedVersion: candidate.expected_version as number | undefined,
    quotaReservationId: candidate.quota_reservation_id as string | undefined,
  });
}

function requireBoundedToken(value: string, name: string, pattern: RegExp): string {
  const normalized = String(value ?? "").trim();
  if (!pattern.test(normalized)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
