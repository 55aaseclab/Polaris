import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { polarisStateRoot } from "../utils/paths.js";

export type DurableJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface DurableJob {
  id: string;
  kind: string;
  dedupeKey: string;
  tenantId?: string;
  vaultId?: string;
  payload: Record<string, unknown>;
  status: DurableJobStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  cancelRequested: boolean;
  errorCode?: string;
  errorMessage?: string;
  result?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface DurableAuditEvent {
  id?: string;
  actorId?: string;
  tenantId?: string;
  vaultId?: string;
  action: string;
  requestId?: string;
  outcome: "success" | "failure" | "denied";
  metadata?: Record<string, unknown>;
}

export interface AuditChainVerification {
  valid: boolean;
  checked: number;
  failedEventId?: string;
  reason?: "previous-hash-mismatch" | "event-hash-mismatch";
}

export interface GatewayRateLimitInput {
  bucketKey: string;
  limit: number;
  windowSeconds?: number;
  nowSeconds?: number;
}

export interface GatewayRateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

export interface EnqueueJobInput {
  kind: string;
  dedupeKey: string;
  tenantId?: string;
  vaultId?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  availableAt?: number;
}

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WorkflowRunSource = "manual" | "provisioning" | "retry" | "suggestion";
export type WorkflowExecutionClass = "pure" | "workspace" | "ai";
export type WorkflowExecutionDriver = "none" | "vault";

export interface WorkflowSetupRecord {
  tenantId: string;
  completed: boolean;
  domainPackId: string | null;
  vaultId: string | null;
  enabledWorkflowKeys: string[];
  completedAt: string | null;
  updatedAt: string;
}

export interface WorkflowCapabilityLeaseRecord {
  id: string;
  tenantId: string;
  vaultId: string;
  packDigest: string;
  capabilities: string[];
  status: "active" | "expired" | "revoked";
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowEffectReceiptRecord {
  id: string;
  runId: string;
  tenantId: string;
  requestId: string;
  port: string;
  version: string;
  effect: string;
  status: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  completedAt: string;
}

export interface WorkflowArtifactRecord {
  id: string;
  runId: string;
  tenantId: string;
  name: string;
  kind: "report" | "data" | "log";
  size: string;
  summary: string;
  content: string;
  /** Internal host-owned source path; never included in the public projection. */
  sourcePath?: string;
  digest?: string;
  redacted: boolean;
  createdAt: string;
}

export interface WorkflowEventRecord {
  id: string;
  cursor: number;
  runId: string;
  tenantId: string;
  sequence: number;
  kind: string;
  title: string;
  detail: string;
  timestamp: string;
  tone: "neutral" | "accent" | "warning" | "success";
}

export interface WorkflowRunRecord {
  id: string;
  envelopeId: string;
  tenantId: string;
  vaultId: string;
  vaultName: string;
  packId: string;
  packVersion: string;
  packDigest: string;
  flowId: string;
  source: WorkflowRunSource;
  status: WorkflowRunStatus;
  priority: "urgent" | "normal" | "low";
  input: Record<string, string>;
  progress: number;
  approvalRequired: boolean;
  executionClass: WorkflowExecutionClass;
  executionDriver: WorkflowExecutionDriver;
  scenario: string;
  capabilityLeaseId: string;
  capabilityLeaseExpiresAt: string;
  policy: Record<string, unknown>;
  output: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  workerOwner?: string;
  workerExpiresAt?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  events: WorkflowEventRecord[];
  receipts: WorkflowEffectReceiptRecord[];
  artifacts: WorkflowArtifactRecord[];
}

export interface CreateWorkflowRunInput {
  id?: string;
  envelopeId?: string;
  tenantId: string;
  vaultId: string;
  vaultName: string;
  packId: string;
  packVersion: string;
  packDigest: string;
  flowId: string;
  source: WorkflowRunSource;
  priority?: "urgent" | "normal" | "low";
  input: Record<string, string>;
  approvalRequired: boolean;
  executionClass: WorkflowExecutionClass;
  executionDriver?: WorkflowExecutionDriver;
  scenario?: string;
  capabilityLease: {
    id?: string;
    capabilities: string[];
    expiresAt: string;
  };
  policy?: Record<string, unknown>;
  dedupeKey: string;
  event: Omit<WorkflowEventRecord, "id" | "cursor" | "runId" | "tenantId" | "sequence" | "timestamp"> & { timestamp?: string };
}

export interface WorkflowSuggestionRecord {
  id: string;
  tenantId: string;
  sourceRunId: string;
  packId: string;
  flowId: string;
  status: "suggested" | "accepted" | "dismissed";
  draft: Record<string, unknown>;
  evidence: string[];
  createdAt: string;
  updatedAt: string;
}

export interface IdempotencyResponse {
  statusCode: number;
  contentType: string;
  body: Buffer;
}

export interface IdempotencyResponseRecord {
  status: "started" | "completed" | "failed";
  response?: IdempotencyResponse;
}

export const QUOTA_CATEGORIES = [
  "active_workspace",
  "cache",
  "runtime_state",
  "identity_state",
] as const;

export type QuotaCategory = (typeof QUOTA_CATEGORIES)[number];
export type QuotaReservationStatus = "active" | "reconciled" | "released" | "expired";

export interface QuotaUsageRecord {
  tenantId: string;
  vaultId: string;
  category: QuotaCategory;
  usageBytes: number;
  measuredAt: number;
}

export interface QuotaReservation {
  id: string;
  tenantId: string;
  vaultId: string;
  category: QuotaCategory;
  action: string;
  idempotencyScope: string;
  idempotencyKey: string;
  limitBytes: number;
  baselineUsageBytes: number;
  reservedBytes: number;
  status: QuotaReservationStatus;
  expiresAt: number;
  actualUsageBytes?: number;
  createdAt: string;
  updatedAt: string;
  reconciledAt?: string;
}

export interface ReserveQuotaInput {
  tenantId: string;
  vaultId: string;
  category: QuotaCategory;
  action: string;
  idempotencyScope: string;
  idempotencyKey: string;
  limitBytes: number;
  measuredUsageBytes: number;
  reservedBytes: number;
  leaseMs?: number;
  nowMs?: number;
}

export interface QuotaReservationAttempt {
  allowed: boolean;
  usageBytes: number;
  reservedBytes: number;
  remainingBytes: number;
  reservation?: QuotaReservation;
}

type SqlRow = Record<string, unknown>;

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_ERROR_BYTES = 4 * 1024;
const CANCELLED_JOB_ERROR_CODE = "durable-job-cancelled";
const CANCELLED_JOB_ERROR_MESSAGE = "durable job cancelled";
const DEFAULT_GATEWAY_RATE_WINDOW_SECONDS = 60;
const MAX_RATE_LIMIT_BUCKET_KEY_BYTES = 128;
const MAX_IDEMPOTENCY_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_QUOTA_RESERVATION_LEASE_MS = 120_000;
const MAX_QUOTA_RESERVATION_LEASE_MS = 5 * 60_000;
const MAX_QUOTA_SCOPE_BYTES = 256;
const MAX_QUOTA_ACTION_BYTES = 128;

function nowIso(): string {
  return new Date().toISOString();
}

function nowIsoAt(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function boundedText(value: unknown, maxBytes: number): string | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  return Buffer.byteLength(text, "utf8") <= maxBytes
    ? text
    : `${Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8")}…`;
}

function boundedJson(value: Record<string, unknown> | undefined): string {
  const encoded = JSON.stringify(value ?? {});
  if (Buffer.byteLength(encoded, "utf8") > MAX_METADATA_BYTES) {
    throw new Error("Durable metadata exceeds the 16 KiB limit");
  }
  return encoded;
}

function normalizeClaimJobKinds(kinds: readonly string[] | undefined): string[] | undefined {
  if (kinds === undefined) return undefined;
  const normalized = [...new Set(kinds.map((kind) => String(kind ?? "").trim()))];
  if (normalized.some((kind) => !kind || Buffer.byteLength(kind, "utf8") > 128 || /[\u0000-\u001f\u007f]/u.test(kind))) {
    throw new Error("Durable job claim kinds are invalid");
  }
  return normalized;
}

function asOptionalString(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function auditEventHash(input: {
  id: string;
  actorId?: string;
  tenantId?: string;
  vaultId?: string;
  action: string;
  requestId?: string;
  outcome: string;
  metadataJson: string;
  previousHash: string;
  occurredAt: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    id: input.id,
    actorId: input.actorId ?? null,
    tenantId: input.tenantId ?? null,
    vaultId: input.vaultId ?? null,
    action: input.action,
    requestId: input.requestId ?? null,
    outcome: input.outcome,
    metadataJson: input.metadataJson,
    previousHash: input.previousHash,
    occurredAt: input.occurredAt,
  })).digest("hex");
}

function parsePayload(value: unknown): Record<string, unknown> {
  return parseOptionalPayload(value) ?? {};
}

function parseOptionalPayload(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function rowToJob(row: SqlRow): DurableJob {
  return {
    id: String(row.id),
    kind: String(row.kind),
    dedupeKey: String(row.dedupe_key),
    tenantId: asOptionalString(row.tenant_id),
    vaultId: asOptionalString(row.vault_id),
    payload: parsePayload(row.payload_json),
    status: String(row.status) as DurableJobStatus,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: Number(row.available_at),
    leaseOwner: asOptionalString(row.lease_owner),
    leaseExpiresAt: row.lease_expires_at == null ? undefined : Number(row.lease_expires_at),
    cancelRequested: Number(row.cancel_requested ?? 0) === 1,
    errorCode: asOptionalString(row.error_code),
    errorMessage: asOptionalString(row.error_message),
    result: parseOptionalPayload(row.result_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: asOptionalString(row.completed_at),
  };
}

function parseStringArray(value: unknown): string[] {
  const parsed = parseOptionalPayload(value);
  if (Array.isArray(parsed)) return parsed.map((item) => String(item));
  try {
    const raw = JSON.parse(String(value ?? "[]"));
    return Array.isArray(raw) ? raw.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function parseRecord(value: unknown): Record<string, unknown> {
  return parsePayload(value);
}

function rowToWorkflowSetup(row: SqlRow): WorkflowSetupRecord {
  return {
    tenantId: String(row.tenant_id),
    completed: Number(row.completed ?? 0) === 1,
    domainPackId: asOptionalString(row.domain_pack_id) ?? null,
    vaultId: asOptionalString(row.vault_id) ?? null,
    enabledWorkflowKeys: parseStringArray(row.enabled_workflow_keys_json),
    completedAt: asOptionalString(row.completed_at) ?? null,
    updatedAt: String(row.updated_at),
  };
}

function rowToWorkflowLease(row: SqlRow): WorkflowCapabilityLeaseRecord {
  const status = String(row.status);
  if (status !== "active" && status !== "expired" && status !== "revoked") {
    throw new Error("Workflow capability lease has an invalid status");
  }
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    vaultId: String(row.vault_id),
    packDigest: String(row.pack_digest),
    capabilities: parseStringArray(row.capabilities_json),
    status,
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToWorkflowEvent(row: SqlRow): WorkflowEventRecord {
  const tone = String(row.tone);
  if (tone !== "neutral" && tone !== "accent" && tone !== "warning" && tone !== "success") {
    throw new Error("Workflow event has an invalid tone");
  }
  return {
    id: String(row.id),
    cursor: Number(row.cursor),
    runId: String(row.run_id),
    tenantId: String(row.tenant_id),
    sequence: Number(row.sequence),
    kind: String(row.kind),
    title: String(row.title),
    detail: String(row.detail),
    timestamp: String(row.timestamp),
    tone,
  };
}

function rowToWorkflowReceipt(row: SqlRow): WorkflowEffectReceiptRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    tenantId: String(row.tenant_id),
    requestId: String(row.request_id),
    port: String(row.port),
    version: String(row.version),
    effect: String(row.effect),
    status: String(row.status),
    input: parseRecord(row.input_json),
    output: parseRecord(row.output_json),
    errorCode: asOptionalString(row.error_code),
    errorMessage: asOptionalString(row.error_message),
    createdAt: String(row.created_at),
    completedAt: String(row.completed_at),
  };
}

function rowToWorkflowArtifact(row: SqlRow): WorkflowArtifactRecord {
  const kind = String(row.kind);
  if (kind !== "report" && kind !== "data" && kind !== "log") {
    throw new Error("Workflow artifact has an invalid kind");
  }
  return {
    id: String(row.id),
    runId: String(row.run_id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    kind,
    size: String(row.size),
    summary: String(row.summary),
    content: String(row.content),
    ...(row.source_path ? { sourcePath: String(row.source_path) } : {}),
    digest: asOptionalString(row.digest),
    redacted: Number(row.redacted ?? 0) === 1,
    createdAt: String(row.created_at),
  };
}

function rowToWorkflowRun(
  row: SqlRow,
  events: WorkflowEventRecord[],
  receipts: WorkflowEffectReceiptRecord[],
  artifacts: WorkflowArtifactRecord[],
): WorkflowRunRecord {
  const status = String(row.status);
  const source = String(row.source);
  const priority = String(row.priority);
  const executionClass = String(row.execution_class);
  const executionDriver = String(row.execution_driver ?? "vault");
  if (!['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'].includes(status)) {
    throw new Error('Workflow run has an invalid status');
  }
  if (!['manual', 'provisioning', 'retry', 'suggestion'].includes(source)) {
    throw new Error('Workflow run has an invalid source');
  }
  if (!['urgent', 'normal', 'low'].includes(priority)) {
    throw new Error('Workflow run has an invalid priority');
  }
  if (!['pure', 'workspace', 'ai'].includes(executionClass)) {
    throw new Error('Workflow run has an invalid execution class');
  }
  if (!['none', 'vault'].includes(executionDriver)) {
    throw new Error('Workflow run has an invalid execution driver');
  }
  return {
    id: String(row.id),
    envelopeId: String(row.envelope_id),
    tenantId: String(row.tenant_id),
    vaultId: String(row.vault_id),
    vaultName: String(row.vault_name),
    packId: String(row.pack_id),
    packVersion: String(row.pack_version),
    packDigest: String(row.pack_digest),
    flowId: String(row.flow_id),
    source: source as WorkflowRunSource,
    status: status as WorkflowRunStatus,
    priority: priority as WorkflowRunRecord['priority'],
    input: Object.fromEntries(
      Object.entries(parseRecord(row.input_json)).map(([key, value]) => [key, String(value ?? '')]),
    ),
    progress: Number(row.progress),
    approvalRequired: Number(row.approval_required ?? 0) === 1,
    executionClass: executionClass as WorkflowExecutionClass,
    executionDriver: executionDriver as WorkflowExecutionDriver,
    scenario: String(row.scenario),
    capabilityLeaseId: String(row.capability_lease_id),
    capabilityLeaseExpiresAt: String(row.capability_lease_expires_at),
    policy: parseRecord(row.policy_json),
    output: parseRecord(row.output_json),
    errorCode: asOptionalString(row.error_code),
    errorMessage: asOptionalString(row.error_message),
    workerOwner: asOptionalString(row.worker_owner),
    workerExpiresAt: row.worker_expires_at == null ? undefined : Number(row.worker_expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: asOptionalString(row.completed_at),
    events,
    receipts,
    artifacts,
  };
}

function rowToQuotaReservation(row: SqlRow): QuotaReservation {
  const status = String(row.status);
  if (
    status !== "active"
    && status !== "reconciled"
    && status !== "released"
    && status !== "expired"
  ) {
    throw new Error("Quota reservation has an invalid status");
  }
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    vaultId: String(row.vault_id),
    category: normalizeQuotaCategory(row.category),
    action: String(row.action),
    idempotencyScope: String(row.idempotency_scope),
    idempotencyKey: String(row.idempotency_key),
    limitBytes: normalizeQuotaBytes(row.limit_bytes, "Quota reservation limit"),
    baselineUsageBytes: normalizeQuotaBytes(
      row.baseline_usage_bytes,
      "Quota reservation baseline usage",
    ),
    reservedBytes: normalizeQuotaBytes(row.reserved_bytes, "Quota reservation bytes"),
    status,
    expiresAt: normalizeQuotaTimestamp(row.expires_at, "Quota reservation expiry"),
    actualUsageBytes: row.actual_usage_bytes == null
      ? undefined
      : normalizeQuotaBytes(row.actual_usage_bytes, "Quota reservation actual usage"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    reconciledAt: asOptionalString(row.reconciled_at),
  };
}

function normalizeQuotaCategory(value: unknown): QuotaCategory {
  if (!QUOTA_CATEGORIES.includes(value as QuotaCategory)) {
    throw new Error("Quota category is invalid");
  }
  return value as QuotaCategory;
}

function normalizeQuotaScopeValue(value: unknown, name: string, maxBytes: number): string {
  const normalized = String(value ?? "").trim();
  if (
    !normalized
    || Buffer.byteLength(normalized, "utf8") > maxBytes
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function normalizeQuotaBytes(value: unknown, name: string): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return numeric;
}

function normalizeQuotaTimestamp(value: unknown, name: string): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return numeric;
}

function normalizeQuotaNow(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error("Quota reservation time is invalid");
  }
  return numeric;
}

function controlStoreFile(importMetaUrl: string): string {
  const configured = process.env.POLARIS_CONTROL_STORE_PATH?.trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(process.cwd(), configured);
  }
  if (process.env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), `polaris-control-${process.pid}.sqlite`);
  }
  return path.join(polarisStateRoot(importMetaUrl), "control.sqlite");
}

function ensureParent(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

function ensureJobCancellationColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(jobs)").all() as SqlRow[];
  if (columns.some((column) => String(column.name) === "cancel_requested")) {
    return;
  }
  db.exec("ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0");
}

function ensureJobResultColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(jobs)").all() as SqlRow[];
  if (columns.some((column) => String(column.name) === "result_json")) {
    return;
  }
  db.exec("ALTER TABLE jobs ADD COLUMN result_json TEXT");
}

function ensureIdempotencyResponseColumns(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(idempotency_keys)").all() as SqlRow[];
  const names = new Set(columns.map((column) => String(column.name)));
  if (!names.has("result_status")) {
    db.exec("ALTER TABLE idempotency_keys ADD COLUMN result_status INTEGER");
  }
  if (!names.has("result_content_type")) {
    db.exec("ALTER TABLE idempotency_keys ADD COLUMN result_content_type TEXT");
  }
  if (!names.has("result_body")) {
    db.exec("ALTER TABLE idempotency_keys ADD COLUMN result_body BLOB");
  }
}

function ensureWorkflowRunColumns(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(workflow_runs)").all() as SqlRow[];
  if (columns.length > 0 && !columns.some((column) => String(column.name) === "execution_driver")) {
    db.exec("ALTER TABLE workflow_runs ADD COLUMN execution_driver TEXT NOT NULL DEFAULT 'vault'");
  }
  if (columns.length > 0 && !columns.some((column) => String(column.name) === "available_at")) {
    db.exec("ALTER TABLE workflow_runs ADD COLUMN available_at INTEGER NOT NULL DEFAULT 0");
  }
}

function ensureWorkflowArtifactColumns(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(workflow_artifacts)").all() as SqlRow[];
  if (columns.length > 0 && !columns.some((column) => String(column.name) === "source_path")) {
    db.exec("ALTER TABLE workflow_artifacts ADD COLUMN source_path TEXT");
  }
}

/**
 * Durable control-plane state for one Polaris installation.
 *
 * The database must live on a durable local/shared volume. SQLite is suitable
 * for the single-host deployment target; a multi-host deployment must replace
 * this adapter with a network transactional database before adding replicas.
 */
export class PolarisControlStore {
  private constructor(
    readonly filePath: string,
    private readonly db: DatabaseSync,
  ) {}

  static open(filePath: string): PolarisControlStore {
    ensureParent(filePath);
    const db = new DatabaseSync(filePath);
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;

      CREATE TABLE IF NOT EXISTS gateway_ticket_redemptions (
        ticket_id TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        redeemed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gateway_rate_limit_buckets (
        bucket_key TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL CHECK (count >= 0),
        PRIMARY KEY (bucket_key, window_start)
      );

      CREATE INDEX IF NOT EXISTS idx_gateway_rate_limit_window
        ON gateway_rate_limit_buckets(window_start);

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        tenant_id TEXT,
        vault_id TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        available_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_claim
        ON jobs(status, available_at, lease_expires_at, created_at);

      CREATE TABLE IF NOT EXISTS workflow_setups (
        tenant_id TEXT PRIMARY KEY,
        completed INTEGER NOT NULL DEFAULT 0,
        domain_pack_id TEXT,
        vault_id TEXT,
        enabled_workflow_keys_json TEXT NOT NULL DEFAULT '[]',
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_envelopes (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_capability_leases (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        vault_id TEXT NOT NULL,
        pack_digest TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'revoked')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES workflow_envelopes(run_id)
      );

      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        envelope_id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        vault_id TEXT NOT NULL,
        vault_name TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        pack_version TEXT NOT NULL,
        pack_digest TEXT NOT NULL,
        flow_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('manual', 'provisioning', 'retry', 'suggestion')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
        priority TEXT NOT NULL CHECK (priority IN ('urgent', 'normal', 'low')),
          input_json TEXT NOT NULL,
          progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
          approval_required INTEGER NOT NULL DEFAULT 0,
          execution_class TEXT NOT NULL CHECK (execution_class IN ('pure', 'workspace', 'ai')),
          execution_driver TEXT NOT NULL DEFAULT 'vault' CHECK (execution_driver IN ('none', 'vault')),
          scenario TEXT NOT NULL DEFAULT 'normal',
        capability_lease_id TEXT NOT NULL,
        capability_lease_expires_at TEXT NOT NULL,
        policy_json TEXT NOT NULL DEFAULT '{}',
        output_json TEXT NOT NULL DEFAULT '{}',
        error_code TEXT,
        error_message TEXT,
        worker_owner TEXT,
        worker_expires_at INTEGER,
        available_at INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (envelope_id) REFERENCES workflow_envelopes(id),
        FOREIGN KEY (capability_lease_id) REFERENCES workflow_capability_leases(id)
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_runs_claim
        ON workflow_runs(status, worker_expires_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_scope
        ON workflow_runs(tenant_id, updated_at, created_at);

      CREATE TABLE IF NOT EXISTS workflow_events (
        id TEXT NOT NULL UNIQUE,
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        tone TEXT NOT NULL CHECK (tone IN ('neutral', 'accent', 'warning', 'success')),
        UNIQUE(run_id, sequence),
        FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_events_replay
        ON workflow_events(tenant_id, cursor);

      CREATE TABLE IF NOT EXISTS workflow_outbox (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'delivered')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_outbox_claim
        ON workflow_outbox(status, available_at, created_at);

      CREATE TABLE IF NOT EXISTS workflow_effect_receipts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        request_id TEXT NOT NULL UNIQUE,
        port TEXT NOT NULL,
        version TEXT NOT NULL,
        effect TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
      );

      CREATE TABLE IF NOT EXISTS workflow_artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('report', 'data', 'log')),
        size TEXT NOT NULL,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        source_path TEXT,
        digest TEXT,
        redacted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
      );

      CREATE TABLE IF NOT EXISTS workflow_suggestions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        flow_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('suggested', 'accepted', 'dismissed')),
        draft_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (source_run_id) REFERENCES workflow_runs(id)
      );

      CREATE TABLE IF NOT EXISTS wanghai_restore_activation_state (
        tenant_id TEXT NOT NULL,
        vault_id TEXT NOT NULL,
        activation_job_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, vault_id),
        FOREIGN KEY (activation_job_id) REFERENCES jobs(id)
      );

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
        result_json TEXT,
        result_status INTEGER,
        result_content_type TEXT,
        result_body BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(scope, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS workspace_locks (
        tenant_id TEXT NOT NULL,
        vault_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(tenant_id, vault_id, workspace_id)
      );

      CREATE TABLE IF NOT EXISTS quota_usage (
        tenant_id TEXT NOT NULL,
        vault_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN (
          'active_workspace', 'cache', 'runtime_state', 'identity_state'
        )),
        usage_bytes INTEGER NOT NULL CHECK (usage_bytes >= 0),
        measured_at INTEGER NOT NULL CHECK (measured_at >= 0),
        PRIMARY KEY(tenant_id, vault_id, category)
      );

      CREATE TABLE IF NOT EXISTS quota_reservations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        vault_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN (
          'active_workspace', 'cache', 'runtime_state', 'identity_state'
        )),
        action TEXT NOT NULL,
        idempotency_scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        limit_bytes INTEGER NOT NULL CHECK (limit_bytes >= 0),
        baseline_usage_bytes INTEGER NOT NULL CHECK (baseline_usage_bytes >= 0),
        reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
        status TEXT NOT NULL CHECK (status IN (
          'active', 'reconciled', 'released', 'expired'
        )),
        expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
        actual_usage_bytes INTEGER CHECK (actual_usage_bytes >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        reconciled_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_quota_reservations_active
        ON quota_reservations(tenant_id, vault_id, category, status, expires_at);

      CREATE INDEX IF NOT EXISTS idx_quota_reservations_idempotency
        ON quota_reservations(idempotency_scope, idempotency_key, category);

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        actor_id TEXT,
        tenant_id TEXT,
        vault_id TEXT,
        action TEXT NOT NULL,
        request_id TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
        metadata_json TEXT NOT NULL,
        previous_hash TEXT,
        event_hash TEXT NOT NULL UNIQUE,
        occurred_at TEXT NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS audit_events_immutable_update
      BEFORE UPDATE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit events are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS audit_events_immutable_delete
      BEFORE DELETE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit events are immutable');
      END;
    `);
    ensureJobCancellationColumn(db);
    ensureJobResultColumn(db);
    ensureIdempotencyResponseColumns(db);
    ensureWorkflowRunColumns(db);
    ensureWorkflowArtifactColumns(db);
    fs.chmodSync(filePath, 0o600);
    return new PolarisControlStore(filePath, db);
  }

  static openFor(importMetaUrl: string): PolarisControlStore {
    return PolarisControlStore.open(controlStoreFile(importMetaUrl));
  }

  close(): void {
    this.db.close();
  }

  getWorkflowSetup(tenantId: string): WorkflowSetupRecord | null {
    const tenant = tenantId.trim();
    if (!tenant) throw new Error("A workflow setup tenant ID is required");
    const row = this.db.prepare(
      "SELECT * FROM workflow_setups WHERE tenant_id = ?",
    ).get(tenant) as SqlRow | undefined;
    return row ? rowToWorkflowSetup(row) : null;
  }

  saveWorkflowSetup(input: {
    tenantId: string;
    completed: boolean;
    domainPackId?: string | null;
    vaultId?: string | null;
    enabledWorkflowKeys: string[];
    completedAt?: string | null;
  }): WorkflowSetupRecord {
    const tenantId = input.tenantId.trim();
    const domainPackId = input.domainPackId?.trim() || null;
    const vaultId = input.vaultId?.trim() || null;
    const enabledWorkflowKeys = [...new Set(input.enabledWorkflowKeys.map((key) => key.trim()).filter(Boolean))];
    if (!tenantId || enabledWorkflowKeys.length > 512) {
      throw new Error("Workflow setup is invalid");
    }
    const encodedKeys = boundedJson(enabledWorkflowKeys as unknown as Record<string, unknown>);
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO workflow_setups (
        tenant_id, completed, domain_pack_id, vault_id,
        enabled_workflow_keys_json, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        completed = excluded.completed,
        domain_pack_id = excluded.domain_pack_id,
        vault_id = excluded.vault_id,
        enabled_workflow_keys_json = excluded.enabled_workflow_keys_json,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at
    `).run(
      tenantId,
      input.completed ? 1 : 0,
      domainPackId,
      vaultId,
      encodedKeys,
      input.completedAt?.trim() || (input.completed ? now : null),
      now,
    );
    const row = this.db.prepare(
      "SELECT * FROM workflow_setups WHERE tenant_id = ?",
    ).get(tenantId) as SqlRow | undefined;
    if (!row) throw new Error("Workflow setup disappeared after save");
    return rowToWorkflowSetup(row);
  }

  createWorkflowRun(input: CreateWorkflowRunInput): WorkflowRunRecord {
    const tenantId = input.tenantId.trim();
    const vaultId = input.vaultId.trim();
    const dedupeKey = input.dedupeKey.trim();
    const runId = input.id?.trim() || `run-${randomUUID()}`;
    const envelopeId = input.envelopeId?.trim() || `envelope-${randomUUID()}`;
    const leaseId = input.capabilityLease.id?.trim() || `lease-${randomUUID()}`;
    const now = nowIso();
    if (!tenantId || !vaultId || !dedupeKey || !input.packId.trim() || !input.flowId.trim()) {
      throw new Error("Workflow run identity is incomplete");
    }
    const payload = boundedJson({
      packId: input.packId,
      packVersion: input.packVersion,
      packDigest: input.packDigest,
      flowId: input.flowId,
      vaultId,
      source: input.source,
    });
    const inputJson = boundedJson(input.input as unknown as Record<string, unknown>);
    const policyJson = boundedJson(input.policy);
    const capabilitiesJson = boundedJson(input.capabilityLease.capabilities as unknown as Record<string, unknown>);
    let created = false;
    this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT id FROM workflow_envelopes WHERE dedupe_key = ?
      `).get(dedupeKey) as SqlRow | undefined;
      if (existing) return;

      this.db.prepare(`
        INSERT INTO workflow_envelopes
          (id, tenant_id, run_id, kind, dedupe_key, payload_json, created_at)
        VALUES (?, ?, ?, 'workflow-run', ?, ?, ?)
      `).run(envelopeId, tenantId, runId, dedupeKey, payload, now);
      this.db.prepare(`
        INSERT INTO workflow_capability_leases
          (id, run_id, tenant_id, vault_id, pack_digest, capabilities_json,
           status, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(
        leaseId,
        runId,
        tenantId,
        vaultId,
        input.packDigest,
        capabilitiesJson,
        input.capabilityLease.expiresAt,
        now,
        now,
      );
      this.db.prepare(`
        INSERT INTO workflow_runs (
          id, envelope_id, tenant_id, vault_id, vault_name, pack_id,
          pack_version, pack_digest, flow_id, source, status, priority,
          input_json, progress, approval_required, execution_class, execution_driver, scenario,
          capability_lease_id, capability_lease_expires_at, policy_json,
          output_json, available_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)
      `).run(
        runId,
        envelopeId,
        tenantId,
        vaultId,
        input.vaultName,
        input.packId,
        input.packVersion,
        input.packDigest,
        input.flowId,
        input.source,
        input.priority ?? "normal",
        inputJson,
        input.approvalRequired ? 1 : 0,
        input.executionClass,
        input.executionDriver ?? "vault",
        input.scenario ?? "normal",
        leaseId,
        input.capabilityLease.expiresAt,
        policyJson,
        Date.now(),
        now,
        now,
      );
      this.appendWorkflowEventWithinTransaction({
        runId,
        tenantId,
        event: input.event,
        timestamp: input.event.timestamp ?? now,
      });
      created = true;
    });
    const run = this.getWorkflowRun(tenantId, created ? runId : this.workflowRunIdForDedupe(dedupeKey));
    if (!run) throw new Error("Workflow run disappeared after create");
    return run;
  }

  private workflowRunIdForDedupe(dedupeKey: string): string {
    const row = this.db.prepare(`
      SELECT run_id FROM workflow_envelopes WHERE dedupe_key = ?
    `).get(dedupeKey) as SqlRow | undefined;
    if (!row) throw new Error("Workflow run dedupe record disappeared");
    return String(row.run_id);
  }

  claimWorkflowRun(workerId: string, leaseMs = 60_000): WorkflowRunRecord | null {
    const owner = workerId.trim();
    if (!owner) throw new Error("A workflow worker ID is required");
    const now = Date.now();
    let claimedId: string | null = null;
    this.transaction(() => {
      this.db.prepare(`
        UPDATE workflow_runs
        SET status = 'queued', worker_owner = NULL, worker_expires_at = NULL,
            updated_at = ?
        WHERE status = 'running' AND worker_expires_at IS NOT NULL
          AND worker_expires_at <= ?
      `).run(nowIso(), now);
      const row = this.db.prepare(`
        SELECT id FROM workflow_runs
        WHERE (status = 'queued' OR (status = 'running' AND worker_owner IS NULL))
          AND available_at <= ?
        ORDER BY created_at ASC
        LIMIT 1
      `).get(now) as SqlRow | undefined;
      if (!row) return;
      claimedId = String(row.id);
      this.db.prepare(`
        UPDATE workflow_runs
        SET status = 'running', worker_owner = ?, worker_expires_at = ?,
            updated_at = ?
        WHERE id = ? AND (status = 'queued' OR (status = 'running' AND worker_owner IS NULL))
      `).run(owner, now + Math.max(1_000, leaseMs), nowIso(), claimedId);
    });
    return claimedId ? this.getWorkflowRunById(claimedId) : null;
  }

  heartbeatWorkflowRun(runId: string, workerId: string, leaseMs = 60_000): boolean {
    const result = this.db.prepare(`
      UPDATE workflow_runs
      SET worker_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND worker_owner = ?
        AND worker_expires_at > ?
    `).run(Date.now() + Math.max(1_000, leaseMs), nowIso(), runId, workerId, Date.now());
    return result.changes === 1;
  }

  getWorkflowRun(tenantId: string, runId: string): WorkflowRunRecord | null {
    const tenant = tenantId.trim();
    const id = runId.trim();
    if (!tenant || !id) return null;
    const row = this.db.prepare(`
      SELECT * FROM workflow_runs WHERE tenant_id = ? AND id = ?
    `).get(tenant, id) as SqlRow | undefined;
    return row ? this.readWorkflowRun(row) : null;
  }

  private getWorkflowRunById(runId: string): WorkflowRunRecord | null {
    const row = this.db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(runId) as SqlRow | undefined;
    return row ? this.readWorkflowRun(row) : null;
  }

  private readWorkflowRun(row: SqlRow): WorkflowRunRecord {
    const runId = String(row.id);
    const events = (this.db.prepare(`
      SELECT * FROM workflow_events WHERE run_id = ? ORDER BY sequence DESC
    `).all(runId) as SqlRow[]).map(rowToWorkflowEvent);
    const receipts = (this.db.prepare(`
      SELECT * FROM workflow_effect_receipts WHERE run_id = ? ORDER BY created_at ASC
    `).all(runId) as SqlRow[]).map(rowToWorkflowReceipt);
    const artifacts = (this.db.prepare(`
      SELECT * FROM workflow_artifacts WHERE run_id = ? ORDER BY created_at ASC
    `).all(runId) as SqlRow[]).map(rowToWorkflowArtifact);
    return rowToWorkflowRun(row, events, receipts, artifacts);
  }

  listWorkflowRuns(tenantId: string): WorkflowRunRecord[] {
    const tenant = tenantId.trim();
    if (!tenant) throw new Error("A workflow run tenant ID is required");
    const rows = this.db.prepare(`
      SELECT * FROM workflow_runs WHERE tenant_id = ?
      ORDER BY updated_at DESC, created_at DESC
    `).all(tenant) as SqlRow[];
    return rows.map((row) => this.readWorkflowRun(row));
  }

  listWorkflowEvents(tenantId: string, runId: string, after = 0): { events: WorkflowEventRecord[]; nextCursor: number } {
    const tenant = tenantId.trim();
    const id = runId.trim();
    const cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    if (!tenant || !id) throw new Error("A workflow event scope is required");
    const events = (this.db.prepare(`
      SELECT * FROM workflow_events
      WHERE tenant_id = ? AND run_id = ? AND cursor > ?
      ORDER BY cursor ASC
    `).all(tenant, id, cursor) as SqlRow[]).map(rowToWorkflowEvent);
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(cursor), 0) AS cursor
      FROM workflow_events WHERE tenant_id = ?
    `).get(tenant) as SqlRow | undefined;
    return { events, nextCursor: Number(row?.cursor ?? 0) };
  }

  updateWorkflowRun(input: {
    tenantId: string;
    runId: string;
    status: WorkflowRunStatus;
    progress: number;
    event: Omit<WorkflowEventRecord, "id" | "cursor" | "runId" | "tenantId" | "sequence" | "timestamp"> & { timestamp?: string };
    workerId?: string;
    output?: Record<string, unknown>;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): WorkflowRunRecord {
    const tenant = input.tenantId.trim();
    const runId = input.runId.trim();
    const progress = Math.max(0, Math.min(100, Math.floor(input.progress)));
    const now = nowIso();
    let updated = false;
    this.transaction(() => {
      const row = this.db.prepare(`
        SELECT status, worker_owner FROM workflow_runs WHERE tenant_id = ? AND id = ?
      `).get(tenant, runId) as SqlRow | undefined;
      if (!row) throw new Error("Workflow run not found");
      if (input.workerId && String(row.worker_owner ?? "") !== input.workerId) {
        throw new Error("Workflow worker lease is not held");
      }
      const terminal = input.status === "succeeded" || input.status === "failed" || input.status === "cancelled";
      const result = this.db.prepare(`
        UPDATE workflow_runs
        SET status = ?, progress = ?, output_json = COALESCE(?, output_json),
            error_code = ?, error_message = ?,
            worker_owner = CASE WHEN ? THEN NULL ELSE worker_owner END,
            worker_expires_at = CASE WHEN ? THEN NULL ELSE worker_expires_at END,
            updated_at = ?, completed_at = CASE WHEN ? THEN ? ELSE completed_at END
        WHERE tenant_id = ? AND id = ?
      `).run(
        input.status,
        progress,
        input.output === undefined ? null : boundedJson(input.output),
        input.errorCode?.trim() || null,
        input.errorMessage?.trim() || null,
        terminal || input.status === "waiting" ? 1 : 0,
        terminal || input.status === "waiting" ? 1 : 0,
        now,
        terminal ? 1 : 0,
        terminal ? now : null,
        tenant,
        runId,
      );
      if (result.changes !== 1) throw new Error("Workflow run update did not apply");
      this.appendWorkflowEventWithinTransaction({
        runId,
        tenantId: tenant,
        event: input.event,
        timestamp: input.event.timestamp ?? now,
      });
      updated = true;
    });
    if (!updated) throw new Error("Workflow run update did not complete");
    const run = this.getWorkflowRun(tenant, runId);
    if (!run) throw new Error("Workflow run disappeared after update");
    return run;
  }

  requestWorkflowCancellation(tenantId: string, runId: string): WorkflowRunRecord | null {
    const tenant = tenantId.trim();
    const id = runId.trim();
    const now = nowIso();
    let changed = false;
    this.transaction(() => {
      const row = this.db.prepare(`
        SELECT status FROM workflow_runs WHERE tenant_id = ? AND id = ?
      `).get(tenant, id) as SqlRow | undefined;
      if (!row || !['queued', 'running', 'waiting'].includes(String(row.status))) return;
      const result = this.db.prepare(`
        UPDATE workflow_runs
        SET status = 'cancelled', progress = CASE WHEN progress < 100 THEN progress ELSE 100 END,
            worker_owner = NULL, worker_expires_at = NULL,
            error_code = 'workflow-cancelled', error_message = 'workflow cancelled by user',
            updated_at = ?, completed_at = ?
        WHERE tenant_id = ? AND id = ?
      `).run(now, now, tenant, id);
      if (result.changes !== 1) return;
      this.appendWorkflowEventWithinTransaction({
        runId: id,
        tenantId: tenant,
        event: {
          kind: 'cancelled',
          title: '运行已取消',
          detail: '没有新的执行动作会被提交。',
          tone: 'warning',
        },
        timestamp: now,
      });
      changed = true;
    });
    return changed ? this.getWorkflowRun(tenant, id) : null;
  }

  getWorkflowCapabilityLease(tenantId: string, leaseId: string): WorkflowCapabilityLeaseRecord | null {
    const tenant = tenantId.trim();
    const id = leaseId.trim();
    if (!tenant || !id) return null;
    const now = Date.now();
    this.db.prepare(`
      UPDATE workflow_capability_leases
      SET status = 'expired', updated_at = ?
      WHERE tenant_id = ? AND id = ? AND status = 'active' AND expires_at <= ?
    `).run(nowIso(), tenant, id, new Date(now).toISOString());
    const row = this.db.prepare(`
      SELECT * FROM workflow_capability_leases WHERE tenant_id = ? AND id = ?
    `).get(tenant, id) as SqlRow | undefined;
    return row ? rowToWorkflowLease(row) : null;
  }

  revokeWorkflowCapabilityLease(tenantId: string, leaseId: string): boolean {
    const result = this.db.prepare(`
      UPDATE workflow_capability_leases
      SET status = 'revoked', updated_at = ?
      WHERE tenant_id = ? AND id = ? AND status = 'active'
    `).run(nowIso(), tenantId.trim(), leaseId.trim());
    return result.changes === 1;
  }

  recordWorkflowEffectReceipt(receipt: WorkflowEffectReceiptRecord): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO workflow_effect_receipts (
        id, run_id, tenant_id, request_id, port, version, effect, status,
        input_json, output_json, error_code, error_message, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.id,
      receipt.runId,
      receipt.tenantId,
      receipt.requestId,
      receipt.port,
      receipt.version,
      receipt.effect,
      receipt.status,
      boundedJson(receipt.input),
      boundedJson(receipt.output),
      receipt.errorCode ?? null,
      receipt.errorMessage ?? null,
      receipt.createdAt,
      receipt.completedAt,
    );
  }

  addWorkflowArtifact(artifact: WorkflowArtifactRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO workflow_artifacts (
        id, run_id, tenant_id, name, kind, size, summary, content, source_path,
        digest, redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifact.id,
      artifact.runId,
      artifact.tenantId,
      artifact.name,
      artifact.kind,
      artifact.size,
      artifact.summary,
      artifact.content,
      artifact.sourcePath ?? null,
      artifact.digest ?? null,
      artifact.redacted ? 1 : 0,
      artifact.createdAt,
    );
  }

  createWorkflowSuggestion(input: Omit<WorkflowSuggestionRecord, "id" | "createdAt" | "updatedAt">): WorkflowSuggestionRecord {
    const id = `suggestion-${randomUUID()}`;
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO workflow_suggestions (
        id, tenant_id, source_run_id, pack_id, flow_id, status,
        draft_json, evidence_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.tenantId,
      input.sourceRunId,
      input.packId,
      input.flowId,
      input.status,
      boundedJson(input.draft),
      boundedJson(input.evidence as unknown as Record<string, unknown>),
      now,
      now,
    );
    return { ...input, id, createdAt: now, updatedAt: now };
  }

  listWorkflowSuggestions(tenantId: string): WorkflowSuggestionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM workflow_suggestions WHERE tenant_id = ?
      ORDER BY updated_at DESC
    `).all(tenantId.trim()) as SqlRow[];
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      sourceRunId: String(row.source_run_id),
      packId: String(row.pack_id),
      flowId: String(row.flow_id),
      status: String(row.status) as WorkflowSuggestionRecord['status'],
      draft: parseRecord(row.draft_json),
      evidence: parseStringArray(row.evidence_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  private appendWorkflowEventWithinTransaction(input: {
    runId: string;
    tenantId: string;
    event: Omit<WorkflowEventRecord, "id" | "cursor" | "runId" | "tenantId" | "sequence" | "timestamp">;
    timestamp: string;
  }): WorkflowEventRecord {
    const previous = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM workflow_events WHERE run_id = ?
    `).get(input.runId) as SqlRow | undefined;
    const sequence = Number(previous?.sequence ?? 0) + 1;
    const id = `workflow-event-${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO workflow_events (
        id, run_id, tenant_id, sequence, kind, title, detail, timestamp, tone
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.runId,
      input.tenantId,
      sequence,
      input.event.kind,
      input.event.title,
      input.event.detail,
      input.timestamp,
      input.event.tone,
    );
    const row = this.db.prepare(`
      SELECT * FROM workflow_events WHERE id = ?
    `).get(id) as SqlRow | undefined;
    if (!row) throw new Error("Workflow event disappeared after append");
    const event = rowToWorkflowEvent(row);
    this.db.prepare(`
      INSERT INTO workflow_outbox (
        id, event_id, tenant_id, topic, payload_json, status, available_at, created_at
      ) VALUES (?, ?, ?, 'workflow.event', ?, 'queued', ?, ?)
    `).run(
      `outbox-${randomUUID()}`,
      event.id,
      input.tenantId,
      boundedJson(event as unknown as Record<string, unknown>),
      Date.now(),
      input.timestamp,
    );
    return event;
  }

  redeemGatewayTicket(ticketId: string, expiresAt: number, now = Math.floor(Date.now() / 1000)): boolean {
    const normalized = ticketId.trim();
    if (!normalized || !Number.isInteger(expiresAt) || expiresAt <= now) {
      return false;
    }
    let redeemed = false;
    this.transaction(() => {
      this.db.prepare("DELETE FROM gateway_ticket_redemptions WHERE expires_at <= ?").run(now);
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO gateway_ticket_redemptions
          (ticket_id, expires_at, redeemed_at)
        VALUES (?, ?, ?)
      `).run(normalized, expiresAt, now);
      redeemed = result.changes === 1;
    });
    return redeemed;
  }

  consumeGatewayRateLimit(input: GatewayRateLimitInput): GatewayRateLimitResult {
    const bucketKey = input.bucketKey.trim();
    const limit = Math.floor(input.limit);
    const windowSeconds = Math.floor(input.windowSeconds ?? DEFAULT_GATEWAY_RATE_WINDOW_SECONDS);
    const nowSeconds = Math.floor(input.nowSeconds ?? Date.now() / 1000);
    if (
      !bucketKey
      || Buffer.byteLength(bucketKey, "utf8") > MAX_RATE_LIMIT_BUCKET_KEY_BYTES
      || !Number.isSafeInteger(limit)
      || limit <= 0
      || !Number.isSafeInteger(windowSeconds)
      || windowSeconds <= 0
      || !Number.isSafeInteger(nowSeconds)
      || nowSeconds < 0
    ) {
      throw new Error("Invalid gateway rate-limit bucket configuration");
    }

    const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
    const resetAt = windowStart + windowSeconds;
    let count = 0;
    let allowed = false;
    this.transaction(() => {
      this.db.prepare(
        "DELETE FROM gateway_rate_limit_buckets WHERE window_start < ?",
      ).run(windowStart - windowSeconds * 2);
      const existing = this.db.prepare(`
        SELECT count FROM gateway_rate_limit_buckets
        WHERE bucket_key = ? AND window_start = ?
      `).get(bucketKey, windowStart) as SqlRow | undefined;
      if (!existing) {
        count = 1;
        allowed = true;
        this.db.prepare(`
          INSERT INTO gateway_rate_limit_buckets (bucket_key, window_start, count)
          VALUES (?, ?, ?)
        `).run(bucketKey, windowStart, count);
        return;
      }
      count = Number(existing.count);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error("Gateway rate-limit bucket count is invalid");
      }
      if (count >= limit) return;
      count += 1;
      allowed = true;
      this.db.prepare(`
        UPDATE gateway_rate_limit_buckets SET count = ?
        WHERE bucket_key = ? AND window_start = ?
      `).run(count, bucketKey, windowStart);
    });
    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt,
    };
  }

  enqueueJob(input: EnqueueJobInput): DurableJob {
    const kind = input.kind.trim();
    const dedupeKey = input.dedupeKey.trim();
    if (!kind || !dedupeKey) throw new Error("A durable job kind and dedupe key are required");
    const payload = boundedJson(input.payload);
    const now = nowIso();
    const maxAttempts = Math.max(1, Math.min(10, Math.floor(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)));
    const availableAt = Number.isFinite(input.availableAt) ? Math.floor(input.availableAt as number) : Date.now();
    this.transaction(() => {
      const existing = this.db.prepare("SELECT id, status, attempts, max_attempts, cancel_requested FROM jobs WHERE dedupe_key = ?").get(dedupeKey) as SqlRow | undefined;
      if (existing) {
        if (
          existing.status === "failed"
          && Number(existing.cancel_requested ?? 0) === 0
          && Number(existing.attempts) < Number(existing.max_attempts)
        ) {
          this.db.prepare(`
            UPDATE jobs
            SET status = 'queued', available_at = ?, lease_owner = NULL,
                lease_expires_at = NULL, cancel_requested = 0,
                error_code = NULL, error_message = NULL,
                updated_at = ?, completed_at = NULL
            WHERE dedupe_key = ?
          `).run(availableAt, now, dedupeKey);
        }
        return;
      }
      this.db.prepare(`
        INSERT INTO jobs (
          id, kind, dedupe_key, tenant_id, vault_id, payload_json, status,
          attempts, max_attempts, available_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
      `).run(
        randomUUID(), kind, dedupeKey, input.tenantId?.trim() || null,
        input.vaultId?.trim() || null, payload, maxAttempts, availableAt, now, now,
      );
    });
    const row = this.db.prepare("SELECT * FROM jobs WHERE dedupe_key = ?").get(dedupeKey) as SqlRow | undefined;
    if (!row) throw new Error("Durable job disappeared after enqueue");
    return rowToJob(row);
  }

  claimNextJob(
    workerId: string,
    leaseMs = 60_000,
    allowedKinds?: readonly string[],
  ): DurableJob | null {
    const owner = workerId.trim();
    if (!owner) throw new Error("A durable job worker ID is required");
    const kinds = normalizeClaimJobKinds(allowedKinds);
    const kindFilter = kinds === undefined
      ? ""
      : kinds.length === 0
        ? " AND 1 = 0"
        : ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
    const now = Date.now();
    let claimedId: string | null = null;
    this.transaction(() => {
      this.db.prepare(`
      UPDATE jobs
        SET status = CASE
              WHEN cancel_requested = 1 OR attempts >= max_attempts THEN 'failed'
              ELSE 'queued'
            END,
            lease_owner = NULL, lease_expires_at = NULL,
            error_code = CASE
              WHEN cancel_requested = 1 THEN '${CANCELLED_JOB_ERROR_CODE}'
              WHEN attempts >= max_attempts THEN COALESCE(error_code, 'job-lease-expired')
              ELSE error_code
            END,
            error_message = CASE
              WHEN cancel_requested = 1 THEN '${CANCELLED_JOB_ERROR_MESSAGE}'
              WHEN attempts >= max_attempts THEN COALESCE(error_message, 'durable job lease expired')
              ELSE error_message
            END,
            completed_at = CASE
              WHEN cancel_requested = 1 OR attempts >= max_attempts THEN COALESCE(completed_at, ?)
              ELSE completed_at
            END,
            updated_at = ?
        WHERE status = 'running' AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?
          ${kindFilter}
      `).run(nowIso(), nowIso(), now, ...(kinds ?? []));
      const row = this.db.prepare(`
        SELECT id FROM jobs
        WHERE status = 'queued' AND cancel_requested = 0 AND available_at <= ?
          ${kindFilter}
        ORDER BY created_at ASC
        LIMIT 1
      `).get(now, ...(kinds ?? [])) as SqlRow | undefined;
      if (!row) return;
      claimedId = String(row.id);
      this.db.prepare(`
        UPDATE jobs
        SET status = 'running', attempts = attempts + 1, lease_owner = ?,
            lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(owner, now + Math.max(1_000, leaseMs), nowIso(), claimedId);
    });
    if (!claimedId) return null;
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(claimedId) as SqlRow | undefined;
    return row ? rowToJob(row) : null;
  }

  heartbeatJob(jobId: string, workerId: string, leaseMs = 60_000): boolean {
    const result = this.db.prepare(`
      UPDATE jobs
      SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
        AND cancel_requested = 0
        AND lease_expires_at > ?
    `).run(Date.now() + Math.max(1_000, leaseMs), nowIso(), jobId, workerId, Date.now());
    return result.changes === 1;
  }

  completeJob(
    jobId: string,
    workerId: string,
    resultPayload?: Record<string, unknown>,
  ): boolean {
    const resultJson = resultPayload === undefined ? null : boundedJson(resultPayload);
    const now = nowIso();
    const result = this.db.prepare(`
      UPDATE jobs
      SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
          updated_at = ?, completed_at = ?, error_code = NULL, error_message = NULL,
          result_json = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
        AND cancel_requested = 0
        AND lease_expires_at > ?
    `).run(now, now, resultJson, jobId, workerId, Date.now());
    return result.changes === 1;
  }

  completeWanghaiRestoreActivation(input: {
    jobId: string;
    workerId: string;
    tenantId: string;
    vaultId: string;
    result: Record<string, unknown>;
  }): boolean {
    const tenantId = input.tenantId.trim();
    const vaultId = input.vaultId.trim();
    if (!tenantId || !vaultId) {
      throw new Error("Wanghai restore activation tenant and vault IDs are required");
    }
    const resultJson = boundedJson(input.result);
    const now = nowIso();
    let completed = false;
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE jobs
        SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
            updated_at = ?, completed_at = ?, error_code = NULL, error_message = NULL,
            result_json = ?
        WHERE id = ? AND kind = 'wanghai-restore-activation'
          AND tenant_id = ? AND vault_id = ?
          AND status = 'running' AND lease_owner = ?
          AND cancel_requested = 0 AND lease_expires_at > ?
      `).run(
        now,
        now,
        resultJson,
        input.jobId,
        tenantId,
        vaultId,
        input.workerId,
        Date.now(),
      );
      if (result.changes !== 1) return;
      this.db.prepare(`
        INSERT INTO wanghai_restore_activation_state
          (tenant_id, vault_id, activation_job_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(tenant_id, vault_id) DO UPDATE SET
          activation_job_id = excluded.activation_job_id,
          updated_at = excluded.updated_at
      `).run(tenantId, vaultId, input.jobId, now);
      completed = true;
    });
    return completed;
  }

  isWanghaiRestoreActivationCurrent(input: {
    tenantId: string;
    vaultId: string;
    activationJobId: string;
  }): boolean {
    const tenantId = input.tenantId.trim();
    const vaultId = input.vaultId.trim();
    const activationJobId = input.activationJobId.trim();
    if (!tenantId || !vaultId || !activationJobId) return false;
    const row = this.db.prepare(`
      SELECT activation_job_id FROM wanghai_restore_activation_state
      WHERE tenant_id = ? AND vault_id = ?
    `).get(tenantId, vaultId) as SqlRow | undefined;
    return String(row?.activation_job_id ?? "") === activationJobId;
  }

  completeWanghaiRestoreRollback(input: {
    jobId: string;
    workerId: string;
    tenantId: string;
    vaultId: string;
    activationJobId: string;
    result: Record<string, unknown>;
  }): boolean {
    const tenantId = input.tenantId.trim();
    const vaultId = input.vaultId.trim();
    const activationJobId = input.activationJobId.trim();
    if (!tenantId || !vaultId || !activationJobId) {
      throw new Error("Wanghai restore rollback identity is required");
    }
    const resultJson = boundedJson(input.result);
    const now = nowIso();
    let completed = false;
    this.transaction(() => {
      const current = this.db.prepare(`
        SELECT activation_job_id FROM wanghai_restore_activation_state
        WHERE tenant_id = ? AND vault_id = ?
      `).get(tenantId, vaultId) as SqlRow | undefined;
      if (String(current?.activation_job_id ?? "") !== activationJobId) return;
      const result = this.db.prepare(`
        UPDATE jobs
        SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
            updated_at = ?, completed_at = ?, error_code = NULL, error_message = NULL,
            result_json = ?
        WHERE id = ? AND kind = 'wanghai-restore-rollback'
          AND tenant_id = ? AND vault_id = ?
          AND status = 'running' AND lease_owner = ?
          AND cancel_requested = 0 AND lease_expires_at > ?
      `).run(
        now,
        now,
        resultJson,
        input.jobId,
        tenantId,
        vaultId,
        input.workerId,
        Date.now(),
      );
      if (result.changes !== 1) return;
      const cleared = this.db.prepare(`
        DELETE FROM wanghai_restore_activation_state
        WHERE tenant_id = ? AND vault_id = ? AND activation_job_id = ?
      `).run(tenantId, vaultId, activationJobId);
      if (cleared.changes !== 1) {
        throw new Error("Wanghai restore activation state changed during rollback completion");
      }
      completed = true;
    });
    return completed;
  }

  failJob(jobId: string, workerId: string, errorCode: string, errorMessage: string, retryDelayMs = 1_000): DurableJob | null {
    const boundedError = boundedText(errorMessage, MAX_ERROR_BYTES) ?? "durable job failed";
    const now = nowIso();
    this.transaction(() => {
      this.db.prepare(`
      UPDATE jobs
      SET status = CASE
              WHEN cancel_requested = 1 THEN 'failed'
              WHEN attempts < max_attempts THEN 'queued'
              ELSE 'failed'
            END,
            available_at = ?, lease_owner = NULL, lease_expires_at = NULL,
            error_code = CASE
              WHEN cancel_requested = 1 THEN '${CANCELLED_JOB_ERROR_CODE}'
              ELSE ?
            END,
            error_message = CASE
              WHEN cancel_requested = 1 THEN '${CANCELLED_JOB_ERROR_MESSAGE}'
              ELSE ?
            END,
            updated_at = ?,
            completed_at = CASE
              WHEN cancel_requested = 1 OR attempts >= max_attempts THEN ?
              ELSE NULL
            END
        WHERE id = ? AND status = 'running' AND lease_owner = ?
          AND lease_expires_at > ?
      `).run(
        Date.now() + Math.max(0, retryDelayMs),
        boundedText(errorCode, 256) ?? null,
        boundedError,
        now,
        now,
        jobId,
        workerId,
        Date.now(),
      );
    });
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as SqlRow | undefined;
    return row ? rowToJob(row) : null;
  }

  getJob(jobId: string): DurableJob | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as SqlRow | undefined;
    return row ? rowToJob(row) : null;
  }

  getJobByDedupeKey(dedupeKey: string): DurableJob | null {
    const key = dedupeKey.trim();
    if (!key) throw new Error("A durable job dedupe key is required");
    const row = this.db.prepare("SELECT * FROM jobs WHERE dedupe_key = ?").get(key) as SqlRow | undefined;
    return row ? rowToJob(row) : null;
  }

  deleteTerminalProvisionJob(tenantId: string, vaultId: string): boolean {
    const tenant = tenantId.trim();
    const vault = vaultId.trim();
    if (!tenant || !vault) {
      throw new Error("A durable provision tenant and vault are required");
    }
    const result = this.db.prepare(`
      DELETE FROM jobs
      WHERE kind = 'vault-provision'
        AND tenant_id = ?
        AND vault_id = ?
        AND status IN ('succeeded', 'failed')
    `).run(tenant, vault);
    return result.changes === 1;
  }

  failJobPermanently(
    jobId: string,
    workerId: string,
    errorCode: string,
    errorMessage: string,
  ): DurableJob | null {
    const boundedError = boundedText(errorMessage, MAX_ERROR_BYTES) ?? "durable job failed";
    const now = nowIso();
    this.db.prepare(`
      UPDATE jobs
      SET status = 'failed', available_at = ?, lease_owner = NULL,
          lease_expires_at = NULL,
          error_code = CASE
            WHEN cancel_requested = 1 THEN '${CANCELLED_JOB_ERROR_CODE}'
            ELSE ?
          END,
          error_message = CASE
            WHEN cancel_requested = 1 THEN '${CANCELLED_JOB_ERROR_MESSAGE}'
            ELSE ?
          END,
          updated_at = ?, completed_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
        AND lease_expires_at > ?
    `).run(
      Date.now(),
      boundedText(errorCode, 256) ?? null,
      boundedError,
      now,
      now,
      jobId,
      workerId,
      Date.now(),
    );
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as SqlRow | undefined;
    return row ? rowToJob(row) : null;
  }

  requestJobCancellation(dedupeKey: string): boolean {
    const key = dedupeKey.trim();
    if (!key) throw new Error("A durable job dedupe key is required");
    const now = nowIso();
    let changed = false;
    this.transaction(() => {
      const row = this.db.prepare(`
        SELECT status FROM jobs WHERE dedupe_key = ?
      `).get(key) as SqlRow | undefined;
      if (!row) return;
      const status = String(row.status);
      if (status !== "queued" && status !== "running") return;
      if (status === "queued") {
        const result = this.db.prepare(`
          UPDATE jobs
          SET status = 'failed', cancel_requested = 1, lease_owner = NULL,
              lease_expires_at = NULL, error_code = ?,
              error_message = ?, updated_at = ?,
              completed_at = ?
          WHERE dedupe_key = ? AND status = 'queued'
        `).run(CANCELLED_JOB_ERROR_CODE, CANCELLED_JOB_ERROR_MESSAGE, now, now, key);
        changed = result.changes === 1;
        return;
      }
      const result = this.db.prepare(`
        UPDATE jobs
        SET cancel_requested = 1, updated_at = ?
        WHERE dedupe_key = ? AND status = 'running'
      `).run(now, key);
      changed = result.changes === 1;
    });
    return changed;
  }

  isJobCancellationRequested(jobId: string): boolean {
    const row = this.db.prepare(`
      SELECT cancel_requested FROM jobs WHERE id = ?
    `).get(jobId) as SqlRow | undefined;
    return Number(row?.cancel_requested ?? 0) === 1;
  }

  listPendingJobs(): DurableJob[] {
    const rows = this.db.prepare(`
      SELECT * FROM jobs
      WHERE status IN ('queued', 'running')
      ORDER BY created_at ASC
    `).all() as SqlRow[];
    return rows.map(rowToJob);
  }

  listPendingJobsForTenant(tenantId: string): DurableJob[] {
    const normalized = tenantId.trim();
    if (!normalized) throw new Error("A durable job tenant ID is required");
    const rows = this.db.prepare(`
      SELECT * FROM jobs
      WHERE tenant_id = ? AND status IN ('queued', 'running')
      ORDER BY created_at ASC
    `).all(normalized) as SqlRow[];
    return rows.map(rowToJob);
  }

  listPendingJobsForVault(tenantId: string, vaultId: string): DurableJob[] {
    const tenant = tenantId.trim();
    const vault = vaultId.trim();
    if (!tenant || !vault) {
      throw new Error("A durable job tenant and vault ID are required");
    }
    const rows = this.db.prepare(`
      SELECT * FROM jobs
      WHERE tenant_id = ? AND vault_id = ? AND status IN ('queued', 'running')
      ORDER BY created_at ASC
    `).all(tenant, vault) as SqlRow[];
    return rows.map(rowToJob);
  }

  beginIdempotency(scope: string, key: string, request: unknown): "started" | "existing" {
    const requestHash = createHash("sha256").update(JSON.stringify(request ?? null)).digest("hex");
    return this.beginIdempotencyFingerprint(scope, key, requestHash);
  }

  beginIdempotencyFingerprint(
    scope: string,
    key: string,
    requestHash: string,
  ): "started" | "existing" {
    const normalizedScope = scope.trim();
    const normalizedKey = key.trim();
    if (!normalizedScope || !normalizedKey || !/^[0-9a-f]{64}$/u.test(requestHash)) {
      throw new Error("Idempotency scope, key, and request fingerprint are required");
    }
    const now = nowIso();
    let started = false;
    this.transaction(() => {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO idempotency_keys
          (scope, idempotency_key, request_hash, status, created_at, updated_at)
        VALUES (?, ?, ?, 'started', ?, ?)
      `).run(normalizedScope, normalizedKey, requestHash, now, now);
      started = result.changes === 1;
      if (!started) {
        const row = this.db.prepare(`
          SELECT request_hash FROM idempotency_keys
          WHERE scope = ? AND idempotency_key = ?
        `).get(normalizedScope, normalizedKey) as SqlRow | undefined;
        if (row?.request_hash !== requestHash) {
          throw new Error("Idempotency key was reused with a different request");
        }
      }
    });
    return started ? "started" : "existing";
  }

  completeIdempotency(scope: string, key: string, result: unknown): void {
    const encoded = boundedJson(result && typeof result === "object" ? result as Record<string, unknown> : { value: result });
    const updated = this.db.prepare(`
      UPDATE idempotency_keys
      SET status = 'completed', result_json = ?, result_status = NULL,
          result_content_type = NULL, result_body = NULL, updated_at = ?
      WHERE scope = ? AND idempotency_key = ?
    `).run(encoded, nowIso(), scope.trim(), key.trim());
    if (updated.changes !== 1) throw new Error("Unknown idempotency key");
  }

  readIdempotency(scope: string, key: string): { status: string; result?: Record<string, unknown> } | null {
    const row = this.db.prepare(`
      SELECT status, result_json FROM idempotency_keys
      WHERE scope = ? AND idempotency_key = ?
    `).get(scope.trim(), key.trim()) as SqlRow | undefined;
    if (!row) return null;
    return {
      status: String(row.status),
      result: row.result_json ? parsePayload(row.result_json) : undefined,
    };
  }

  completeIdempotencyResponse(
    scope: string,
    key: string,
    response: IdempotencyResponse,
  ): void {
    this.writeIdempotencyResponse(scope, key, "completed", response);
  }

  failIdempotencyResponse(
    scope: string,
    key: string,
    response: IdempotencyResponse,
  ): void {
    this.writeIdempotencyResponse(scope, key, "failed", response);
  }

  readIdempotencyResponse(scope: string, key: string): IdempotencyResponseRecord | null {
    const row = this.db.prepare(`
      SELECT status, result_status, result_content_type, result_body
      FROM idempotency_keys
      WHERE scope = ? AND idempotency_key = ?
    `).get(scope.trim(), key.trim()) as SqlRow | undefined;
    if (!row) return null;
    const status = String(row.status);
    if (status !== "started" && status !== "completed" && status !== "failed") {
      throw new Error("Idempotency record has an invalid status");
    }
    const statusCode = Number(row.result_status);
    const contentType = asOptionalString(row.result_content_type);
    if (!Number.isInteger(statusCode) || !contentType || row.result_body === null || row.result_body === undefined) {
      return { status };
    }
    const body = Buffer.from(row.result_body as Uint8Array);
    if (body.byteLength > MAX_IDEMPOTENCY_RESPONSE_BYTES) {
      throw new Error("Idempotency response exceeds the configured limit");
    }
    return { status, response: { statusCode, contentType, body } };
  }

  acquireWorkspaceLock(input: {
    tenantId: string;
    vaultId: string;
    workspaceId: string;
    owner: string;
    leaseMs?: number;
  }): boolean {
    const now = Date.now();
    const leaseExpiresAt = now + Math.max(1_000, input.leaseMs ?? 60_000);
    const result = this.db.prepare(`
      INSERT INTO workspace_locks
        (tenant_id, vault_id, workspace_id, owner, lease_expires_at, version)
      VALUES (?, ?, ?, ?, ?, 0)
      ON CONFLICT(tenant_id, vault_id, workspace_id) DO UPDATE SET
        owner = excluded.owner,
        lease_expires_at = excluded.lease_expires_at,
        version = workspace_locks.version + 1
      WHERE workspace_locks.lease_expires_at <= ? OR workspace_locks.owner = excluded.owner
    `).run(
      input.tenantId, input.vaultId, input.workspaceId, input.owner,
      leaseExpiresAt, now,
    );
    return result.changes === 1;
  }

  heartbeatWorkspaceLock(input: {
    tenantId: string;
    vaultId: string;
    workspaceId: string;
    owner: string;
    leaseMs?: number;
  }): boolean {
    const now = Date.now();
    const leaseExpiresAt = now + Math.max(1_000, input.leaseMs ?? 60_000);
    const result = this.db.prepare(`
      UPDATE workspace_locks
      SET lease_expires_at = ?
      WHERE tenant_id = ? AND vault_id = ? AND workspace_id = ? AND owner = ?
        AND lease_expires_at > ?
    `).run(
      leaseExpiresAt,
      input.tenantId,
      input.vaultId,
      input.workspaceId,
      input.owner,
      now,
    );
    return result.changes === 1;
  }

  releaseWorkspaceLock(tenantId: string, vaultId: string, workspaceId: string, owner: string): boolean {
    const result = this.db.prepare(`
      DELETE FROM workspace_locks
      WHERE tenant_id = ? AND vault_id = ? AND workspace_id = ? AND owner = ?
    `).run(tenantId, vaultId, workspaceId, owner);
    return result.changes === 1;
  }

  /**
   * Atomically reserves bounded logical storage against the latest observed
   * tenant/vault usage. Measurements can only raise the pre-write baseline;
   * a post-write reconciliation is the authoritative path for decreases.
   */
  reserveQuota(input: ReserveQuotaInput): QuotaReservationAttempt {
    const tenantId = normalizeQuotaScopeValue(
      input.tenantId,
      "Quota tenant ID",
      MAX_QUOTA_SCOPE_BYTES,
    );
    const vaultId = normalizeQuotaScopeValue(
      input.vaultId,
      "Quota vault ID",
      MAX_QUOTA_SCOPE_BYTES,
    );
    const category = normalizeQuotaCategory(input.category);
    const action = normalizeQuotaScopeValue(
      input.action,
      "Quota action",
      MAX_QUOTA_ACTION_BYTES,
    );
    const idempotencyScope = normalizeQuotaScopeValue(
      input.idempotencyScope,
      "Quota idempotency scope",
      MAX_QUOTA_SCOPE_BYTES,
    );
    const idempotencyKey = normalizeQuotaScopeValue(
      input.idempotencyKey,
      "Quota idempotency key",
      MAX_QUOTA_SCOPE_BYTES,
    );
    const limitBytes = normalizeQuotaBytes(input.limitBytes, "Quota limit");
    const measuredUsageBytes = normalizeQuotaBytes(
      input.measuredUsageBytes,
      "Quota measured usage",
    );
    const requestedBytes = normalizeQuotaBytes(input.reservedBytes, "Quota reservation");
    const nowMs = normalizeQuotaNow(input.nowMs ?? Date.now());
    const requestedLeaseMs = Number(input.leaseMs ?? DEFAULT_QUOTA_RESERVATION_LEASE_MS);
    if (!Number.isSafeInteger(requestedLeaseMs) || requestedLeaseMs <= 0) {
      throw new Error("Quota reservation lease is invalid");
    }
    const leaseMs = Math.max(
      1_000,
      Math.min(MAX_QUOTA_RESERVATION_LEASE_MS, requestedLeaseMs),
    );
    const expiresAt = nowMs + leaseMs;
    if (!Number.isSafeInteger(expiresAt)) {
      throw new Error("Quota reservation expiry exceeds the supported range");
    }
    const timestamp = nowIsoAt(nowMs);
    let attempt: QuotaReservationAttempt = {
      allowed: false,
      usageBytes: 0,
      reservedBytes: 0,
      remainingBytes: 0,
    };

    this.transaction(() => {
      this.expireQuotaReservations(nowMs, timestamp);
      const usageRow = this.db.prepare(`
        SELECT usage_bytes FROM quota_usage
        WHERE tenant_id = ? AND vault_id = ? AND category = ?
      `).get(tenantId, vaultId, category) as SqlRow | undefined;
      const recordedUsageBytes = usageRow
        ? normalizeQuotaBytes(usageRow.usage_bytes, "Stored quota usage")
        : 0;
      const usageBytes = Math.max(recordedUsageBytes, measuredUsageBytes);
      if (!usageRow || usageBytes > recordedUsageBytes) {
        this.db.prepare(`
          INSERT INTO quota_usage (tenant_id, vault_id, category, usage_bytes, measured_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, vault_id, category) DO UPDATE SET
            usage_bytes = excluded.usage_bytes,
            measured_at = excluded.measured_at
        `).run(tenantId, vaultId, category, usageBytes, nowMs);
      }

      const activeRow = this.db.prepare(`
        SELECT COALESCE(SUM(reserved_bytes), 0) AS reserved_bytes
        FROM quota_reservations
        WHERE tenant_id = ? AND vault_id = ? AND category = ?
          AND status = 'active' AND expires_at > ?
      `).get(tenantId, vaultId, category, nowMs) as SqlRow | undefined;
      const activeReservedBytes = normalizeQuotaBytes(
        activeRow?.reserved_bytes ?? 0,
        "Active quota reservations",
      );
      const totalReservedBytes = activeReservedBytes + requestedBytes;
      if (!Number.isSafeInteger(totalReservedBytes)) {
        throw new Error("Active quota reservations exceed the supported range");
      }
      const usedWithReservation = usageBytes + totalReservedBytes;
      if (!Number.isSafeInteger(usedWithReservation)) {
        throw new Error("Quota usage exceeds the supported range");
      }
      if (usedWithReservation > limitBytes) {
        attempt = {
          allowed: false,
          usageBytes,
          reservedBytes: activeReservedBytes,
          remainingBytes: Math.max(0, limitBytes - usageBytes - activeReservedBytes),
        };
        return;
      }

      const reservation: QuotaReservation = {
        id: randomUUID(),
        tenantId,
        vaultId,
        category,
        action,
        idempotencyScope,
        idempotencyKey,
        limitBytes,
        baselineUsageBytes: usageBytes,
        reservedBytes: requestedBytes,
        status: "active",
        expiresAt,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.db.prepare(`
        INSERT INTO quota_reservations (
          id, tenant_id, vault_id, category, action, idempotency_scope,
          idempotency_key, limit_bytes, baseline_usage_bytes, reserved_bytes,
          status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reservation.id,
        reservation.tenantId,
        reservation.vaultId,
        reservation.category,
        reservation.action,
        reservation.idempotencyScope,
        reservation.idempotencyKey,
        reservation.limitBytes,
        reservation.baselineUsageBytes,
        reservation.reservedBytes,
        reservation.status,
        reservation.expiresAt,
        reservation.createdAt,
        reservation.updatedAt,
      );
      attempt = {
        allowed: true,
        usageBytes,
        reservedBytes: totalReservedBytes,
        remainingBytes: limitBytes - usedWithReservation,
        reservation,
      };
    });
    return attempt;
  }

  reconcileQuotaReservation(input: {
    reservationId: string;
    actualUsageBytes: number;
    nowMs?: number;
  }): QuotaReservation {
    const reservationId = normalizeQuotaScopeValue(
      input.reservationId,
      "Quota reservation ID",
      MAX_QUOTA_SCOPE_BYTES,
    );
    const actualUsageBytes = normalizeQuotaBytes(input.actualUsageBytes, "Quota actual usage");
    const nowMs = normalizeQuotaNow(input.nowMs ?? Date.now());
    const timestamp = nowIsoAt(nowMs);
    let reconciled: QuotaReservation | null = null;

    this.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM quota_reservations WHERE id = ?
      `).get(reservationId) as SqlRow | undefined;
      if (!row) throw new Error("Quota reservation is unknown");
      const reservation = rowToQuotaReservation(row);
      if (reservation.status === "released") {
        throw new Error("Quota reservation was released before reconciliation");
      }
      this.db.prepare(`
        INSERT INTO quota_usage (tenant_id, vault_id, category, usage_bytes, measured_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, vault_id, category) DO UPDATE SET
          usage_bytes = excluded.usage_bytes,
          measured_at = excluded.measured_at
      `).run(
        reservation.tenantId,
        reservation.vaultId,
        reservation.category,
        actualUsageBytes,
        nowMs,
      );
      this.db.prepare(`
        UPDATE quota_reservations
        SET status = 'reconciled', actual_usage_bytes = ?, updated_at = ?, reconciled_at = ?
        WHERE id = ?
      `).run(actualUsageBytes, timestamp, timestamp, reservation.id);
      const updated = this.db.prepare(`
        SELECT * FROM quota_reservations WHERE id = ?
      `).get(reservation.id) as SqlRow | undefined;
      if (!updated) throw new Error("Quota reservation disappeared during reconciliation");
      reconciled = rowToQuotaReservation(updated);
    });
    if (!reconciled) throw new Error("Quota reservation reconciliation did not complete");
    return reconciled;
  }

  releaseQuotaReservation(reservationId: string, nowMs = Date.now()): boolean {
    const id = normalizeQuotaScopeValue(
      reservationId,
      "Quota reservation ID",
      MAX_QUOTA_SCOPE_BYTES,
    );
    const timestamp = nowIsoAt(normalizeQuotaNow(nowMs));
    const result = this.db.prepare(`
      UPDATE quota_reservations
      SET status = 'released', updated_at = ?
      WHERE id = ? AND status = 'active'
    `).run(timestamp, id);
    return result.changes === 1;
  }

  getQuotaUsage(
    tenantId: string,
    vaultId: string,
    category: QuotaCategory,
  ): QuotaUsageRecord | null {
    const tenant = normalizeQuotaScopeValue(tenantId, "Quota tenant ID", MAX_QUOTA_SCOPE_BYTES);
    const vault = normalizeQuotaScopeValue(vaultId, "Quota vault ID", MAX_QUOTA_SCOPE_BYTES);
    const normalizedCategory = normalizeQuotaCategory(category);
    const row = this.db.prepare(`
      SELECT usage_bytes, measured_at FROM quota_usage
      WHERE tenant_id = ? AND vault_id = ? AND category = ?
    `).get(tenant, vault, normalizedCategory) as SqlRow | undefined;
    if (!row) return null;
    return {
      tenantId: tenant,
      vaultId: vault,
      category: normalizedCategory,
      usageBytes: normalizeQuotaBytes(row.usage_bytes, "Stored quota usage"),
      measuredAt: normalizeQuotaTimestamp(row.measured_at, "Stored quota measurement time"),
    };
  }

  getQuotaReservation(reservationId: string): QuotaReservation | null {
    const id = normalizeQuotaScopeValue(
      reservationId,
      "Quota reservation ID",
      MAX_QUOTA_SCOPE_BYTES,
    );
    const row = this.db.prepare(`
      SELECT * FROM quota_reservations WHERE id = ?
    `).get(id) as SqlRow | undefined;
    return row ? rowToQuotaReservation(row) : null;
  }

  recordAudit(event: DurableAuditEvent): string {
    const id = event.id?.trim() || randomUUID();
    const occurredAt = nowIso();
    const metadataJson = boundedJson(event.metadata);
    const actorId = event.actorId?.trim() || undefined;
    const tenantId = event.tenantId?.trim() || undefined;
    const vaultId = event.vaultId?.trim() || undefined;
    const action = event.action.trim();
    const requestId = event.requestId?.trim() || undefined;
    let eventHash = "";
    this.transaction(() => {
      const previous = this.db.prepare(
        "SELECT event_hash FROM audit_events ORDER BY occurred_at DESC, rowid DESC LIMIT 1",
      ).get() as SqlRow | undefined;
      const previousHash = asOptionalString(previous?.event_hash) ?? "";
      eventHash = auditEventHash({
        id,
        actorId,
        tenantId,
        vaultId,
        action,
        requestId,
        outcome: event.outcome,
        metadataJson,
        previousHash,
        occurredAt,
      });
      this.db.prepare(`
        INSERT INTO audit_events (
          id, actor_id, tenant_id, vault_id, action, request_id, outcome,
          metadata_json, previous_hash, event_hash, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, actorId ?? null, tenantId ?? null,
        vaultId ?? null, action, requestId ?? null,
        event.outcome, metadataJson, previousHash || null, eventHash, occurredAt,
      );
    });
    return id;
  }

  recordAuditOnce(event: DurableAuditEvent & { id: string }): string {
    const id = event.id.trim();
    if (!id) {
      throw new Error("A deterministic audit event ID is required");
    }
    const occurredAt = nowIso();
    const metadataJson = boundedJson(event.metadata);
    const actorId = event.actorId?.trim() || undefined;
    const tenantId = event.tenantId?.trim() || undefined;
    const vaultId = event.vaultId?.trim() || undefined;
    const action = event.action.trim();
    const requestId = event.requestId?.trim() || undefined;
    this.transaction(() => {
      const existing = this.db.prepare(
        "SELECT id FROM audit_events WHERE id = ?",
      ).get(id) as SqlRow | undefined;
      if (existing) return;
      const previous = this.db.prepare(
        "SELECT event_hash FROM audit_events ORDER BY occurred_at DESC, rowid DESC LIMIT 1",
      ).get() as SqlRow | undefined;
      const previousHash = asOptionalString(previous?.event_hash) ?? "";
      const eventHash = auditEventHash({
        id,
        actorId,
        tenantId,
        vaultId,
        action,
        requestId,
        outcome: event.outcome,
        metadataJson,
        previousHash,
        occurredAt,
      });
      this.db.prepare(`
        INSERT OR IGNORE INTO audit_events (
          id, actor_id, tenant_id, vault_id, action, request_id, outcome,
          metadata_json, previous_hash, event_hash, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, actorId ?? null, tenantId ?? null,
        vaultId ?? null, action, requestId ?? null,
        event.outcome, metadataJson, previousHash || null, eventHash, occurredAt,
      );
    });
    return id;
  }

  listAuditEvents(limit = 100): Array<{
    id: string;
    actorId?: string;
    tenantId?: string;
    vaultId?: string;
    action: string;
    requestId?: string;
    outcome: string;
    occurredAt: string;
    eventHash: string;
  }> {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const rows = this.db.prepare(`
      SELECT id, actor_id, tenant_id, vault_id, action, request_id,
             outcome, occurred_at, event_hash
      FROM audit_events
      ORDER BY occurred_at DESC, rowid DESC
      LIMIT ?
    `).all(boundedLimit) as SqlRow[];
    return rows.map((row) => ({
      id: String(row.id),
      actorId: asOptionalString(row.actor_id),
      tenantId: asOptionalString(row.tenant_id),
      vaultId: asOptionalString(row.vault_id),
      action: String(row.action),
      requestId: asOptionalString(row.request_id),
      outcome: String(row.outcome),
      occurredAt: String(row.occurred_at),
      eventHash: String(row.event_hash),
    }));
  }

  verifyAuditChain(): AuditChainVerification {
    const rows = this.db.prepare(`
      SELECT id, actor_id, tenant_id, vault_id, action, request_id, outcome,
             metadata_json, previous_hash, event_hash, occurred_at
      FROM audit_events
      ORDER BY occurred_at ASC, rowid ASC
    `).all() as SqlRow[];
    let previousHash = "";

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const id = String(row.id);
      const storedPreviousHash = asOptionalString(row.previous_hash) ?? "";
      if (storedPreviousHash !== previousHash) {
        return {
          valid: false,
          checked: index + 1,
          failedEventId: id,
          reason: "previous-hash-mismatch",
        };
      }
      const eventHash = String(row.event_hash);
      const expectedHash = auditEventHash({
        id,
        actorId: asOptionalString(row.actor_id),
        tenantId: asOptionalString(row.tenant_id),
        vaultId: asOptionalString(row.vault_id),
        action: String(row.action),
        requestId: asOptionalString(row.request_id),
        outcome: String(row.outcome),
        metadataJson: String(row.metadata_json),
        previousHash,
        occurredAt: String(row.occurred_at),
      });
      if (eventHash !== expectedHash) {
        return {
          valid: false,
          checked: index + 1,
          failedEventId: id,
          reason: "event-hash-mismatch",
        };
      }
      previousHash = eventHash;
    }

    return { valid: true, checked: rows.length };
  }

  private expireQuotaReservations(nowMs: number, timestamp: string): void {
    this.db.prepare(`
      UPDATE quota_reservations
      SET status = 'expired', updated_at = ?
      WHERE status = 'active' AND expires_at <= ?
    `).run(timestamp, nowMs);
  }

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original database error.
      }
      throw error;
    }
  }

  private writeIdempotencyResponse(
    scope: string,
    key: string,
    status: "completed" | "failed",
    response: IdempotencyResponse,
  ): void {
    const normalizedScope = scope.trim();
    const normalizedKey = key.trim();
    const statusCode = Math.floor(response.statusCode);
    const contentType = response.contentType.trim();
    const body = Buffer.from(response.body);
    if (
      !normalizedScope
      || !normalizedKey
      || !Number.isInteger(statusCode)
      || statusCode < 100
      || statusCode > 599
      || !contentType
      || Buffer.byteLength(contentType, "utf8") > 256
      || body.byteLength > MAX_IDEMPOTENCY_RESPONSE_BYTES
    ) {
      throw new Error("Idempotency response is invalid");
    }
    const updated = this.db.prepare(`
      UPDATE idempotency_keys
      SET status = ?, result_json = NULL, result_status = ?, result_content_type = ?,
          result_body = ?, updated_at = ?
      WHERE scope = ? AND idempotency_key = ? AND status = 'started'
    `).run(
      status,
      statusCode,
      contentType,
      body,
      nowIso(),
      normalizedScope,
      normalizedKey,
    );
    if (updated.changes !== 1) throw new Error("Unknown or completed idempotency key");
  }
}

let defaultStore: PolarisControlStore | null = null;
let defaultStorePath = "";

export function getPolarisControlStore(importMetaUrl: string): PolarisControlStore {
  const filePath = controlStoreFile(importMetaUrl);
  if (!defaultStore || defaultStorePath !== filePath) {
    defaultStore?.close();
    defaultStore = PolarisControlStore.open(filePath);
    defaultStorePath = filePath;
  }
  return defaultStore;
}

export function closePolarisControlStore(): void {
  defaultStore?.close();
  defaultStore = null;
  defaultStorePath = "";
}
