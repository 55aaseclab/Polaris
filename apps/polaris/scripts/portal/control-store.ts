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

export interface IdempotencyResponse {
  statusCode: number;
  contentType: string;
  body: Buffer;
}

export interface IdempotencyResponseRecord {
  status: "started" | "completed" | "failed";
  response?: IdempotencyResponse;
}

type SqlRow = Record<string, unknown>;

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_ERROR_BYTES = 4 * 1024;
const DEFAULT_GATEWAY_RATE_WINDOW_SECONDS = 60;
const MAX_RATE_LIMIT_BUCKET_KEY_BYTES = 128;
const MAX_IDEMPOTENCY_RESPONSE_BYTES = 2 * 1024 * 1024;

function nowIso(): string {
  return new Date().toISOString();
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

function asOptionalString(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function parsePayload(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
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
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: asOptionalString(row.completed_at),
  };
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_claim
        ON jobs(status, available_at, lease_expires_at, created_at);

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
    ensureIdempotencyResponseColumns(db);
    fs.chmodSync(filePath, 0o600);
    return new PolarisControlStore(filePath, db);
  }

  static openFor(importMetaUrl: string): PolarisControlStore {
    return PolarisControlStore.open(controlStoreFile(importMetaUrl));
  }

  close(): void {
    this.db.close();
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

  claimNextJob(workerId: string, leaseMs = 60_000): DurableJob | null {
    const owner = workerId.trim();
    if (!owner) throw new Error("A durable job worker ID is required");
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
              WHEN cancel_requested = 1 THEN 'vault-provision-cancelled'
              WHEN attempts >= max_attempts THEN COALESCE(error_code, 'job-lease-expired')
              ELSE error_code
            END,
            error_message = CASE
              WHEN cancel_requested = 1 THEN 'vault provision cancelled'
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
      `).run(nowIso(), nowIso(), now);
      const row = this.db.prepare(`
        SELECT id FROM jobs
        WHERE status = 'queued' AND cancel_requested = 0 AND available_at <= ?
        ORDER BY created_at ASC
        LIMIT 1
      `).get(now) as SqlRow | undefined;
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

  completeJob(jobId: string, workerId: string): boolean {
    const now = nowIso();
    const result = this.db.prepare(`
      UPDATE jobs
      SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
          updated_at = ?, completed_at = ?, error_code = NULL, error_message = NULL
      WHERE id = ? AND status = 'running' AND lease_owner = ?
        AND cancel_requested = 0
        AND lease_expires_at > ?
    `).run(now, now, jobId, workerId, Date.now());
    return result.changes === 1;
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
              WHEN cancel_requested = 1 THEN 'vault-provision-cancelled'
              ELSE ?
            END,
            error_message = CASE
              WHEN cancel_requested = 1 THEN 'vault provision cancelled'
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
            WHEN cancel_requested = 1 THEN 'vault-provision-cancelled'
            ELSE ?
          END,
          error_message = CASE
            WHEN cancel_requested = 1 THEN 'vault provision cancelled'
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
              lease_expires_at = NULL, error_code = 'vault-provision-cancelled',
              error_message = 'vault provision cancelled', updated_at = ?,
              completed_at = ?
          WHERE dedupe_key = ? AND status = 'queued'
        `).run(now, now, key);
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

  recordAudit(event: DurableAuditEvent): string {
    const id = event.id?.trim() || randomUUID();
    const occurredAt = nowIso();
    const metadataJson = boundedJson(event.metadata);
    let eventHash = "";
    this.transaction(() => {
      const previous = this.db.prepare(
        "SELECT event_hash FROM audit_events ORDER BY occurred_at DESC, rowid DESC LIMIT 1",
      ).get() as SqlRow | undefined;
      const previousHash = asOptionalString(previous?.event_hash) ?? "";
      eventHash = createHash("sha256").update(JSON.stringify({
        id,
        actorId: event.actorId ?? null,
        tenantId: event.tenantId ?? null,
        vaultId: event.vaultId ?? null,
        action: event.action,
        requestId: event.requestId ?? null,
        outcome: event.outcome,
        metadataJson,
        previousHash,
        occurredAt,
      })).digest("hex");
      this.db.prepare(`
        INSERT INTO audit_events (
          id, actor_id, tenant_id, vault_id, action, request_id, outcome,
          metadata_json, previous_hash, event_hash, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, event.actorId?.trim() || null, event.tenantId?.trim() || null,
        event.vaultId?.trim() || null, event.action.trim(), event.requestId?.trim() || null,
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
