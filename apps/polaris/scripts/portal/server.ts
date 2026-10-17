import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { URL } from "node:url";

import type { ManagedHarness } from "../config/credential-catalog.js";
import { isSkillHarness, type SkillHarness } from "../config/skills.js";
import { assertProjectNameAvailableForUser } from "../config/project-ownership.js";
import {
  findOwnedVaultByWanghaiGatewayId,
  listPortalProfiles,
  loadPortalVaultByTarget,
  parsePortalDriverTarget,
  readPortalProfile,
  readVaultStatus,
  type PortalDriverTarget,
  type PortalProfileSummary,
} from "../core/portal.js";
import {
  exchangeAuthingAuthorizationCode,
  PortalAuthError,
  requireMappedPortalSession,
  requirePortalAdmin,
  requirePortalScope,
  requirePortalSession,
  selfProvisionedPolarisUserId,
  sessionMatchesCurrentIdentity,
  type AuthenticatedPortalSession,
} from "./auth.js";
import { resolvePortalAuthMode } from "@polaris/polaris-auth-server";
import {
  findUserMapEntry,
  normalizePolarisSubscriptionLine,
  UserMapConflictError,
} from "./user-map.js";
import {
  activatePortalCredential,
  cancelPortalWanghaiBackup,
  cancelPortalWanghaiRestoreActivation,
  cancelPortalWanghaiRestore,
  cancelPortalWanghaiRestoreRollback,
  createPortalCredential,
  createPortalSkill,
  listPortalAdminUsers,
  listPortalDomainPacks,
  listPortalWorkflowVaults,
  deletePortalUser,
  getPortalCredentialCatalog,
  getPortalWanghaiBackupJob,
  getPortalWanghaiRestoreActivationJob,
  getPortalWanghaiRestoreJob,
  getPortalWanghaiRestoreRollbackJob,
  deletePortalCredential,
  deletePortalSkill,
  installPortalVaultSkill,
  getPortalVaultDetailStatic,
  listPortalVaultSkills,
  listPortalVaultStaticState,
  readUserPortalCredentialRecord,
  deletePortalVault,
  permanentlyDeletePortalVault,
  getPortalVaultPaseoDiagnostic,
  getPortalVaultDetail,
  listPortalVaults,
  listUserPortalCredentials,
  listUserPortalSkills,
  refreshPortalVault,
  readUserPortalVaultAssetPreview,
  queueProvisionVault,
  queuePortalWanghaiBackup,
  queuePortalWanghaiRestoreActivation,
  queuePortalWanghaiRestore,
  queuePortalWanghaiRestoreRollback,
  rebuildPortalVault,
  restartPortalVaultPaseoDaemon,
  syncPortalVaultSkills,
  startPortalVault,
  stopPortalVault,
  switchPortalVault,
  updatePortalVaultSelectedDriver,
  switchPortalVaultLiveCredential,
  uninstallPortalVaultSkill,
  createPortalUser,
  updatePortalUserProfile,
  updatePortalUserAccess,
  writePortalCredentialFile,
} from "./service.js";
import { ActiveVaultCapacityError } from "../control-plane/capacity.js";
import { resolvePolarisVaultMode, VaultModeError } from "../config/vault-mode.js";
import { WanghaiBackupError } from "../control-plane/jobs/wanghai-backup.js";
import { WanghaiRestoreError } from "../control-plane/jobs/wanghai-restore.js";
import { subscribePortalVaultStream } from "./vault-live-hub.js";
import { evaluatePortalToolStatus } from "../tools/status.js";
import type { PortalVaultStreamEvent } from "../core/portal.js";
import {
  isPortalDocumentPath,
  readPortalAsset,
  portalFallbackHtml,
} from "./portal-assets.js";

import {
  configuredGatewayProtocol,
  consumeLaunchTicket,
  createWanghaiGatewayLaunch,
  gatewayRequestPath,
  isPolarisGatewayLaunchRoute,
  isPolarisGatewayPath,
  issueRequestAssertion,
  POLARIS_GATEWAY_PATH,
  requestUsesExpectedOrigin,
  verifyGatewaySession,
  wanghaiRoleForPortalSession,
  WANGHAI_UPSTREAM_BASE_PATH,
  WANGHAI_GATEWAY_ASSERTION_HEADER,
  WANGHAI_GATEWAY_REQUEST_ID_HEADER,
} from "./wanghai-gateway.js";
import {
  checkWanghaiGatewayPolicy,
  WanghaiGatewayPolicyError,
} from "./wanghai-gateway-policy.js";
import {
  getPolarisControlStore,
  type PolarisControlStore,
  type GatewayRateLimitResult,
} from "./control-store.js";
import {
  maxWanghaiMutationBodyBytes,
  prepareWanghaiMutationAdmission,
  wanghaiAssertionAdmission,
  WanghaiMutationAdmissionError,
  type WanghaiMutationAdmission,
} from "./wanghai-mutation-admission.js";
import {
  activeWorkspaceQuotaBytes,
  estimateWanghaiWorkspaceGrowth,
  WanghaiWorkspaceQuotaError,
} from "./wanghai-workspace-quota.js";
import {
  matchWanghaiMutationAction,
  type WanghaiMutationMatch,
} from "./wanghai-mutation-catalog.js";
import { readUserAccessSummary } from "./user-map.js";
import { vaultRuntimeResourceName, vaultRuntimeScopeName } from "../core/vault-name.js";
import type { VaultSpec } from "../core/vault.js";
import {
  WorkflowControlError,
  WorkflowControlService,
  registerWorkflowProvisionHook,
} from "./workflow/workflow-control.js";
import { getDomainPackFlowGraphProjection } from "../config/domain-packs.js";
import type {
  WorkflowExecutionDriver,
  WorkflowMockScenario,
  WorkflowRunRequest,
  WorkflowSetupRequest,
} from "@polaris/polaris-shell";

type ParsedBody = Record<string, string>;

function allowedVaultLinesForAccessLine(accessLine: unknown): Array<"coding" | "vertical"> {
  if (accessLine == null) {
    return ["coding"];
  }
  const normalized = normalizePolarisSubscriptionLine(accessLine);
  if (normalized === "vertical") {
    return ["vertical"];
  }
  if (normalized === "coding") {
    return ["coding"];
  }
  return ["coding", "vertical"];
}

function resolveRequestedVaultLine(input: {
  requested?: string | null;
  accessLine?: string | null;
}): "coding" | "vertical" {
  const allowed = allowedVaultLinesForAccessLine(input.accessLine);
  const requested = String(input.requested ?? "").trim().toLowerCase();
  if (requested) {
    if (requested !== "coding" && requested !== "vertical") {
      throw new Error("line must be coding or vertical");
    }
    if (!allowed.includes(requested)) {
      throw new Error("The requested product line is not enabled for this user.");
    }
    return requested;
  }
  return allowed[0] ?? "coding";
}

const MAX_PORTAL_BODY_BYTES = 1_048_576;

class PortalRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 413,
  ) {
    super(message);
  }
}

function requestHeader(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] ?? "").trim() : String(value ?? "").trim();
}

function normalizeHttpOrigin(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must contain absolute HTTP(S) origins`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`${name} must contain absolute HTTP(S) origins`);
  }
  return parsed.origin;
}

function configuredPortalOrigins(): Set<string> {
  const values = [
    process.env.POLARIS_PORTAL_ORIGIN,
    process.env.POLARIS_PORTAL_ALLOWED_ORIGINS,
  ]
    .flatMap((value) => String(value ?? "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set(values.map((value) => normalizeHttpOrigin(value, "POLARIS_PORTAL_ALLOWED_ORIGINS")));
}

function requestPublicOrigin(req: IncomingMessage): string | null {
  const host = requestHeader(req, "host");
  if (!host || /[\s/\\]/u.test(host)) {
    return null;
  }
  try {
    const origin = new URL(`http://${host}`);
    // Explicit origins are required outside loopback development. Do not
    // reflect a public Host or X-Forwarded-Proto value into CORS policy.
    if (!isLoopbackHostname(origin.hostname)) return null;
    return origin.origin;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]";
}

function requestHasAllowedPortalOrigin(
  req: IncomingMessage,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const rawOrigin = requestHeader(req, "origin");
  if (!rawOrigin) {
    return false;
  }
  let origin: string;
  try {
    origin = normalizeHttpOrigin(rawOrigin, "Origin");
  } catch {
    return false;
  }
  return allowedOrigins.has(origin) || origin === requestPublicOrigin(req);
}

function applyPortalCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (!requestHasAllowedPortalOrigin(req, allowedOrigins)) {
    return false;
  }
  const origin = normalizeHttpOrigin(requestHeader(req, "origin"), "Origin");
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type");
  res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("vary", "Origin");
  return true;
}

function requestUsesCookieBackedPortalSession(req: IncomingMessage): boolean {
  const cookie = requestHeader(req, "cookie");
  if (!cookie) {
    return false;
  }
  if (resolvePortalAuthMode() === "oauth2-proxy") {
    return true;
  }
  return /(?:^|;\s*)(?:polaris_authing_session|__session)=/u.test(cookie);
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function artifactContentType(name: string): string {
  const extension = path.extname(name).toLocaleLowerCase();
  const types: Record<string, string> = {
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json; charset=utf-8",
    ".m4a": "audio/mp4",
    ".md": "text/markdown; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".wav": "audio/wav",
    ".webm": "video/webm",
    ".webp": "image/webp",
  };
  return types[extension] ?? "application/octet-stream";
}

function sendInlineFile(
  res: ServerResponse,
  sourcePath: string,
  method: string,
): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    throw new WorkflowControlError("产物内容不可用", 404, "artifact-content-unavailable");
  }
  if (!stat.isFile()) {
    throw new WorkflowControlError("产物内容不可用", 404, "artifact-content-unavailable");
  }
  const filename = path.basename(sourcePath);
  res.writeHead(200, {
    "cache-control": "private, no-store",
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "content-length": stat.size,
    "content-type": artifactContentType(filename),
    "x-content-type-options": "nosniff",
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(sourcePath);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

function sendWorkflowArtifact(
  res: ServerResponse,
  workflowControl: WorkflowControlService,
  userId: string,
  runId: string,
  artifactId: string,
  method: string,
): void {
  const { artifact } = workflowControl.getArtifact(userId, runId, artifactId);
  if (artifact.redacted) {
    throw new WorkflowControlError("产物内容不可用", 404, "artifact-content-unavailable");
  }
  if (artifact.sourcePath) {
    sendInlineFile(res, artifact.sourcePath, method);
    return;
  }
  if (typeof artifact.content !== "string") {
    throw new WorkflowControlError("产物内容不可用", 404, "artifact-content-unavailable");
  }
  const body = Buffer.from(artifact.content, "utf8");
  res.writeHead(200, {
    "cache-control": "private, no-store",
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
    "content-length": body.byteLength,
    "content-type": artifactContentType(artifact.name),
    "x-content-type-options": "nosniff",
  });
  if (method !== "HEAD") res.end(body);
  else res.end();
}

function sendWorkflowWorkspaceFile(
  res: ServerResponse,
  workflowControl: WorkflowControlService,
  userId: string,
  runId: string,
  relativePath: string,
  method: string,
): void {
  const { sourcePath } = workflowControl.getWorkspaceFile(userId, runId, relativePath);
  sendInlineFile(res, sourcePath, method);
}

function sendProcessProbe(
  res: ServerResponse,
  method: string,
  status: "ok" | "ready",
): void {
  const payload = `${JSON.stringify({ service: "polaris-portal", status })}\n`;
  res.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff",
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  res.end(payload);
}

function sendText(
  res: ServerResponse,
  statusCode: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  res.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendShellAsset(
  res: ServerResponse,
  contentType: string,
  body: Buffer | string,
  method: string,
): void {
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": contentType.includes("text/html")
      ? "no-cache"
      : "public, max-age=300",
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

function sendEventStreamHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
}

function writeEventStreamEvent(
  res: ServerResponse,
  event: PortalVaultStreamEvent,
): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: "Not found" });
}

function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { error: message });
}

function parseWorkflowValues(raw: string): Record<string, string> {
  if (!raw.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PortalRequestError("Workflow values must be a JSON object", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PortalRequestError("Workflow values must be a JSON object", 400);
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, String(value ?? "")]),
  );
}

function parseWorkflowScenario(raw: string | undefined): WorkflowMockScenario | undefined {
  const scenario = raw?.trim();
  if (!scenario) {
    return undefined;
  }
  if (
    scenario !== "normal"
    && scenario !== "quota-denied"
    && scenario !== "vault-unavailable"
    && scenario !== "executor-failure"
  ) {
    throw new PortalRequestError("Unknown workflow mock scenario", 400);
  }
  return scenario;
}

function parseWorkflowRunRequest(body: ParsedBody, headerIdempotencyKey?: string): WorkflowRunRequest {
  const packId = body.packId?.trim() || "";
  const flowId = body.flowId?.trim() || "";
  const vaultId = body.vaultId?.trim() || "";
  const rawDriver = body.driver?.trim() || "";
  if (rawDriver && rawDriver !== "none" && rawDriver !== "vault") {
    throw new PortalRequestError("Workflow driver must be 'none' or 'vault'", 400);
  }
  const driver = rawDriver ? rawDriver as WorkflowExecutionDriver : undefined;
  if (driver === "none" && vaultId) {
    throw new PortalRequestError("driver=none cannot be combined with vaultId", 400);
  }
  if (driver === "vault" && !vaultId) {
    throw new PortalRequestError("driver=vault requires vaultId", 400);
  }
  if (!packId || !flowId) {
    throw new PortalRequestError("packId and flowId are required", 400);
  }
  const scenario = parseWorkflowScenario(body.scenario);
  const idempotencyKey = workflowIdempotencyKey(body.idempotencyKey, headerIdempotencyKey);
  return {
    packId,
    flowId,
    ...(vaultId ? { vaultId } : {}),
    ...(driver ? { driver } : {}),
    values: parseWorkflowValues(body.values ?? ""),
    ...(scenario ? { scenario } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

/**
 * API idempotency key (PRD KR2): the `idempotencyKey` body field wins over
 * the `Idempotency-Key` header; keys are 1-128 printable ASCII characters.
 */
function workflowIdempotencyKey(bodyKey: unknown, headerKey: string | undefined): string | undefined {
  const raw = (typeof bodyKey === "string" && bodyKey.trim()) || headerKey?.trim() || "";
  if (!raw) {
    return undefined;
  }
  if (!/^[\x21-\x7e]{1,128}$/u.test(raw)) {
    throw new PortalRequestError(
      "Workflow idempotency key must be 1-128 printable ASCII characters",
      400,
    );
  }
  return raw;
}

function parseWorkflowSetupRequest(body: ParsedBody): WorkflowSetupRequest {
  const completed = body.completed === "true" || body.completed === "1";
  const enabledWorkflowKeys = (body.enabledWorkflowKeys ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  return {
    completed,
    domainPackId: body.domainPackId?.trim() || null,
    vaultId: body.vaultId?.trim() || null,
    enabledWorkflowKeys,
    completedAt: body.completedAt?.trim() || null,
  };
}

function parseFormBody(raw: string): ParsedBody {
  const params = new URLSearchParams(raw);
  const result: ParsedBody = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

async function readBody(req: IncomingMessage): Promise<ParsedBody> {
  const declaredLength = Number(requestHeader(req, "content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PORTAL_BODY_BYTES) {
    throw new PortalRequestError("Request body is too large", 413);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_PORTAL_BODY_BYTES) {
      throw new PortalRequestError("Request body is too large", 413);
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  const contentType = String(req.headers["content-type"] ?? "");
  if (contentType.includes("application/json")) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new PortalRequestError("Request body is not valid JSON", 400);
    }
    const body: ParsedBody = {};
    for (const [key, value] of Object.entries(parsed)) {
      body[key] = Array.isArray(value)
        ? value.map((item) => String(item)).join(",")
        : typeof value === "object" && value !== null
          ? JSON.stringify(value)
          : String(value ?? "");
    }
    return body;
  }
  return parseFormBody(raw);
}

async function handleVaultLiveStream(
  req: IncomingMessage,
  res: ServerResponse,
  routeUserId: string,
): Promise<void> {
  sendEventStreamHeaders(res);
  const unsubscribe = subscribePortalVaultStream(routeUserId, (event) => {
    writeEventStreamEvent(res, event);
  });
  req.on("close", () => {
    unsubscribe();
    if (!res.writableEnded) {
      res.end();
    }
  });
}

function routeSegments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

function findProfile(userId: string): PortalProfileSummary | null {
  return listPortalProfiles().find((profile) => profile.id === userId) ?? null;
}

function requireProfile(
  res: ServerResponse,
  routeUserId: string,
): PortalProfileSummary | null {
  const profile = findProfile(routeUserId);
  if (!profile) {
    notFound(res);
    return null;
  }
  return profile;
}

async function handleVaultSwitch(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  vault: string,
): Promise<void> {
  const body = await readBody(req);
  const driver = body.driver?.trim();
  if (!driver) {
    badRequest(res, "Missing driver");
    return;
  }
  const target = parsePortalDriverTarget(driver);
  const result = await switchPortalVault(userId, vault, target);
  sendJson(res, 200, result);
}

async function handleVaultSelectedDriverUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  vault: string,
): Promise<void> {
  const body = await readBody(req);
  const driver = body.driver?.trim();
  if (!driver) {
    badRequest(res, "Missing driver");
    return;
  }
  const target = parsePortalDriverTarget(driver);
  const result = await updatePortalVaultSelectedDriver({ userId, vault, target });
  sendJson(res, 200, result);
}

async function handleVaultProvision(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  vault: string,
  line?: "coding" | "vertical",
  body?: ParsedBody,
): Promise<void> {
  const parsedBody = body ?? await readBody(req);
  const progress = await queueProvisionVault(userId, vault, {
    defaultDockerOnly: parsedBody.defaultDockerOnly === "true",
    startAfterCreate: parsedBody.startAfterCreate === "true",
    ...(line ? { line } : {}),
  });
  sendJson(res, 202, progress);
}

function sendWanghaiBackupError(res: ServerResponse, error: unknown): void {
  if (!(error instanceof WanghaiBackupError)) {
    throw error;
  }
  const statusCode = error.code === "backup-contract-invalid"
    ? 400
    : error.code === "backup-tenant-not-found"
      ? 404
      : error.code === "backup-rate-limited"
        ? 429
        : error.code === "backup-backend-unsupported"
          ? 409
          : 503;
  sendJson(res, statusCode, { error: error.message });
}

function sendWanghaiRestoreError(res: ServerResponse, error: unknown): void {
  if (!(error instanceof WanghaiRestoreError)) {
    throw error;
  }
  const statusCode = error.code === "restore-contract-invalid"
    || error.code === "restore-source-invalid"
    || error.code === "restore-activation-source-invalid"
    || error.code === "restore-rollback-source-invalid"
    ? 400
    : error.code === "restore-tenant-not-found"
      ? 404
      : error.code === "restore-rate-limited"
        || error.code === "restore-activation-rate-limited"
        || error.code === "restore-rollback-rate-limited"
        ? 429
        : error.code === "restore-backend-unsupported"
          || error.code === "restore-source-unavailable"
          || error.code === "restore-activation-source-unavailable"
          || error.code === "restore-rollback-source-unavailable"
          ? 409
          : 503;
  sendJson(res, statusCode, { error: error.message });
}

async function handleWanghaiBackupSubmit(
  req: IncomingMessage,
  res: ServerResponse,
  input: {
    actorId: string;
    userId: string;
    vault: string;
  },
): Promise<void> {
  const idempotencyKey = requestHeader(req, "idempotency-key");
  if (!idempotencyKey) {
    sendJson(res, 428, { error: "Wanghai backup requires the idempotency-key header" });
    return;
  }
  try {
    const job = await queuePortalWanghaiBackup({
      actorId: input.actorId,
      userId: input.userId,
      vault: input.vault,
      idempotencyKey,
    });
    sendJson(res, job.status === "queued" || job.status === "running" ? 202 : 200, { job });
  } catch (error) {
    sendWanghaiBackupError(res, error);
  }
}

function handleWanghaiBackupRead(
  res: ServerResponse,
  input: {
    userId: string;
    vault: string;
    jobId: string;
  },
): void {
  const job = getPortalWanghaiBackupJob(input);
  if (!job) {
    notFound(res);
    return;
  }
  sendJson(res, 200, { job });
}

function handleWanghaiBackupCancellation(
  res: ServerResponse,
  input: {
    actorId: string;
    userId: string;
    vault: string;
    jobId: string;
  },
): void {
  if (!cancelPortalWanghaiBackup(input)) {
    notFound(res);
    return;
  }
  const job = getPortalWanghaiBackupJob(input);
  sendJson(res, 202, { job });
}

async function handleWanghaiRestoreSubmit(
  req: IncomingMessage,
  res: ServerResponse,
  input: {
    actorId: string;
    userId: string;
    vault: string;
    sourceBackupJobId: string;
  },
): Promise<void> {
  const idempotencyKey = requestHeader(req, "idempotency-key");
  if (!idempotencyKey) {
    sendJson(res, 428, { error: "Wanghai restore requires the idempotency-key header" });
    return;
  }
  try {
    const job = await queuePortalWanghaiRestore({
      actorId: input.actorId,
      userId: input.userId,
      vault: input.vault,
      sourceBackupJobId: input.sourceBackupJobId,
      idempotencyKey,
    });
    sendJson(res, job.status === "queued" || job.status === "running" ? 202 : 200, { job });
  } catch (error) {
    sendWanghaiRestoreError(res, error);
  }
}

function handleWanghaiRestoreRead(
  res: ServerResponse,
  input: {
    userId: string;
    vault: string;
    jobId: string;
  },
): void {
  const job = getPortalWanghaiRestoreJob(input);
  if (!job) {
    notFound(res);
    return;
  }
  sendJson(res, 200, { job });
}

function handleWanghaiRestoreCancellation(
  res: ServerResponse,
  input: {
    actorId: string;
    userId: string;
    vault: string;
    jobId: string;
  },
): void {
  if (!cancelPortalWanghaiRestore(input)) {
    notFound(res);
    return;
  }
  const job = getPortalWanghaiRestoreJob(input);
  sendJson(res, 202, { job });
}

async function handleWanghaiRestoreActivationSubmit(
  req: IncomingMessage,
  res: ServerResponse,
  input: {
    actorId: string;
    userId: string;
    vault: string;
    restoreJobId: string;
  },
): Promise<void> {
  const idempotencyKey = requestHeader(req, "idempotency-key");
  if (!idempotencyKey) {
    sendJson(res, 428, { error: "Wanghai restore activation requires the idempotency-key header" });
    return;
  }
  try {
    const job = await queuePortalWanghaiRestoreActivation({
      actorId: input.actorId,
      userId: input.userId,
      vault: input.vault,
      restoreJobId: input.restoreJobId,
      idempotencyKey,
    });
    sendJson(res, job.status === "queued" || job.status === "running" ? 202 : 200, { job });
  } catch (error) {
    sendWanghaiRestoreError(res, error);
  }
}

function handleWanghaiRestoreActivationRead(
  res: ServerResponse,
  input: {
    userId: string;
    vault: string;
    jobId: string;
  },
): void {
  const job = getPortalWanghaiRestoreActivationJob(input);
  if (!job) {
    notFound(res);
    return;
  }
  sendJson(res, 200, { job });
}

function handleWanghaiRestoreActivationCancellation(
  res: ServerResponse,
  input: {
    actorId: string;
    userId: string;
    vault: string;
    jobId: string;
  },
): void {
  if (!cancelPortalWanghaiRestoreActivation(input)) {
    const job = getPortalWanghaiRestoreActivationJob(input);
    if (job) {
      sendJson(res, 409, { error: "Wanghai restore activation can only be cancelled before it starts" });
      return;
    }
    notFound(res);
    return;
  }
  const job = getPortalWanghaiRestoreActivationJob(input);
  sendJson(res, 202, { job });
}

async function handleWanghaiRestoreRollbackSubmit(
  req: IncomingMessage,
  res: ServerResponse,
  input: {
    actorId: string;
    userId: string;
    vault: string;
    activationJobId: string;
  },
): Promise<void> {
  const idempotencyKey = requestHeader(req, "idempotency-key");
  if (!idempotencyKey) {
    sendJson(res, 428, { error: "Wanghai restore rollback requires the idempotency-key header" });
    return;
  }
  try {
    const job = await queuePortalWanghaiRestoreRollback({
      actorId: input.actorId,
      userId: input.userId,
      vault: input.vault,
      activationJobId: input.activationJobId,
      idempotencyKey,
    });
    sendJson(res, job.status === "queued" || job.status === "running" ? 202 : 200, { job });
  } catch (error) {
    sendWanghaiRestoreError(res, error);
  }
}

function handleWanghaiRestoreRollbackRead(
  res: ServerResponse,
  input: {
    userId: string;
    vault: string;
    jobId: string;
  },
): void {
  const job = getPortalWanghaiRestoreRollbackJob(input);
  if (!job) {
    notFound(res);
    return;
  }
  sendJson(res, 200, { job });
}

function handleWanghaiRestoreRollbackCancellation(
  res: ServerResponse,
  input: {
    actorId: string;
    userId: string;
    vault: string;
    jobId: string;
  },
): void {
  if (!cancelPortalWanghaiRestoreRollback(input)) {
    const job = getPortalWanghaiRestoreRollbackJob(input);
    if (job) {
      sendJson(res, 409, { error: "Wanghai restore rollback can only be cancelled before it starts" });
      return;
    }
    notFound(res);
    return;
  }
  const job = getPortalWanghaiRestoreRollbackJob(input);
  sendJson(res, 202, { job });
}

async function handleVaultDelete(
  res: ServerResponse,
  userId: string,
  vault: string,
): Promise<void> {
  const result = await deletePortalVault(userId, vault);
  sendJson(res, 200, result);
}

async function handleVaultPermanentDelete(
  res: ServerResponse,
  userId: string,
  vault: string,
): Promise<void> {
  sendJson(res, 200, await permanentlyDeletePortalVault(userId, vault));
}

async function handleVaultStop(
  res: ServerResponse,
  userId: string,
  vault: string,
): Promise<void> {
  const result = await stopPortalVault(userId, vault);
  sendJson(res, 200, result);
}

async function handleVaultStart(
  res: ServerResponse,
  userId: string,
  vault: string,
): Promise<void> {
  const result = await startPortalVault(userId, vault);
  sendJson(res, 200, result);
}

async function handleVaultRebuild(
  res: ServerResponse,
  userId: string,
  vault: string,
): Promise<void> {
  const result = await rebuildPortalVault(userId, vault);
  sendJson(res, 200, result);
}

async function handleVaultRefresh(
  res: ServerResponse,
  userId: string,
  vault: string,
): Promise<void> {
  const result = await refreshPortalVault(userId, vault);
  sendJson(res, 200, result);
}

function handleVaultPreview(
  res: ServerResponse,
  userId: string,
  vault: string,
  assetPath: string,
): void {
  try {
    sendJson(res, 200, readUserPortalVaultAssetPreview(userId, vault, assetPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "vault asset not found") {
      sendJson(res, 404, { error: message });
      return;
    }
    throw error;
  }
}

async function handleVaultPaseoStatus(
  res: ServerResponse,
  userId: string,
  vault: string,
): Promise<void> {
  const result = await getPortalVaultPaseoDiagnostic({
    userId,
    vault,
  });
  sendJson(res, 200, result);
}

async function handleVaultPaseoRestart(
  res: ServerResponse,
  userId: string,
  vault: string,
): Promise<void> {
  const result = await restartPortalVaultPaseoDaemon({
    userId,
    vault,
  });
  sendJson(res, 200, result);
}

async function handleCredentialCreate(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  const body = await readBody(req);
  const harness = body.harness?.trim() || "codex";
  if (
    harness !== "ssh" &&
    harness !== "codex" &&
    harness !== "claude" &&
    harness !== "copilot" &&
    harness !== "opencode" &&
    harness !== "pi"
  ) {
    badRequest(res, `Unsupported harness '${harness}'`);
    return;
  }
  const saved = await createPortalCredential({
    userId,
    harness,
    ...(body.credentialId?.trim() ? { credentialId: body.credentialId.trim() } : {}),
    ...(body.label?.trim() ? { label: body.label.trim() } : {}),
    ...(body.providerName?.trim() ? { providerName: body.providerName.trim() } : {}),
    ...(body.baseUrl?.trim() ? { baseUrl: body.baseUrl.trim() } : {}),
    ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
    ...(body.presetId?.trim() ? { presetId: body.presetId.trim() } : {}),
    ...(body.model?.trim() ? { model: body.model.trim() } : {}),
    ...(body.activate === "true" ? { activate: true } : {}),
  });
  sendJson(res, 201, saved);
}

async function handleCredentialDelete(
  res: ServerResponse,
  userId: string,
  credentialId: string,
): Promise<void> {
  const deleted = await deletePortalCredential(userId, credentialId);
  sendJson(res, 200, deleted);
}

async function handleCredentialActivate(
  res: ServerResponse,
  userId: string,
  credentialId: string,
): Promise<void> {
  const activated = await activatePortalCredential(userId, credentialId);
  sendJson(res, 200, activated);
}

async function handleCredentialWrite(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  credentialId: string,
  fileKey: string,
): Promise<void> {
  const body = await readBody(req);
  const updated = await writePortalCredentialFile({
    userId,
    credentialId,
    fileKey,
    content: body.content ?? "",
  });
  sendJson(res, 200, updated);
}

async function handleVaultLiveCredentialSwitch(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  vault: string,
): Promise<void> {
  const body = await readBody(req);
  const harness = body.harness?.trim() || "";
  const credentialId = body.credentialId?.trim() || "";
  if (!harness || !credentialId) {
    badRequest(res, "harness and credentialId are required");
    return;
  }
  const switched = await switchPortalVaultLiveCredential({
    userId,
    vault,
    harness: harness as ManagedHarness,
    credentialId,
  });
  sendJson(res, 200, switched);
}

async function handleSkillCreate(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  const body = await readBody(req);
  const harness = (body.harness?.trim() || "codex").toLowerCase();
  if (!isSkillHarness(harness)) {
    badRequest(res, `unsupported skill harness '${harness}'`);
    return;
  }
  const source = body.source?.trim() || "";
  if (!source) {
    badRequest(res, "source is required");
    return;
  }
  const skillName = body.skillName?.trim() || "";
  if (!skillName) {
    badRequest(res, "skillName is required");
    return;
  }
  const created = await createPortalSkill({
    userId,
    harness: harness as SkillHarness,
    source,
    skillName,
    ...(body.skillId?.trim() ? { skillId: body.skillId.trim() } : {}),
  });
  sendJson(res, 201, created);
}

async function handleVaultSkillAction(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  vault: string,
  action: "list" | "install" | "uninstall" | "sync",
): Promise<void> {
  const body = await readBody(req);
  const harness = (body.harness?.trim() || "codex").toLowerCase();
  if (!isSkillHarness(harness)) {
    badRequest(res, `unsupported skill harness '${harness}'`);
    return;
  }
  if (action === "list") {
    sendJson(res, 200, await listPortalVaultSkills({
      userId,
      vault,
      harness: harness as SkillHarness,
    }));
    return;
  }
  if (action === "sync") {
    sendJson(res, 200, await syncPortalVaultSkills({
      userId,
      vault,
      harness: harness as SkillHarness,
    }));
    return;
  }
  const skillId = body.skillId?.trim() || "";
  if (!skillId) {
    badRequest(res, "skillId is required");
    return;
  }
  if (action === "install") {
    sendJson(res, 200, await installPortalVaultSkill({
      userId,
      vault,
      harness: harness as SkillHarness,
      skillId,
    }));
    return;
  }
  sendJson(res, 200, await uninstallPortalVaultSkill({
    userId,
    vault,
    harness: harness as SkillHarness,
    skillId,
  }));
}

async function handleProfileUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  const body = await readBody(req);
  const updated = await updatePortalUserProfile(userId, {
    ...(body.name !== undefined ? { name: body.name.trim() } : {}),
    ...(body.email !== undefined ? { email: body.email.trim() } : {}),
    ...(body.githubAccount !== undefined ? { githubAccount: body.githubAccount.trim() } : {}),
    ...(body.sshComment !== undefined ? { sshComment: body.sshComment.trim() } : {}),
  });
  sendJson(res, 200, updated);
}

async function handleUserAccessUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  const body = await readBody(req);
  const role = body.role === "admin" || body.role === "user" ? body.role : undefined;
  const plan = body.plan === "free" || body.plan === "pro" ? body.plan : undefined;
  const line =
    body.line === "coding" || body.line === "vertical" || body.line === "both"
      ? body.line
      : undefined;
  if (!role && !plan && !line) {
    badRequest(res, "role, plan, or line is required");
    return;
  }
  sendJson(res, 200, await updatePortalUserAccess(userId, {
    ...(role ? { role } : {}),
    ...(plan ? { plan } : {}),
    ...(line ? { line } : {}),
  }));
}

async function handleUserCreate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const session = await requirePortalSession(req, res);
  if (!session) {
    return;
  }
  const body = await readBody(req);
  const userProfileId = body.userProfileId?.trim() || "";
  const authingUsername = body.authingUsername?.trim() || "";
  const authingUserId = body.authingUserId?.trim() || "";
  if (!userProfileId) {
    badRequest(res, "Missing userProfileId");
    return;
  }
  if (!authingUsername) {
    badRequest(res, "Missing Authing username");
    return;
  }
  if (session.role !== "admin") {
    if (session.polarisUserId) {
      sendJson(res, 403, { error: "This Authing user is already provisioned in Polaris" });
      return;
    }
    if (!sessionMatchesCurrentIdentity(session, { authingUsername, authingUserId })) {
      sendJson(res, 403, { error: "User creation must match the authenticated Authing identity" });
      return;
    }
    let expectedUserProfileId: string;
    try {
      expectedUserProfileId = selfProvisionedPolarisUserId(session);
    } catch (error) {
      sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (userProfileId !== expectedUserProfileId) {
      sendJson(res, 403, { error: "User creation must use the current Authing identity as the Polaris user id" });
      return;
    }
  }
  try {
    const created = await createPortalUser({
      userProfileId,
      ...(session.role === "admin"
        ? (authingUsername ? { authingUsername } : {})
        : (session.authingUsername ? { authingUsername: session.authingUsername } : {})),
      ...(session.role === "admin"
        ? (authingUserId ? { authingUserId } : {})
        : { authingUserId: session.authingUserId }),
      ...(body.email?.trim() ? { email: body.email.trim() } : {}),
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.referralCode?.trim() ? { referralCode: body.referralCode.trim() } : {}),
      ...(session.role === "admin" && (body.role === "admin" || body.role === "user")
        ? { role: body.role }
        : {}),
      ...(session.role === "admin" && (body.plan === "free" || body.plan === "pro")
        ? { plan: body.plan }
        : {}),
      ...(session.role === "admin" && (
        body.line === "coding" || body.line === "vertical" || body.line === "both"
      )
        ? { line: body.line }
        : {}),
    });
    sendJson(res, 201, created);
  } catch (error) {
    if (error instanceof UserMapConflictError) {
      sendJson(res, 409, { error: error.message });
      return;
    }
    throw error;
  }
}

async function handleUserDelete(
  res: ServerResponse,
  userId: string,
): Promise<void> {
  sendJson(res, 200, await deletePortalUser(userId));
}

type AuthorizedWanghaiVault = {
  vault: string;
  spec: VaultSpec;
};

function sessionCanUseWanghai(
  session: Pick<AuthenticatedPortalSession, "line">,
): boolean {
  return session.line === "vertical" || session.line === "both";
}

function resolveCurrentWanghaiGatewaySession(
  session: ReturnType<typeof verifyGatewaySession>,
): ReturnType<typeof verifyGatewaySession> | null {
  const access = readUserAccessSummary(session.user_id);
  if (
    !access
    || access.polarisUserId !== session.user_id
    || !sessionCanUseWanghai(access)
  ) {
    return null;
  }
  // Gateway cookies are short-lived transport state, not an authority cache.
  // Re-derive the role from Polaris so revocation/downgrade takes effect before
  // the next proxied Wanghai request.
  return {
    ...session,
    role: wanghaiRoleForPortalSession(access),
  };
}

async function resolveAuthorizedWanghaiVault(
  userId: string,
  wanghaiId: string,
): Promise<AuthorizedWanghaiVault> {
  const vault = findOwnedVaultByWanghaiGatewayId(userId, wanghaiId);
  if (!vault) {
    throw new PortalAuthError("Wanghai vault not found", 404);
  }
  const target = readVaultStatus(userId, vault)?.driver?.selected;
  if (!target) {
    throw new PortalAuthError("Wanghai vault not found", 404);
  }
  try {
    const spec = loadPortalVaultByTarget(userId, vault, target);
    if (spec.connectivity.servicePorts.some(isWanghaiServicePort)) {
      return { vault, spec };
    }
  } catch {
    // The selected runtime is the only permitted gateway target. Do not fall
    // back to a retained Docker, Pod, or KubeVirt configuration.
  }
  throw new PortalAuthError("Wanghai vault not found", 404);
}

function isWanghaiServicePort(port: VaultSpec["connectivity"]["servicePorts"][number]): boolean {
  return port.name?.toLowerCase() === "wanghai" || port.containerPort === "9090";
}

function resolveWanghaiGatewayTarget(vault: VaultSpec): string {
  const port = vault.connectivity.servicePorts.find(isWanghaiServicePort);
  if (!port) {
    throw new Error("Wanghai portal port is not configured");
  }
  if (vault.backend.kind === "docker") {
    const configuredHost = String(
      process.env.POLARIS_WANGHAI_DOCKER_GATEWAY_HOST ?? "127.0.0.1",
    ).trim();
    if (!configuredHost || !port.nodePort) {
      throw new Error("Docker Wanghai gateway target is not configured");
    }
    const target = new URL(
      configuredHost.includes("://") ? configuredHost : `http://${configuredHost}`,
    );
    if (target.protocol !== "http:" || target.pathname !== "/" || target.search || target.hash) {
      throw new Error("POLARIS_WANGHAI_DOCKER_GATEWAY_HOST must be an HTTP host");
    }
    target.port = port.nodePort;
    return target.origin;
  }

  const clusterDomain = String(
    process.env.POLARIS_WANGHAI_CLUSTER_DOMAIN ?? "cluster.local",
  ).trim();
  if (!/^[a-z0-9.-]+$/u.test(clusterDomain)) {
    throw new Error("POLARIS_WANGHAI_CLUSTER_DOMAIN is invalid");
  }
  const namespace = vaultRuntimeScopeName(
    vault.userProfile.id,
    vault.identity.projectName,
  );
  const service = vaultRuntimeResourceName(
    vault.userProfile.id,
    vault.identity.projectName,
    "wanghai",
  );
  return `http://${service}.${namespace}.svc.${clusterDomain}:${port.containerPort}`;
}

function sendGatewayError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = gatewayErrorPayload(message);
  res.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": payload.byteLength,
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(payload);
}

function gatewayErrorPayload(message: string): Buffer {
  return Buffer.from(`${JSON.stringify({ error: message })}\n`, "utf8");
}

function gatewayRateLimitHeaders(rateLimit: GatewayRateLimitResult): Record<string, string> {
  const retryAfter = Math.max(1, rateLimit.resetAt - Math.floor(Date.now() / 1000));
  return {
    "ratelimit-limit": String(rateLimit.limit),
    "ratelimit-remaining": String(rateLimit.remaining),
    "ratelimit-reset": String(retryAfter),
  };
}

function sendGatewayRateLimitError(
  res: ServerResponse,
  rateLimit: GatewayRateLimitResult,
): void {
  const retryAfter = Math.max(1, rateLimit.resetAt - Math.floor(Date.now() / 1000));
  sendGatewayError(res, 429, "Wanghai gateway rate limit exceeded", {
    ...gatewayRateLimitHeaders(rateLimit),
    "retry-after": String(retryAfter),
  });
}

function isUnsafeMethod(method: string | undefined): boolean {
  const normalized = String(method ?? "GET").toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD" && normalized !== "OPTIONS";
}

type WanghaiMutationAudit = {
  admission: WanghaiMutationAdmission;
  category: string;
  method: string;
  requestId: string;
  route: string;
  session: ReturnType<typeof verifyGatewaySession>;
};

type WanghaiMutationExecution = {
  admission: WanghaiMutationAdmission;
  store: PolarisControlStore;
  quota: {
    audit: WanghaiQuotaAudit;
    reservationId: string;
    session: ReturnType<typeof verifyGatewaySession>;
    targetOrigin: string;
  };
};

type WanghaiQuotaAudit = {
  admission: WanghaiMutationAdmission;
  estimatedBytes: number;
  limitBytes: number;
  measuredUsageBytes: number;
  requestId: string;
  session: ReturnType<typeof verifyGatewaySession>;
};

const WANGHAI_WORKSPACE_LEASE_MS = 120_000;
const MAX_WANGHAI_MUTATION_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_WANGHAI_WORKSPACE_USAGE_RESPONSE_BYTES = 16 * 1024;
const WANGHAI_WORKSPACE_USAGE_TIMEOUT_MS = 5_000;
const WANGHAI_WORKSPACE_USAGE_PATH = "/wanghai/api/internal/workspace-usage";

const WANGHAI_AUDIT_ROUTE_SEGMENTS = new Set([
  "api",
  "assets",
  "catalogs",
  "customers",
  "manual-review",
  "metrics",
  "modules",
  "orders",
  "outreach",
  "paseo",
  "prebuilt-workflows",
  "products",
  "seo",
  "settings",
  "sites",
  "submodules",
  "thumb",
  "workflows",
  "workspaces",
]);

function wanghaiAuditRoute(pathname: string): string {
  // Do not put tenant workspace, product, order, or site identifiers into the
  // control-plane audit log. The route shape is sufficient for triage.
  const segments = pathname.split("/").filter(Boolean).slice(0, 32);
  return `/${segments.map((segment) => (
    WANGHAI_AUDIT_ROUTE_SEGMENTS.has(segment) ? segment : ":resource"
  )).join("/")}`;
}

function recordWanghaiMutationAudit(
  audit: WanghaiMutationAudit,
  phase: "accepted" | "completed",
  upstreamStatus?: number,
): void {
  getPolarisControlStore(import.meta.url).recordAudit({
    actorId: audit.session.user_id,
    tenantId: audit.session.tenant_id,
    vaultId: audit.session.vault_id,
    action: `wanghai.surface.action.${audit.admission.action.id}.${phase}`,
    requestId: audit.requestId,
    outcome: phase === "accepted" || (upstreamStatus ?? 500) < 400
      ? "success"
      : "failure",
    metadata: {
      action: audit.admission.action.id,
      actionVersion: audit.admission.action.version,
      category: audit.category,
      ...(audit.admission.expectedVersion === undefined
        ? {}
        : { expectedVersion: audit.admission.expectedVersion }),
      method: audit.method,
      route: audit.route,
      ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
    },
  });
}

function recordWanghaiQuotaAudit(
  audit: WanghaiQuotaAudit,
  phase: "reservation.accepted" | "reservation.denied" | "reconciliation.completed" | "reconciliation.failed",
  input: { actualUsageBytes?: number } = {},
): void {
  getPolarisControlStore(import.meta.url).recordAudit({
    actorId: audit.session.user_id,
    tenantId: audit.session.tenant_id,
    vaultId: audit.session.vault_id,
    action: `wanghai.surface.quota.${phase}`,
    requestId: audit.requestId,
    outcome: phase === "reservation.denied"
      ? "denied"
      : phase === "reconciliation.failed"
        ? "failure"
        : "success",
    metadata: {
      action: audit.admission.action.id,
      category: "active_workspace",
      estimatedBytes: audit.estimatedBytes,
      limitBytes: audit.limitBytes,
      measuredUsageBytes: audit.measuredUsageBytes,
      ...(input.actualUsageBytes === undefined
        ? {}
        : { actualUsageBytes: input.actualUsageBytes }),
    },
  });
}

function isPrivateWanghaiPath(pathname: string): boolean {
  return pathname === "/api/internal" || pathname.startsWith("/api/internal/");
}

function resolveWanghaiUpstreamUrl(rawUrl: string | undefined, targetOrigin: string): URL {
  const requestTarget = validateWanghaiRequestTarget(rawUrl);
  const publicUrl = new URL(requestTarget, "http://polaris-gateway.invalid");
  const surfacePath = gatewayRequestPath(publicUrl.pathname);
  const upstreamPath = surfacePath === "/"
    // The current Wanghai Next build canonicalizes its base path without a
    // trailing slash. Preserve that form so a public `/g/` request does not
    // loop through an upstream 308 redirect.
    ? WANGHAI_UPSTREAM_BASE_PATH
    : `${WANGHAI_UPSTREAM_BASE_PATH}${surfacePath}`;
  const resolved = new URL(upstreamPath, targetOrigin);
  resolved.search = publicUrl.search;
  if (resolved.origin !== targetOrigin) {
    throw new WanghaiGatewayPolicyError("Invalid Wanghai gateway request origin", 400);
  }
  return resolved;
}

function validateWanghaiRequestTarget(rawUrl: string | undefined): string {
  const requestTarget = String(rawUrl ?? "/");
  // Node accepts absolute-form request targets from proxy-style clients. Do
  // not let one override the configured private upstream origin.
  if (
    !requestTarget.startsWith("/")
    || requestTarget.startsWith("//")
    || requestTarget.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(requestTarget)
  ) {
    throw new WanghaiGatewayPolicyError("Invalid Wanghai gateway request path", 400);
  }
  return requestTarget;
}

function requestHeaderValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    throw new WanghaiMutationAdmissionError(`Wanghai request header '${name}' is invalid`, 400);
  }
  return raw;
}

async function readBoundedWanghaiMutationBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const declaredLength = requestHeaderValue(req, "content-length");
  if (declaredLength !== undefined) {
    if (!/^\d+$/u.test(declaredLength.trim())) {
      throw new WanghaiMutationAdmissionError("Wanghai Content-Length is invalid", 400);
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length)) {
      throw new WanghaiMutationAdmissionError("Wanghai Content-Length is invalid", 400);
    }
    if (length > maxBytes) {
      throw new WanghaiMutationAdmissionError(
        `Wanghai mutation body exceeds the ${maxBytes} byte limit`,
        413,
      );
    }
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > maxBytes) {
      req.resume();
      throw new WanghaiMutationAdmissionError(
        `Wanghai mutation body exceeds the ${maxBytes} byte limit`,
        413,
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

async function readBoundedWanghaiMutationResponse(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_WANGHAI_MUTATION_RESPONSE_BYTES) {
      try {
        await response.body.cancel();
      } catch {
        // The response stream may already be closed by the upstream.
      }
      throw new Error("Wanghai mutation response exceeds the replay limit");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

async function measureWanghaiWorkspaceUsage(input: {
  session: ReturnType<typeof verifyGatewaySession>;
  targetOrigin: string;
}): Promise<number> {
  const requestId = randomUUID();
  const assertion = issueRequestAssertion({
    session: input.session,
    requestId,
    quotaMeasurement: "active_workspace",
  });
  let response: Response;
  try {
    response = await fetch(new URL(WANGHAI_WORKSPACE_USAGE_PATH, input.targetOrigin), {
      method: "GET",
      headers: {
        accept: "application/json",
        [WANGHAI_GATEWAY_ASSERTION_HEADER]: assertion,
        [WANGHAI_GATEWAY_REQUEST_ID_HEADER]: requestId,
      },
      redirect: "error",
      signal: AbortSignal.timeout(WANGHAI_WORKSPACE_USAGE_TIMEOUT_MS),
    });
  } catch {
    throw new WanghaiWorkspaceQuotaError("Wanghai workspace usage is unavailable", 503);
  }
  if (response.status !== 200) {
    throw new WanghaiWorkspaceQuotaError("Wanghai workspace usage is unavailable", 503);
  }
  let body: Buffer;
  try {
    body = await readBoundedWanghaiWorkspaceUsageResponse(response);
  } catch {
    throw new WanghaiWorkspaceQuotaError("Wanghai workspace usage is unavailable", 503);
  }
  return parseWanghaiWorkspaceUsage(body);
}

async function reconcileWanghaiMutationQuota(execution: WanghaiMutationExecution): Promise<void> {
  try {
    const actualUsageBytes = await measureWanghaiWorkspaceUsage({
      session: execution.quota.session,
      targetOrigin: execution.quota.targetOrigin,
    });
    execution.store.reconcileQuotaReservation({
      reservationId: execution.quota.reservationId,
      actualUsageBytes,
    });
    recordWanghaiQuotaAudit(execution.quota.audit, "reconciliation.completed", {
      actualUsageBytes,
    });
  } catch {
    try {
      recordWanghaiQuotaAudit(execution.quota.audit, "reconciliation.failed");
    } catch {
      // The accepted mutation audit remains durable when reconciliation audit
      // repair requires operator attention.
    }
  }
}

async function readBoundedWanghaiWorkspaceUsageResponse(response: Response): Promise<Buffer> {
  const declaredLength = response.headers.get("content-length")?.trim();
  if (declaredLength && (!/^\d+$/u.test(declaredLength)
    || Number(declaredLength) > MAX_WANGHAI_WORKSPACE_USAGE_RESPONSE_BYTES)) {
    throw new Error("Wanghai workspace usage response is too large");
  }
  if (!response.body) throw new Error("Wanghai workspace usage response is empty");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_WANGHAI_WORKSPACE_USAGE_RESPONSE_BYTES) {
      try {
        await response.body.cancel();
      } catch {
        // The response stream may already be closed by the upstream.
      }
      throw new Error("Wanghai workspace usage response is too large");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function parseWanghaiWorkspaceUsage(body: Buffer): number {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new WanghaiWorkspaceQuotaError("Wanghai workspace usage is unavailable", 503);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WanghaiWorkspaceQuotaError("Wanghai workspace usage is unavailable", 503);
  }
  const payload = value as Record<string, unknown>;
  const expectedKeys = new Set([
    "schema_version",
    "category",
    "usage_bytes",
    "file_count",
    "entry_count",
  ]);
  if (Object.keys(payload).length !== expectedKeys.size
    || Object.keys(payload).some((key) => !expectedKeys.has(key))) {
    throw new WanghaiWorkspaceQuotaError("Wanghai workspace usage is unavailable", 503);
  }
  const usageBytes = payload.usage_bytes;
  if (
    payload.schema_version !== 1
    || payload.category !== "active_workspace"
    || !Number.isSafeInteger(usageBytes)
    || (usageBytes as number) < 0
    || !Number.isSafeInteger(payload.file_count)
    || (payload.file_count as number) < 0
    || !Number.isSafeInteger(payload.entry_count)
    || (payload.entry_count as number) < 0
  ) {
    throw new WanghaiWorkspaceQuotaError("Wanghai workspace usage is unavailable", 503);
  }
  return usageBytes as number;
}

function replayWanghaiMutationResponse(
  res: ServerResponse,
  requestId: string,
  response: { statusCode: number; contentType: string; body: Buffer },
  rateLimit?: GatewayRateLimitResult,
): void {
  res.writeHead(response.statusCode, {
    "cache-control": "no-store",
    "content-length": response.body.byteLength,
    "content-type": response.contentType,
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "x-polaris-idempotent-replay": "1",
    [WANGHAI_GATEWAY_REQUEST_ID_HEADER]: requestId,
    ...(rateLimit ? gatewayRateLimitHeaders(rateLimit) : {}),
  });
  res.end(response.body);
}

function forwardedGatewayRequestHeaders(
  req: IncomingMessage,
  assertion: string,
  requestId: string,
): Headers {
  const headers = new Headers();
  const blocked = new Set([
    "authorization",
    "connection",
    "content-length",
    "cookie",
    "host",
    "idempotency-key",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "refresh",
    "set-cookie",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    WANGHAI_GATEWAY_ASSERTION_HEADER,
    WANGHAI_GATEWAY_REQUEST_ID_HEADER,
    "x-polaris-expected-version",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
  ]);
  for (const [name, value] of Object.entries(req.headers)) {
    if (!value || blocked.has(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set(WANGHAI_GATEWAY_ASSERTION_HEADER, assertion);
  headers.set(WANGHAI_GATEWAY_REQUEST_ID_HEADER, requestId);
  headers.set("x-forwarded-for", req.socket.remoteAddress ?? "");
  headers.set("x-forwarded-host", String(req.headers.host ?? ""));
  headers.set("x-forwarded-proto", configuredGatewayProtocol().replace(":", ""));
  return headers;
}

function writeGatewayResponseHeaders(
  res: ServerResponse,
  response: Response,
  targetOrigin: string,
  req: IncomingMessage,
  rateLimit?: GatewayRateLimitResult,
): void {
  const blocked = new Set([
    "connection",
    "content-encoding",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "refresh",
    "set-cookie",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  for (const [name, rawValue] of response.headers.entries()) {
    if (blocked.has(name.toLowerCase())) continue;
    let value = rawValue;
    if (name.toLowerCase() === "location") {
      try {
        const location = new URL(rawValue, targetOrigin);
        if (location.origin === targetOrigin) {
          value = `${rewriteWanghaiUpstreamLocation(location.pathname)}${location.search}${location.hash}`;
        }
      } catch {
        // Preserve an invalid upstream header rather than turning a proxy
        // response into an internal error.
      }
    }
    res.setHeader(name, value);
  }
  // Only Polaris may establish state for the gateway path. Wanghai is an
  // upstream surface and must not overwrite the gateway session cookie.
  res.setHeader("referrer-policy", "same-origin");
  res.setHeader("x-content-type-options", "nosniff");
  if (rateLimit) {
    for (const [name, value] of Object.entries(gatewayRateLimitHeaders(rateLimit))) {
      res.setHeader(name, value);
    }
  }
  void req;
}

function shouldRewriteWanghaiGatewayText(contentType: string): boolean {
  const normalizedContentType = contentType.toLowerCase();
  return normalizedContentType.includes("text/")
    || normalizedContentType.includes("javascript")
    || normalizedContentType.includes("css");
}

function rewriteWanghaiGatewayText(body: Buffer, contentType: string): Buffer {
  if (!shouldRewriteWanghaiGatewayText(contentType)) {
    return body;
  }
  const text = body.toString("utf8");
  const basePathPattern = new RegExp(
    `${WANGHAI_UPSTREAM_BASE_PATH}(?=(?:/|[?#]|[\\s"'\\x60),;\\]}]|$))`,
    "gu",
  );
  if (!basePathPattern.test(text)) {
    return body;
  }
  return Buffer.from(text.replaceAll(basePathPattern, POLARIS_GATEWAY_PATH), "utf8");
}

async function proxyWanghaiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  targetOrigin: string,
  requestUrl: URL,
  assertion: string,
  requestId: string,
  rateLimit?: GatewayRateLimitResult,
  requestBody?: Buffer,
  execution?: WanghaiMutationExecution,
  audit?: WanghaiMutationAudit,
): Promise<void> {
  const method = String(req.method ?? "GET").toUpperCase();
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: forwardedGatewayRequestHeaders(req, assertion, requestId),
    redirect: "manual",
  };
  if (method !== "GET" && method !== "HEAD") {
    if (requestBody) {
      init.body = requestBody as unknown as BodyInit;
    } else {
      init.body = req as unknown as BodyInit;
      init.duplex = "half";
    }
  }

  let response: Response;
  try {
    response = await fetch(requestUrl, init);
  } catch {
    const payload = gatewayErrorPayload("Wanghai portal is unavailable");
    if (execution) {
      await reconcileWanghaiMutationQuota(execution);
      try {
        execution.store.failIdempotencyResponse(
          execution.admission.idempotencyScope,
          execution.admission.idempotencyKey,
          {
            statusCode: 502,
            contentType: "application/json; charset=utf-8",
            body: payload,
          },
        );
      } catch {
        // The accepted audit record identifies a mutation that needs operator
        // reconciliation. Do not forward an unrecorded retry.
      }
    }
    if (audit) {
      try {
        recordWanghaiMutationAudit(audit, "completed", 502);
      } catch {
        // The accepted audit record was written before forwarding. Preserve the
        // gateway failure response instead of encouraging an unsafe replay.
      }
    }
    sendGatewayError(res, 502, "Wanghai portal is unavailable");
    return;
  }
  if (execution) {
    let responseBody: Buffer;
    let quotaReconciled = false;
    try {
      responseBody = await readBoundedWanghaiMutationResponse(response);
      await reconcileWanghaiMutationQuota(execution);
      quotaReconciled = true;
      execution.store.completeIdempotencyResponse(
        execution.admission.idempotencyScope,
        execution.admission.idempotencyKey,
        {
          statusCode: response.status,
          contentType: response.headers.get("content-type") ?? "application/octet-stream",
          body: responseBody,
        },
      );
    } catch {
      const payload = gatewayErrorPayload("Wanghai mutation result is unavailable");
      if (!quotaReconciled) {
        await reconcileWanghaiMutationQuota(execution);
      }
      try {
        execution.store.failIdempotencyResponse(
          execution.admission.idempotencyScope,
          execution.admission.idempotencyKey,
          {
            statusCode: 502,
            contentType: "application/json; charset=utf-8",
            body: payload,
          },
        );
      } catch {
        // Preserve the accepted semantic audit record for reconciliation.
      }
      if (audit) {
        try {
          recordWanghaiMutationAudit(audit, "completed", 502);
        } catch {
          // The accepted record remains durable even when completion repair is needed.
        }
      }
      sendGatewayError(res, 502, "Wanghai mutation result is unavailable");
      return;
    }
    if (audit) {
      try {
        recordWanghaiMutationAudit(audit, "completed", response.status);
      } catch {
        // The exact upstream result is durable under the idempotency key.
      }
    }
    writeGatewayResponseHeaders(res, response, targetOrigin, req, rateLimit);
    res.setHeader(WANGHAI_GATEWAY_REQUEST_ID_HEADER, requestId);
    res.setHeader("content-length", responseBody.byteLength);
    res.writeHead(response.status);
    res.end(responseBody);
    return;
  }
  if (audit) {
    try {
      recordWanghaiMutationAudit(audit, "completed", response.status);
    } catch {
      // A durable accepted record already exists. Returning the upstream
      // result avoids replaying a completed mutation while audit repair is
      // investigated from the missing completion record.
    }
  }
  writeGatewayResponseHeaders(res, response, targetOrigin, req, rateLimit);
  res.setHeader(WANGHAI_GATEWAY_REQUEST_ID_HEADER, requestId);
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  if (method === "HEAD" || !response.body) {
    res.writeHead(response.status);
    res.end();
    return;
  }
  if (shouldRewriteWanghaiGatewayText(contentType)) {
    const responseBody = rewriteWanghaiGatewayText(
      Buffer.from(await response.arrayBuffer()),
      contentType,
    );
    res.setHeader("content-length", responseBody.byteLength);
    res.writeHead(response.status);
    res.end(responseBody);
    return;
  }
  res.writeHead(response.status);
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      if (!res.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          res.once("drain", resolve);
          res.once("error", reject);
        });
      }
    }
    res.end();
  } catch {
    if (!res.writableEnded) {
      res.destroy();
    }
  }
}

function rewriteWanghaiUpstreamLocation(pathname: string): string {
  if (
    pathname !== WANGHAI_UPSTREAM_BASE_PATH
    && !pathname.startsWith(`${WANGHAI_UPSTREAM_BASE_PATH}/`)
  ) {
    return pathname;
  }
  const suffix = pathname.slice(WANGHAI_UPSTREAM_BASE_PATH.length);
  return `${POLARIS_GATEWAY_PATH}${suffix || "/"}`;
}

async function handleWanghaiGatewayPath(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  let surfacePath: string;
  try {
    validateWanghaiRequestTarget(req.url);
    surfacePath = gatewayRequestPath(url.pathname);
  } catch (error) {
    if (error instanceof WanghaiGatewayPolicyError) {
      sendGatewayError(res, error.statusCode, error.message);
      return;
    }
    sendGatewayError(res, 400, "Invalid Wanghai gateway request path");
    return;
  }

  const ticket = url.searchParams.get("ticket");
  if (ticket) {
    if (
      req.method !== "GET"
      || url.searchParams.getAll("ticket").length !== 1
    ) {
      sendGatewayError(res, 400, "Invalid Wanghai launch request");
      return;
    }
    try {
      consumeLaunchTicket({
        req,
        res,
        ticket,
        secure: configuredGatewayProtocol() === "https:",
      });
      res.writeHead(302, {
        "cache-control": "no-store",
        location: url.pathname === POLARIS_GATEWAY_PATH
          ? `${POLARIS_GATEWAY_PATH}/`
          : url.pathname,
        "referrer-policy": "no-referrer",
      });
      res.end();
    } catch {
      sendGatewayError(res, 401, "Invalid or expired Wanghai launch ticket");
    }
    return;
  }

  let session;
  try {
    session = verifyGatewaySession(req);
  } catch {
    sendGatewayError(res, 401, "Wanghai gateway session is required");
    return;
  }
  const currentSession = resolveCurrentWanghaiGatewaySession(session);
  if (!currentSession) {
    sendGatewayError(res, 403, "Wanghai gateway access is no longer authorized");
    return;
  }
  session = currentSession;
  const unsafeMethod = isUnsafeMethod(req.method);
  if (unsafeMethod && !requestUsesExpectedOrigin(req, configuredGatewayProtocol())) {
    sendGatewayError(res, 403, "Wanghai request failed CSRF validation");
    return;
  }

  if (isPrivateWanghaiPath(surfacePath)) {
    sendGatewayError(res, 404, "Wanghai route is unavailable");
    return;
  }

  let mutationMatch: WanghaiMutationMatch | null = null;
  if (unsafeMethod) {
    try {
      mutationMatch = matchWanghaiMutationAction({
        method: req.method,
        pathname: surfacePath,
      });
    } catch {
      sendGatewayError(res, 400, "Wanghai mutation route is invalid");
      return;
    }
    if (!mutationMatch) {
      sendGatewayError(res, 403, "Wanghai mutation route is not admitted");
      return;
    }
    if (mutationMatch.action.minimumRole === "admin" && session.role !== "admin") {
      sendGatewayError(res, 403, "Wanghai mutation action is not authorized");
      return;
    }
  }

  try {
    const store = getPolarisControlStore(import.meta.url);
    const policy = checkWanghaiGatewayPolicy({
      tenantId: session.tenant_id,
      vaultId: session.vault_id,
      userId: session.user_id,
      role: session.role,
      method: req.method,
      pathname: surfacePath,
      contentType: String(req.headers["content-type"] ?? ""),
      store,
    });
    if (!policy.allowed) {
      if (policy.statusCode === 429 && policy.rateLimit) {
        sendGatewayRateLimitError(res, policy.rateLimit);
        return;
      }
      sendGatewayError(res, policy.statusCode ?? 403, "Wanghai request is not authorized");
      return;
    }
    const authorizedVault = await resolveAuthorizedWanghaiVault(
      session.user_id,
      session.server_id,
    );
    if (authorizedVault.vault !== session.vault_id) {
      throw new Error("Wanghai gateway vault scope changed");
    }
    const target = resolveWanghaiGatewayTarget(authorizedVault.spec);
    const requestId = randomUUID();
    const requestUrl = resolveWanghaiUpstreamUrl(req.url, target);
    if (!mutationMatch) {
      const assertion = issueRequestAssertion({ session, requestId });
      await proxyWanghaiRequest(
        req,
        res,
        target,
        requestUrl,
        assertion,
        requestId,
        policy.rateLimit,
      );
      return;
    }

    const requestBody = await readBoundedWanghaiMutationBody(
      req,
      maxWanghaiMutationBodyBytes(mutationMatch.action),
    );
    const admission = prepareWanghaiMutationAdmission({
      match: mutationMatch,
      body: requestBody,
      contentType: requestHeaderValue(req, "content-type"),
      idempotencyKey: requestHeaderValue(req, "idempotency-key"),
      expectedVersion: requestHeaderValue(req, "x-polaris-expected-version"),
      query: url.searchParams.entries(),
      tenantId: session.tenant_id,
      vaultId: session.vault_id,
      userId: session.user_id,
    });
    const begun = store.beginIdempotencyFingerprint(
      admission.idempotencyScope,
      admission.idempotencyKey,
      admission.requestHash,
    );
    if (begun === "existing") {
      const existing = store.readIdempotencyResponse(
        admission.idempotencyScope,
        admission.idempotencyKey,
      );
      if (existing?.response) {
        replayWanghaiMutationResponse(res, requestId, existing.response, policy.rateLimit);
        return;
      }
      sendGatewayError(res, 409, "Wanghai mutation is already in progress", {
        ...(policy.rateLimit ? gatewayRateLimitHeaders(policy.rateLimit) : {}),
      });
      return;
    }

    if (!store.acquireWorkspaceLock({
      tenantId: session.tenant_id,
      vaultId: session.vault_id,
      workspaceId: admission.workspaceId,
      owner: requestId,
      leaseMs: WANGHAI_WORKSPACE_LEASE_MS,
    })) {
      const payload = gatewayErrorPayload("Another Wanghai workspace mutation is in progress");
      store.failIdempotencyResponse(admission.idempotencyScope, admission.idempotencyKey, {
        statusCode: 409,
        contentType: "application/json; charset=utf-8",
        body: payload,
      });
      replayWanghaiMutationResponse(res, requestId, {
        statusCode: 409,
        contentType: "application/json; charset=utf-8",
        body: payload,
      }, policy.rateLimit);
      return;
    }

    try {
      let quotaAudit: WanghaiQuotaAudit;
      let quotaReservationId: string;
      try {
        const limitBytes = activeWorkspaceQuotaBytes();
        const measuredUsageBytes = await measureWanghaiWorkspaceUsage({
          session,
          targetOrigin: target,
        });
        const estimatedBytes = estimateWanghaiWorkspaceGrowth({
          admission,
          measuredUsageBytes,
          requestBodyBytes: requestBody.byteLength,
        });
        quotaAudit = {
          admission,
          estimatedBytes,
          limitBytes,
          measuredUsageBytes,
          requestId,
          session,
        };
        const reservation = store.reserveQuota({
          tenantId: session.tenant_id,
          vaultId: session.vault_id,
          category: "active_workspace",
          action: admission.action.id,
          idempotencyScope: admission.idempotencyScope,
          idempotencyKey: admission.idempotencyKey,
          limitBytes,
          measuredUsageBytes,
          reservedBytes: estimatedBytes,
          leaseMs: WANGHAI_WORKSPACE_LEASE_MS,
        });
        if (!reservation.allowed || !reservation.reservation) {
          try {
            recordWanghaiQuotaAudit(quotaAudit, "reservation.denied");
          } catch {
            throw new WanghaiWorkspaceQuotaError("Wanghai quota audit is unavailable", 503);
          }
          const payload = gatewayErrorPayload("Wanghai workspace quota is exhausted");
          store.failIdempotencyResponse(admission.idempotencyScope, admission.idempotencyKey, {
            statusCode: 507,
            contentType: "application/json; charset=utf-8",
            body: payload,
          });
          replayWanghaiMutationResponse(res, requestId, {
            statusCode: 507,
            contentType: "application/json; charset=utf-8",
            body: payload,
          }, policy.rateLimit);
          return;
        }
        quotaReservationId = reservation.reservation.id;
        try {
          recordWanghaiQuotaAudit(quotaAudit, "reservation.accepted");
        } catch {
          store.releaseQuotaReservation(quotaReservationId);
          throw new WanghaiWorkspaceQuotaError("Wanghai quota audit is unavailable", 503);
        }
      } catch {
        try {
          store.recordAudit({
            actorId: session.user_id,
            tenantId: session.tenant_id,
            vaultId: session.vault_id,
            action: "wanghai.surface.quota.admission.failed",
            requestId,
            outcome: "failure",
            metadata: { action: admission.action.id, category: "active_workspace" },
          });
        } catch {
          // Preserve the idempotency result even when the audit store needs repair.
        }
        const payload = gatewayErrorPayload("Wanghai workspace quota is unavailable");
        store.failIdempotencyResponse(admission.idempotencyScope, admission.idempotencyKey, {
          statusCode: 503,
          contentType: "application/json; charset=utf-8",
          body: payload,
        });
        replayWanghaiMutationResponse(res, requestId, {
          statusCode: 503,
          contentType: "application/json; charset=utf-8",
          body: payload,
        }, policy.rateLimit);
        return;
      }

      const audit: WanghaiMutationAudit = {
        admission,
        category: policy.category,
        method: String(req.method ?? "GET").toUpperCase(),
        requestId,
        route: wanghaiAuditRoute(surfacePath),
        session,
      };
      // This must succeed before a mutable request reaches the surface. The
      // completion record below is persisted under the same idempotency key.
      let assertion: string;
      try {
        assertion = issueRequestAssertion({
          session,
          requestId,
          admission: wanghaiAssertionAdmission(admission, quotaReservationId),
        });
        recordWanghaiMutationAudit(audit, "accepted");
      } catch {
        store.releaseQuotaReservation(quotaReservationId);
        const payload = gatewayErrorPayload("Wanghai mutation audit is unavailable");
        store.failIdempotencyResponse(admission.idempotencyScope, admission.idempotencyKey, {
          statusCode: 503,
          contentType: "application/json; charset=utf-8",
          body: payload,
        });
        replayWanghaiMutationResponse(res, requestId, {
          statusCode: 503,
          contentType: "application/json; charset=utf-8",
          body: payload,
        }, policy.rateLimit);
        return;
      }
      await proxyWanghaiRequest(
        req,
        res,
        target,
        requestUrl,
        assertion,
        requestId,
        policy.rateLimit,
        requestBody,
        {
          admission,
          store,
          quota: {
            audit: quotaAudit,
            reservationId: quotaReservationId,
            session,
            targetOrigin: target,
          },
        },
        audit,
      );
    } finally {
      store.releaseWorkspaceLock(
        session.tenant_id,
        session.vault_id,
        admission.workspaceId,
        requestId,
      );
    }
  } catch (error) {
    if (error instanceof WanghaiMutationAdmissionError) {
      sendGatewayError(res, error.statusCode, error.message);
      return;
    }
    if (error instanceof WanghaiGatewayPolicyError) {
      sendGatewayError(res, error.statusCode, error.message);
      return;
    }
    if (error instanceof PortalAuthError) {
      sendGatewayError(res, error.statusCode, "Wanghai vault is not authorized");
      return;
    }
    if (error instanceof Error && error.message === "Idempotency key was reused with a different request") {
      sendGatewayError(res, 409, "Wanghai idempotency key was reused with a different request");
      return;
    }
    sendGatewayError(
      res,
      502,
      "Wanghai portal is unavailable",
    );
  }
}

async function handleWanghaiLaunch(
  req: IncomingMessage,
  res: ServerResponse,
  wanghaiId: string,
): Promise<void> {
  const session = await requirePortalSession(req, res);
  if (!session || !requireMappedPortalSession(res, session)) {
    return;
  }
  if (!sessionCanUseWanghai(session)) {
    sendJson(res, 403, { error: "The vertical product line is not enabled for this user" });
    return;
  }
  const authorizedVault = await resolveAuthorizedWanghaiVault(session.polarisUserId, wanghaiId);
  const launch = createWanghaiGatewayLaunch({
    session,
    serverId: wanghaiId,
    vaultId: authorizedVault.vault,
  });
  sendJson(res, 200, { portalUrl: launch.portalUrl });
}

function isApiPath(segments: string[]): boolean {
  return segments[0] === "api";
}

export function createPortalServer(port = 8787, host = "127.0.0.1"): Server {
  const allowedOrigins = configuredPortalOrigins();
  const workflowControl = new WorkflowControlService({
    importMetaUrl: import.meta.url,
    listPacks: listPortalDomainPacks,
    listVaults: listPortalWorkflowVaults,
  });
  const unregisterWorkflowProvisionHook = registerWorkflowProvisionHook((tenantId, vaultId) => {
    void workflowControl.notifyProvisioned(tenantId, vaultId).catch((error) => {
      process.emitWarning(
        error instanceof Error ? error.message : String(error),
        "workflow-provision-notification",
      );
    });
  });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (req.method === "GET" || req.method === "HEAD") {
        if (url.pathname === "/healthz") {
          sendProcessProbe(res, req.method, "ok");
          return;
        }
        if (url.pathname === "/readyz") {
          sendProcessProbe(res, req.method, "ready");
          return;
        }
      }
      if (isPolarisGatewayPath(url.pathname)) {
        await handleWanghaiGatewayPath(req, res, url);
        return;
      }
      const segments = routeSegments(url);
      if (req.method === "OPTIONS" && isApiPath(segments)) {
        if (!applyPortalCorsHeaders(req, res, allowedOrigins)) {
          sendJson(res, 403, { error: "Origin is not allowed" });
          return;
        }
        res.writeHead(204);
        res.end();
        return;
      }

      const hasAllowedOrigin = isApiPath(segments)
        && applyPortalCorsHeaders(req, res, allowedOrigins);
      if (
        isApiPath(segments)
        && isUnsafeMethod(req.method)
        && requestUsesCookieBackedPortalSession(req)
        && !hasAllowedOrigin
      ) {
        sendJson(res, 403, { error: "Portal request failed CSRF validation" });
        return;
      }

      if (segments.length === 1 && segments[0] === "api" && req.method === "GET") {
        sendJson(res, 200, {
          service: "polaris-portal-api",
          authMode: resolvePortalAuthMode(),
          vaultMode: resolvePolarisVaultMode(),
          endpoints: [
            "/api/users",
            "/api/users/:userId",
            "/api/users/:userId/vaults",
            "/api/users/:userId/vaults/:vaultName",
            "/api/users/:userId/vaults/:vaultName/backups",
            "/api/users/:userId/vaults/:vaultName/backups/:backupJobId/restore",
            "/api/users/:userId/vaults/:vaultName/restores/:restoreJobId/activate",
            "/api/users/:userId/vaults/:vaultName/restore-activations/:activationJobId/rollback",
            "/api/users/:userId/credentials",
            "/api/domain-packs",
            "/api/domain-packs/:packId/:flowId/graph",
            "/api/tools",
            "/api/workflow-vaults",
            "/api/workflow-setup",
            "/api/workflow-runs",
            "/api/workflow-runs/:runId/events",
            "/api/workflow-suggestions",
          ],
        });
        return;
      }

      if (isApiPath(segments)) {
        if (isPolarisGatewayLaunchRoute(segments) && req.method === "POST") {
          await handleWanghaiLaunch(req, res, decodeURIComponent(segments[2]));
          return;
        }
        if (segments.length === 2 && segments[1] === "authing-config" && req.method === "GET") {
          const authMode = resolvePortalAuthMode();
          sendJson(res, 200, {
            authMode,
            vaultMode: resolvePolarisVaultMode(),
            appId: String(process.env.POLARIS_AUTHING_APP_ID ?? "").trim(),
            authorizationUrl: String(process.env.POLARIS_AUTHING_AUTHORIZATION_URL ?? "").trim(),
            redirectUri: String(process.env.POLARIS_AUTHING_REDIRECT_URI ?? "").trim(),
            logoutUrl: String(process.env.POLARIS_AUTHING_LOGOUT_URL ?? "").trim(),
            logoutRedirectUri: String(process.env.POLARIS_AUTHING_LOGOUT_REDIRECT_URI ?? "").trim(),
            paseoAppBaseUrl: String(process.env.POLARIS_PASEO_APP_BASE_URL ?? "").trim(),
            signInUrl: authMode === "oauth2-proxy" ? "/oauth2/start" : "",
            signOutUrl: authMode === "oauth2-proxy" ? "/oauth2/sign_out" : "",
          });
          return;
        }
        if (segments.length === 3 && segments[1] === "auth" && segments[2] === "callback") {
          if (req.method !== "POST") {
            notFound(res);
            return;
          }
          const body = await readBody(req);
          const code = body.code?.trim() || "";
          const codeVerifier = body.codeVerifier?.trim() || "";
          const redirectUri = body.redirectUri?.trim() || "";
          if (!code || !codeVerifier || !redirectUri) {
            badRequest(res, "Missing Authing authorization callback values");
            return;
          }
          const result = await exchangeAuthingAuthorizationCode({
            code,
            codeVerifier,
            redirectUri,
          });
          sendJson(res, 200, result);
          return;
        }
        if (segments.length === 2 && segments[1] === "users") {
          if (req.method === "POST") {
            await handleUserCreate(req, res);
            return;
          }
          const session = await requirePortalSession(req, res);
          if (!session || !requireMappedPortalSession(res, session)) {
            return;
          }
          sendJson(
            res,
            200,
            session.role === "admin"
              ? listPortalProfiles()
              : listPortalProfiles().filter((profile) => profile.id === session.polarisUserId),
          );
          return;
        }
        if (segments.length === 3 && segments[1] === "users" && req.method === "DELETE") {
          const session = await requirePortalSession(req, res);
          if (!session || !requirePortalAdmin(res, session)) {
            return;
          }
          if (session.polarisUserId === decodeURIComponent(segments[2])) {
            sendJson(res, 403, { error: "The current admin cannot delete their own Polaris user" });
            return;
          }
          await handleUserDelete(res, decodeURIComponent(segments[2]));
          return;
        }
        if (segments.length === 2 && segments[1] === "user-mapping" && req.method === "GET") {
          const session = await requirePortalSession(req, res);
          if (!session) {
            return;
          }
          const authingUsername = url.searchParams.get("authingUsername")?.trim() || "";
          const authingUserId = url.searchParams.get("authingUserId")?.trim() || "";
          if (!sessionMatchesCurrentIdentity(session, { authingUsername, authingUserId })) {
            sendJson(res, 403, { error: "The requested mapping does not match the authenticated Authing identity" });
            return;
          }
          sendJson(res, 200, {
            authingUsername: session.authingUsername ?? "",
            authingUserId: session.authingUserId,
            mapping: session.authingUserId || session.authingUsername
              ? findUserMapEntry({
                authingUserId: session.authingUserId,
                ...(session.authingUsername ? { authingUsername: session.authingUsername } : {}),
              })
              : null,
          });
          return;
        }
        if (segments.length === 3 && segments[1] === "admin" && segments[2] === "users" && req.method === "GET") {
          const session = await requirePortalSession(req, res);
          if (!session || !requirePortalAdmin(res, session)) {
            return;
          }
          sendJson(res, 200, {
            users: listPortalAdminUsers(),
          });
          return;
        }
        if (segments[1] === "session") {
          const session = await requirePortalSession(req, res);
          if (!session) {
            return;
          }
          sendJson(res, 200, {
            authMode: session.authMode,
            vaultMode: resolvePolarisVaultMode(),
            authenticated: true,
            authingUserId: session.authingUserId,
            authingUsername: session.authingUsername,
            polarisUserId: session.polarisUserId,
            role: session.role,
            plan: session.plan,
            line: session.line,
          });
          return;
        }
        if (segments[1] === "polaris-hosts") {
          const session = await requirePortalSession(req, res);
          if (!session || !requireMappedPortalSession(res, session)) {
            return;
          }
          const userId = session.polarisUserId;
          if (segments.length === 2 && req.method === "GET") {
            sendJson(res, 200, {
              hosts: await listPortalVaults(userId),
            });
            return;
          }
          if (segments.length === 2 && req.method === "POST") {
            const body = await readBody(req);
            const hostName = body.hostName?.trim();
            if (!hostName) {
              badRequest(res, "hostName is required");
              return;
            }
            try {
              assertProjectNameAvailableForUser(hostName, userId);
            } catch (error) {
              sendJson(res, 409, {
                error: error instanceof Error ? error.message : String(error),
              });
              return;
            }
            if ((await listPortalVaults(userId)).some((entry) => entry.name === hostName)) {
              sendJson(res, 409, { error: `Host '${hostName}' already exists.` });
              return;
            }
            let requestedLine: "coding" | "vertical";
            try {
              requestedLine = resolveRequestedVaultLine({
                requested: body.line,
                accessLine: session.line,
              });
            } catch (error) {
              sendJson(res, 403, { error: error instanceof Error ? error.message : String(error) });
              return;
            }
            const provision = await queueProvisionVault(userId, hostName, {
              defaultDockerOnly: true,
              startAfterCreate: true,
              line: requestedLine,
            });
            sendJson(res, 202, provision);
            return;
          }
          if (segments.length === 3) {
            const hostName = decodeURIComponent(segments[2]);
            if (req.method === "DELETE") {
              await handleVaultDelete(res, userId, hostName);
              return;
            }
            if (req.method === "POST") {
              const body = await readBody(req);
              if (body.action === "start") {
                await handleVaultStart(res, userId, hostName);
                return;
              }
              if (body.action === "stop") {
                await handleVaultStop(res, userId, hostName);
                return;
              }
              if (body.action === "delete") {
                await handleVaultPermanentDelete(res, userId, hostName);
                return;
              }
            }
          }
          notFound(res);
          return;
        }
        if (segments.length === 2 && segments[1] === "polaris-user" && req.method === "GET") {
          const session = await requirePortalSession(req, res);
          if (!session || !requireMappedPortalSession(res, session)) {
            return;
          }
          const userId = session.polarisUserId;
          sendJson(res, 200, {
            profile: readPortalProfile(userId),
            session: {
              userId,
              authingUserId: session.authingUserId,
              authingUsername: session.authingUsername,
              authingPhoneNumber: session.authingPhoneNumber,
              role: session.role,
              plan: session.plan,
              line: session.line,
            },
            credentials: listUserPortalCredentials(userId),
          });
          return;
        }
        if (segments.length === 2 && segments[1] === "domain-packs" && req.method === "GET") {
          const session = await requirePortalSession(req, res);
          if (!session || !requireMappedPortalSession(res, session)) {
            return;
          }
          sendJson(res, 200, { packs: listPortalDomainPacks() });
          return;
        }
        if (
          segments.length === 5
          && segments[1] === "domain-packs"
          && segments[4] === "graph"
          && req.method === "GET"
        ) {
          const session = await requirePortalSession(req, res);
          if (!session || !requireMappedPortalSession(res, session)) return;
          try {
            sendJson(res, 200, {
              graph: getDomainPackFlowGraphProjection(
                import.meta.url,
                decodeURIComponent(segments[2] ?? ""),
                decodeURIComponent(segments[3] ?? ""),
              ),
            });
          } catch (error) {
            throw new WorkflowControlError(
              error instanceof Error ? error.message : String(error),
              404,
              "workflow-graph-not-found",
            );
          }
          return;
        }
        if (segments.length >= 2 && segments[1] === "workflow-vaults") {
          const session = await requirePortalSession(req, res);
          if (!session || !requireMappedPortalSession(res, session)) {
            return;
          }
          if (segments.length === 2 && req.method === "GET") {
            sendJson(res, 200, { vaults: await listPortalWorkflowVaults(session.polarisUserId) });
            return;
          }
          notFound(res);
          return;
        }
        if (segments.length === 2 && segments[1] === "tools" && req.method === "GET") {
          const session = await requirePortalSession(req, res);
          if (!session || !requireMappedPortalSession(res, session)) {
            return;
          }
          sendJson(res, 200, evaluatePortalToolStatus(import.meta.url));
          return;
        }
        if (segments.length >= 2 && segments[1] === "workflow-setup") {
          const session = await requirePortalSession(req, res);
          if (!session || !requireMappedPortalSession(res, session)) {
            return;
          }
          const userId = session.polarisUserId;
          if (segments.length === 2 && req.method === "GET") {
            sendJson(res, 200, workflowControl.getSetup(userId));
            return;
          }
          if (segments.length === 2 && req.method === "PUT") {
            sendJson(res, 200, {
              setup: await workflowControl.saveSetup(userId, parseWorkflowSetupRequest(await readBody(req))),
            });
            return;
          }
          notFound(res);
          return;
        }
        if (segments.length >= 2 && segments[1] === "workflow-runs") {
          const session = await requirePortalSession(req, res);
          if (!session || !requireMappedPortalSession(res, session)) {
            return;
          }
          const userId = session.polarisUserId;
          if (segments.length === 2 && req.method === "GET") {
            sendJson(res, 200, await workflowControl.listRuns(userId));
            return;
          }
          if (segments.length === 2 && req.method === "POST") {
            const run = await workflowControl.createRun(
              userId,
              parseWorkflowRunRequest(await readBody(req), requestHeader(req, "idempotency-key")),
            );
            sendJson(res, 202, { run });
            return;
          }
          if (segments.length === 3 && req.method === "GET") {
            sendJson(res, 200, {
              run: await workflowControl.getRun(userId, decodeURIComponent(segments[2] ?? "")),
            });
            return;
          }
          if (segments.length === 3 && req.method === "DELETE") {
            await workflowControl.deleteRun(userId, decodeURIComponent(segments[2] ?? ""));
            res.writeHead(204);
            res.end();
            return;
          }
          if (segments.length === 5 && (req.method === "GET" || req.method === "HEAD") && segments[3] === "artifacts") {
            sendWorkflowArtifact(
              res,
              workflowControl,
              userId,
              decodeURIComponent(segments[2] ?? ""),
              decodeURIComponent(segments[4] ?? ""),
              req.method,
            );
            return;
          }
          if (segments.length === 4 && (req.method === "GET" || req.method === "HEAD") && segments[3] === "files") {
            sendWorkflowWorkspaceFile(
              res,
              workflowControl,
              userId,
              decodeURIComponent(segments[2] ?? ""),
              url.searchParams.get("path") ?? "",
              req.method,
            );
            return;
          }
          if (segments.length === 4 && req.method === "GET" && segments[3] === "events") {
            const runId = decodeURIComponent(segments[2] ?? "");
            const after = Number(url.searchParams.get("after") ?? "0");
            sendJson(res, 200, await workflowControl.events(userId, runId, after));
            return;
          }
          if (segments.length === 4 && req.method === "POST") {
            const runId = decodeURIComponent(segments[2] ?? "");
            const action = segments[3];
            if (action === "approve") {
              sendJson(res, 200, { run: await workflowControl.approve(userId, runId) });
              return;
            }
            if (action === "cancel") {
              sendJson(res, 200, { run: await workflowControl.cancel(userId, runId) });
              return;
            }
            if (action === "retry") {
              const body = await readBody(req);
              sendJson(res, 202, {
                run: await workflowControl.retry(userId, runId, parseWorkflowScenario(body.scenario) ?? "normal"),
              });
              return;
            }
          }
          notFound(res);
          return;
        }
        if (segments.length >= 2 && segments[1] === "workflow-suggestions") {
          const session = await requirePortalSession(req, res);
          if (!session || !requireMappedPortalSession(res, session)) {
            return;
          }
          const userId = session.polarisUserId;
          if (segments.length === 2 && req.method === "GET") {
            sendJson(res, 200, { suggestions: workflowControl.listSuggestions(userId) });
            return;
          }
          if (segments.length === 2 && req.method === "POST") {
            const body = await readBody(req);
            const runId = body.runId?.trim() || "";
            if (!runId) throw new PortalRequestError("runId is required", 400);
            sendJson(res, 201, {
              suggestion: await workflowControl.createSuggestion(userId, runId),
            });
            return;
          }
          notFound(res);
          return;
        }
        if (
          segments.length === 4
          && segments[1] === "users"
          && segments[3] === "access"
          && req.method === "PUT"
        ) {
          const session = await requirePortalSession(req, res);
          if (!session || !requirePortalAdmin(res, session)) {
            return;
          }
          await handleUserAccessUpdate(req, res, decodeURIComponent(segments[2]));
          return;
        }
        if (segments[1] !== "users" || segments.length < 4) {
          notFound(res);
          return;
        }
        const session = await requirePortalSession(req, res);
        if (!session) {
          return;
        }
        const routeUserId = decodeURIComponent(segments[2]);
        if (!requirePortalScope(res, session, routeUserId)) {
          return;
        }
        const profile = requireProfile(res, routeUserId);
        if (!profile) {
          return;
        }
        if (segments.length === 5 && segments[3] === "vaults" && segments[4] === "static" && req.method === "GET") {
          const vaults = await listPortalVaultStaticState(routeUserId);
          sendJson(res, 200, {
            user: profile,
            vaults,
          });
          return;
        }
        if (segments.length === 5 && segments[3] === "vaults" && segments[4] === "live" && req.method === "GET") {
          await handleVaultLiveStream(req, res, routeUserId);
          return;
        }
        const vault = decodeURIComponent(segments[4] ?? "");
        if (segments.length === 4 && segments[3] === "vaults" && req.method === "GET") {
          const vaults = await listPortalVaults(routeUserId);
          sendJson(res, 200, {
            user: profile,
            vaults,
          });
          return;
        }
        if (segments[3] === "profile" && segments.length === 4 && req.method === "GET") {
          sendJson(res, 200, readPortalProfile(routeUserId));
          return;
        }
        if (segments[3] === "profile" && segments.length === 4 && req.method === "POST") {
          await handleProfileUpdate(req, res, routeUserId);
          return;
        }
        if (segments[3] === "credentials" && segments.length === 4) {
          if (req.method === "POST") {
            await handleCredentialCreate(req, res, routeUserId);
            return;
          }
          sendJson(res, 200, {
            user: profile,
            credentials: listUserPortalCredentials(routeUserId),
          });
          return;
        }
        if (segments[3] === "skills" && segments.length === 4) {
          if (req.method === "POST") {
            await handleSkillCreate(req, res, routeUserId);
            return;
          }
          sendJson(res, 200, {
            user: profile,
            skills: listUserPortalSkills(routeUserId),
          });
          return;
        }
        if (segments[3] === "skills" && segments.length === 5 && req.method === "DELETE") {
          const skillId = decodeURIComponent(segments[4]);
          sendJson(res, 200, await deletePortalSkill(routeUserId, skillId));
          return;
        }
        if (segments[3] === "credentials" && segments.length === 5 && segments[4] === "catalog" && req.method === "GET") {
          sendJson(res, 200, getPortalCredentialCatalog());
          return;
        }
        if (segments[3] === "credentials" && segments.length === 5 && req.method === "DELETE") {
          const credentialId = decodeURIComponent(segments[4]);
          await handleCredentialDelete(res, routeUserId, credentialId);
          return;
        }
        if (segments[3] === "credentials" && segments.length === 5 && req.method === "GET") {
          const credentialId = decodeURIComponent(segments[4]);
          sendJson(res, 200, readUserPortalCredentialRecord(routeUserId, credentialId));
          return;
        }
        if (segments[3] === "credentials" && segments.length === 6 && segments[5] === "activate" && req.method === "POST") {
          const credentialId = decodeURIComponent(segments[4]);
          await handleCredentialActivate(res, routeUserId, credentialId);
          return;
        }
        if (segments[3] === "credentials" && segments.length === 7 && segments[5] === "files" && req.method === "PUT") {
          const credentialId = decodeURIComponent(segments[4]);
          const fileKey = decodeURIComponent(segments[6]);
          await handleCredentialWrite(req, res, routeUserId, credentialId, fileKey);
          return;
        }
        if (segments[3] === "vaults" && segments.length === 6 && segments[5] === "detail" && req.method === "GET") {
          sendJson(res, 200, await getPortalVaultDetailStatic(routeUserId, vault));
          return;
        }
        if (segments[3] === "vaults" && segments.length === 5 && req.method === "GET") {
          sendJson(res, 200, await getPortalVaultDetail(routeUserId, vault));
          return;
        }
        if (segments[3] === "vaults" && segments.length === 6 && segments[5] === "preview" && req.method === "GET") {
          const assetPath = url.searchParams.get("path")?.trim() || "";
          if (!assetPath) {
            badRequest(res, "path is required");
            return;
          }
          handleVaultPreview(res, routeUserId, vault, assetPath);
          return;
        }
        if (segments[3] === "vaults" && segments.length === 5 && req.method === "DELETE") {
          await handleVaultDelete(res, routeUserId, vault);
          return;
        }
        if (segments[3] === "vaults" && segments.length === 6 && segments[5] === "switch" && req.method === "POST") {
          await handleVaultSwitch(req, res, routeUserId, vault);
          return;
        }
        if (segments[3] === "vaults" && segments.length === 6 && segments[5] === "driver" && req.method === "POST") {
          await handleVaultSelectedDriverUpdate(req, res, routeUserId, vault);
          return;
        }
        if (segments[3] === "vaults" && segments.length === 6 && segments[5] === "stop" && req.method === "POST") {
          await handleVaultStop(res, routeUserId, vault);
          return;
        }
        if (segments[3] === "vaults" && segments.length === 6 && segments[5] === "start" && req.method === "POST") {
          await handleVaultStart(res, routeUserId, vault);
          return;
        }
        if (segments[3] === "vaults" && segments.length === 6 && segments[5] === "rebuild" && req.method === "POST") {
          await handleVaultRebuild(res, routeUserId, vault);
          return;
        }
        if (segments[3] === "vaults" && segments.length === 6 && segments[5] === "refresh" && req.method === "POST") {
          await handleVaultRefresh(res, routeUserId, vault);
          return;
        }
        if (segments[3] === "vaults" && segments.length === 7 && segments[5] === "paseo" && segments[6] === "status" && req.method === "GET") {
          await handleVaultPaseoStatus(res, routeUserId, vault);
          return;
        }
        if (segments[3] === "vaults" && segments.length === 7 && segments[5] === "paseo" && segments[6] === "restart" && req.method === "POST") {
          await handleVaultPaseoRestart(res, routeUserId, vault);
          return;
        }
        if (
          segments[3] === "vaults" &&
          segments.length === 8 &&
          segments[5] === "paseo" &&
          segments[6] === "credentials" &&
          segments[7] === "switch" &&
          req.method === "POST"
        ) {
          await handleVaultLiveCredentialSwitch(req, res, routeUserId, vault);
          return;
        }
        if (
          segments[3] === "vaults" &&
          segments.length === 7 &&
          segments[5] === "skills"
        ) {
          if (segments[6] === "list" && req.method === "POST") {
            await handleVaultSkillAction(req, res, routeUserId, vault, "list");
            return;
          }
          if (segments[6] === "install" && req.method === "POST") {
            await handleVaultSkillAction(req, res, routeUserId, vault, "install");
            return;
          }
          if (segments[6] === "uninstall" && req.method === "POST") {
            await handleVaultSkillAction(req, res, routeUserId, vault, "uninstall");
            return;
          }
          if (segments[6] === "sync" && req.method === "POST") {
            await handleVaultSkillAction(req, res, routeUserId, vault, "sync");
            return;
          }
        }
        if (segments[3] === "vaults" && segments.length === 6 && segments[5] === "provision" && req.method === "POST") {
          const body = await readBody(req);
          let requestedLine: "coding" | "vertical" | undefined;
          if (session.polarisUserId === routeUserId) {
            try {
              requestedLine = resolveRequestedVaultLine({
                requested: body.line,
                accessLine: session.line,
              });
            } catch (error) {
              sendJson(res, 403, { error: error instanceof Error ? error.message : String(error) });
              return;
            }
          }
          await handleVaultProvision(
            req,
            res,
            routeUserId,
            vault,
            requestedLine,
            body,
          );
          return;
        }
        if (
          segments[3] === "vaults"
          && segments.length === 8
          && segments[5] === "backups"
          && segments[7] === "restore"
        ) {
          if (!sessionCanUseWanghai(session)) {
            sendJson(res, 403, { error: "Wanghai access is not enabled for this account" });
            return;
          }
          if (req.method === "POST") {
            await handleWanghaiRestoreSubmit(req, res, {
              actorId: session.polarisUserId ?? routeUserId,
              userId: routeUserId,
              vault,
              sourceBackupJobId: decodeURIComponent(segments[6]),
            });
            return;
          }
          notFound(res);
          return;
        }
        if (
          segments[3] === "vaults"
          && segments.length === 8
          && segments[5] === "restores"
          && segments[7] === "activate"
        ) {
          if (!sessionCanUseWanghai(session)) {
            sendJson(res, 403, { error: "Wanghai access is not enabled for this account" });
            return;
          }
          if (req.method === "POST") {
            await handleWanghaiRestoreActivationSubmit(req, res, {
              actorId: session.polarisUserId ?? routeUserId,
              userId: routeUserId,
              vault,
              restoreJobId: decodeURIComponent(segments[6]),
            });
            return;
          }
          notFound(res);
          return;
        }
        if (
          segments[3] === "vaults"
          && segments.length === 8
          && segments[5] === "restore-activations"
          && segments[7] === "rollback"
        ) {
          if (!sessionCanUseWanghai(session)) {
            sendJson(res, 403, { error: "Wanghai access is not enabled for this account" });
            return;
          }
          if (req.method === "POST") {
            await handleWanghaiRestoreRollbackSubmit(req, res, {
              actorId: session.polarisUserId ?? routeUserId,
              userId: routeUserId,
              vault,
              activationJobId: decodeURIComponent(segments[6]),
            });
            return;
          }
          notFound(res);
          return;
        }
        if (segments[3] === "vaults" && segments.length === 6 && segments[5] === "backups") {
          if (!sessionCanUseWanghai(session)) {
            sendJson(res, 403, { error: "Wanghai access is not enabled for this account" });
            return;
          }
          if (req.method === "POST") {
            await handleWanghaiBackupSubmit(req, res, {
              actorId: session.polarisUserId ?? routeUserId,
              userId: routeUserId,
              vault,
            });
            return;
          }
          notFound(res);
          return;
        }
        if (segments[3] === "vaults" && segments.length === 7 && segments[5] === "backups") {
          if (!sessionCanUseWanghai(session)) {
            sendJson(res, 403, { error: "Wanghai access is not enabled for this account" });
            return;
          }
          const jobId = decodeURIComponent(segments[6]);
          if (req.method === "GET") {
            handleWanghaiBackupRead(res, {
              userId: routeUserId,
              vault,
              jobId,
            });
            return;
          }
          if (req.method === "DELETE") {
            handleWanghaiBackupCancellation(res, {
              actorId: session.polarisUserId ?? routeUserId,
              userId: routeUserId,
              vault,
              jobId,
            });
            return;
          }
          notFound(res);
          return;
        }
        if (segments[3] === "vaults" && segments.length === 7 && segments[5] === "restores") {
          if (!sessionCanUseWanghai(session)) {
            sendJson(res, 403, { error: "Wanghai access is not enabled for this account" });
            return;
          }
          const jobId = decodeURIComponent(segments[6]);
          if (req.method === "GET") {
            handleWanghaiRestoreRead(res, {
              userId: routeUserId,
              vault,
              jobId,
            });
            return;
          }
          if (req.method === "DELETE") {
            handleWanghaiRestoreCancellation(res, {
              actorId: session.polarisUserId ?? routeUserId,
              userId: routeUserId,
              vault,
              jobId,
            });
            return;
          }
          notFound(res);
          return;
        }
        if (
          segments[3] === "vaults"
          && segments.length === 7
          && segments[5] === "restore-activations"
        ) {
          if (!sessionCanUseWanghai(session)) {
            sendJson(res, 403, { error: "Wanghai access is not enabled for this account" });
            return;
          }
          const jobId = decodeURIComponent(segments[6]);
          if (req.method === "GET") {
            handleWanghaiRestoreActivationRead(res, {
              userId: routeUserId,
              vault,
              jobId,
            });
            return;
          }
          if (req.method === "DELETE") {
            handleWanghaiRestoreActivationCancellation(res, {
              actorId: session.polarisUserId ?? routeUserId,
              userId: routeUserId,
              vault,
              jobId,
            });
            return;
          }
          notFound(res);
          return;
        }
        if (
          segments[3] === "vaults"
          && segments.length === 7
          && segments[5] === "restore-rollbacks"
        ) {
          if (!sessionCanUseWanghai(session)) {
            sendJson(res, 403, { error: "Wanghai access is not enabled for this account" });
            return;
          }
          const jobId = decodeURIComponent(segments[6]);
          if (req.method === "GET") {
            handleWanghaiRestoreRollbackRead(res, {
              userId: routeUserId,
              vault,
              jobId,
            });
            return;
          }
          if (req.method === "DELETE") {
            handleWanghaiRestoreRollbackCancellation(res, {
              actorId: session.polarisUserId ?? routeUserId,
              userId: routeUserId,
              vault,
              jobId,
            });
            return;
          }
          notFound(res);
          return;
        }
        if (segments[3] === "vaults" && segments.length === 4 && req.method === "POST") {
          const body = await readBody(req);
          const vaultName = body.vaultName?.trim();
          if (!vaultName) {
            badRequest(res, "vaultName is required");
            return;
          }
          try {
            assertProjectNameAvailableForUser(vaultName, routeUserId);
          } catch (error) {
            sendJson(res, 409, {
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          if ((await listPortalVaults(routeUserId)).some((entry) => entry.name === vaultName)) {
            sendJson(res, 409, {
              error: `Vault '${vaultName}' already exists for user ${routeUserId}.`,
            });
            return;
          }
          let requestedLine: "coding" | "vertical" | undefined;
          if (session.polarisUserId === routeUserId) {
            try {
              requestedLine = resolveRequestedVaultLine({
                requested: body.line,
                accessLine: session.line,
              });
            } catch (error) {
              sendJson(res, 403, { error: error instanceof Error ? error.message : String(error) });
              return;
            }
          }
          const provision = await queueProvisionVault(routeUserId, vaultName, {
            defaultDockerOnly: body.defaultDockerOnly === "true",
            startAfterCreate: body.startAfterCreate === "true",
            ...(requestedLine ? { line: requestedLine } : {}),
          });
          sendJson(res, 202, provision);
          return;
        }
        notFound(res);
        return;
      }

      if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/shell/")) {
        const asset = readPortalAsset(url.pathname.slice("/shell/".length));
        if (!asset) {
          notFound(res);
          return;
        }
        sendShellAsset(res, asset.contentType, asset.body, req.method);
        return;
      }

      if ((req.method === "GET" || req.method === "HEAD") && isPortalDocumentPath(url.pathname)) {
        const document = readPortalAsset("index.html");
        if (document) {
          sendShellAsset(res, document.contentType, document.body, req.method);
          return;
        }
        sendShellAsset(res, "text/html; charset=utf-8", portalFallbackHtml(), req.method);
        return;
      }

      notFound(res);
    } catch (error) {
      const statusCode = error instanceof PortalAuthError
        ? error.statusCode
        : error instanceof PortalRequestError
          ? error.statusCode
          : error instanceof WorkflowControlError
            ? error.statusCode
          : error instanceof ActiveVaultCapacityError
            ? error.statusCode
          : error instanceof VaultModeError
            ? error.statusCode
          : 500;
      const message = error instanceof Error ? error.message : String(error);
      const isApiRequest = (req.url ?? "").startsWith("/api/");
      if (isApiRequest) {
        sendJson(res, statusCode, {
          error: message,
          ...(error instanceof WorkflowControlError ? { errorCode: error.code } : {}),
        });
        return;
      }
      sendText(res, statusCode, message);
    }
  });
  server.once("close", () => {
    unregisterWorkflowProvisionHook();
    workflowControl.close();
  });
  return server.listen(port, host);
}
