import { createHash } from "node:crypto";
import type { WanghaiAssertionAdmission } from "../security/wanghai-assertions.js";
import type {
  WanghaiMutationAction,
  WanghaiMutationMatch,
} from "./wanghai-mutation-catalog.js";

export const WANGHAI_IDEMPOTENCY_KEY_HEADER = "idempotency-key";
export const WANGHAI_EXPECTED_VERSION_HEADER = "x-polaris-expected-version";

export const DEFAULT_WANGHAI_MUTATION_JSON_BYTES = 1_048_576;
export const DEFAULT_WANGHAI_MUTATION_UPLOAD_BYTES = 25 * 1024 * 1024;

const WORKSPACE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class WanghaiMutationAdmissionError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 413 | 415 | 428,
  ) {
    super(message);
    this.name = "WanghaiMutationAdmissionError";
  }
}

export interface WanghaiMutationAdmission {
  action: WanghaiMutationAction;
  workspaceId: string;
  idempotencyKey: string;
  requestHash: string;
  idempotencyScope: string;
  expectedVersion?: number;
}

export function maxWanghaiMutationBodyBytes(
  action: WanghaiMutationAction,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = action.body === "multipart"
    ? env.POLARIS_WANGHAI_MAX_UPLOAD_BYTES
    : env.POLARIS_WANGHAI_MAX_JSON_BODY_BYTES;
  const fallback = action.body === "multipart"
    ? DEFAULT_WANGHAI_MUTATION_UPLOAD_BYTES
    : DEFAULT_WANGHAI_MUTATION_JSON_BYTES;
  const name = action.body === "multipart"
    ? "POLARIS_WANGHAI_MAX_UPLOAD_BYTES"
    : "POLARIS_WANGHAI_MAX_JSON_BODY_BYTES";
  return configuredBodyLimit(configured, name, fallback);
}

export function prepareWanghaiMutationAdmission(input: {
  match: WanghaiMutationMatch;
  body: Buffer;
  contentType?: string;
  idempotencyKey?: string;
  expectedVersion?: string;
  query?: Iterable<readonly [string, string]>;
  tenantId: string;
  vaultId: string;
  userId: string;
}): WanghaiMutationAdmission {
  const action = input.match.action;
  const key = normalizeIdempotencyKey(input.idempotencyKey);
  const bodyValue = normalizeMutationBody(action, input.body, input.contentType);
  const workspaceId = action.workspaceSource === "path"
    ? input.match.workspaceId
    : workspaceIdFromBody(bodyValue);
  if (!workspaceId || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new WanghaiMutationAdmissionError("Wanghai mutation workspace ID is invalid", 400);
  }
  const expectedVersion = normalizeExpectedVersion(input.expectedVersion);
  const requestHash = fingerprintWanghaiMutation({
    action,
    body: bodyValue,
    params: input.match.params,
    query: input.query,
  });
  return {
    action,
    workspaceId,
    idempotencyKey: key,
    requestHash,
    idempotencyScope: wanghaiMutationIdempotencyScope({
      tenantId: input.tenantId,
      vaultId: input.vaultId,
      userId: input.userId,
      actionId: action.id,
      workspaceId,
    }),
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  };
}

export function wanghaiAssertionAdmission(
  admission: WanghaiMutationAdmission,
): WanghaiAssertionAdmission {
  return {
    action: admission.action.id,
    actionVersion: admission.action.version,
    workspaceId: admission.workspaceId,
    idempotencyKey: admission.idempotencyKey,
    requestHash: admission.requestHash,
    ...(admission.expectedVersion === undefined
      ? {}
      : { expectedVersion: admission.expectedVersion }),
  };
}

function configuredBodyLimit(rawValue: string | undefined, name: string, fallback: number): number {
  const raw = String(rawValue ?? "").trim();
  if (!raw) return fallback;
  if (!/^\d+$/u.test(raw)) {
    throw new WanghaiMutationAdmissionError(`${name} must be a positive byte count`, 400);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 100 * 1024 * 1024) {
    throw new WanghaiMutationAdmissionError(`${name} must be between 1 and 104857600`, 400);
  }
  return value;
}

function normalizeIdempotencyKey(value: string | undefined): string {
  const key = String(value ?? "").trim();
  if (!key) {
    throw new WanghaiMutationAdmissionError(
      `Wanghai mutations require the ${WANGHAI_IDEMPOTENCY_KEY_HEADER} header`,
      428,
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new WanghaiMutationAdmissionError("Wanghai idempotency key is invalid", 400);
  }
  return key;
}

function normalizeExpectedVersion(value: string | undefined): number | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  if (!/^\d+$/u.test(raw)) {
    throw new WanghaiMutationAdmissionError("Wanghai expected version is invalid", 400);
  }
  const expectedVersion = Number(raw);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw new WanghaiMutationAdmissionError("Wanghai expected version is invalid", 400);
  }
  return expectedVersion;
}

function normalizeMutationBody(
  action: WanghaiMutationAction,
  body: Buffer,
  contentType: string | undefined,
): unknown {
  const normalizedContentType = String(contentType ?? "").split(";", 1)[0].trim().toLowerCase();
  if (action.body === "empty") {
    if (body.byteLength !== 0) {
      throw new WanghaiMutationAdmissionError("Wanghai mutation must not include a request body", 400);
    }
    return { kind: "empty" };
  }
  if (action.body === "multipart") {
    if (normalizedContentType !== "multipart/form-data") {
      throw new WanghaiMutationAdmissionError("Wanghai mutation requires a multipart form body", 415);
    }
    return {
      kind: "multipart",
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  }
  if (normalizedContentType !== "application/json") {
    throw new WanghaiMutationAdmissionError("Wanghai mutation requires an application/json body", 415);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new WanghaiMutationAdmissionError("Wanghai mutation body is not valid JSON", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WanghaiMutationAdmissionError("Wanghai mutation body must be a JSON object", 400);
  }
  return parsed;
}

function workspaceIdFromBody(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const workspaceId = (value as Record<string, unknown>).workspace_id;
  return typeof workspaceId === "string" ? workspaceId.trim() : undefined;
}

function fingerprintWanghaiMutation(input: {
  action: WanghaiMutationAction;
  body: unknown;
  params: Readonly<Record<string, string>>;
  query?: Iterable<readonly [string, string]>;
}): string {
  const params = Object.fromEntries(
    Object.entries(input.params).sort(([left], [right]) => left.localeCompare(right)),
  );
  const query = [...(input.query ?? [])]
    .map(([name, value]) => [String(name), String(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => (
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
    ));
  const material = canonicalJson({
    action: input.action.id,
    action_version: input.action.version,
    body: input.body,
    params,
    path_template: input.action.pathTemplate,
    query,
    version: 1,
  });
  return createHash("sha256").update(material, "utf8").digest("hex");
}

function wanghaiMutationIdempotencyScope(input: {
  tenantId: string;
  vaultId: string;
  userId: string;
  actionId: string;
  workspaceId: string;
}): string {
  const values = [
    "polaris-wanghai-mutation-v1",
    input.tenantId,
    input.vaultId,
    input.userId,
    input.actionId,
    input.workspaceId,
  ];
  if (values.some((value) => !String(value).trim())) {
    throw new WanghaiMutationAdmissionError("Wanghai mutation scope is invalid", 400);
  }
  return `v1-${createHash("sha256").update(values.join("\0"), "utf8").digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new WanghaiMutationAdmissionError("Wanghai mutation JSON contains an invalid number", 400);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )).join(",")}}`;
  }
  throw new WanghaiMutationAdmissionError("Wanghai mutation JSON contains an invalid value", 400);
}
