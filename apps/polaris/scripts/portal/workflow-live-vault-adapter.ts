import type { FfiRpcRequest } from "polaris-workflow";
import {
  createHash,
} from "node:crypto";
import type {
  PolarisControlStore,
  WorkflowEffectReceiptRecord,
} from "./control-store.js";
import {
  listOwnedVaults,
  listVaultDriverTargets,
  readVaultStatus,
} from "../core/portal.js";
import {
  evaluateWorkflowLiveInvocation,
  type EvaluateWorkflowLiveInvocationInput,
  type WorkflowActionCatalogEntry,
  type WorkflowLiveInvocationDecision,
} from "./workflow-live-boundary.js";

export interface WorkflowLiveVaultArtifactMetadataEntry {
  title: string;
  kind: string;
  status: string;
  whyExists?: string;
  whyRetrieved?: string[];
  curatorAction?: string;
  curatorReason?: string;
  suppressedBecause?: string;
}

export interface WorkflowLiveVaultArtifactMetadata {
  artifactCount: number;
  activeVaultArtifacts: number;
  activeUserArtifacts: number;
  latestTitles: string[];
  latestArtifacts: WorkflowLiveVaultArtifactMetadataEntry[];
  pendingMemoryChanges: number;
}

export interface WorkflowLiveVaultArtifactMetadataReaderInput {
  request: FfiRpcRequest;
  action: WorkflowActionCatalogEntry;
  decision: Extract<WorkflowLiveInvocationDecision, { allowed: true }>;
}

export type WorkflowLiveVaultArtifactMetadataReader = (
  input: WorkflowLiveVaultArtifactMetadataReaderInput,
) => Promise<unknown> | unknown;

export interface WorkflowLiveVaultArtifactMetadataInvocationInput
  extends EvaluateWorkflowLiveInvocationInput {
  readMetadata?: WorkflowLiveVaultArtifactMetadataReader;
}

export type WorkflowLiveVaultArtifactMetadataInvocationResult =
  | {
      allowed: true;
      action: WorkflowActionCatalogEntry;
      reasons: string[];
      metadata: WorkflowLiveVaultArtifactMetadata;
    }
  | {
      allowed: false;
      code: string;
      message: string;
      reasons: string[];
      action?: WorkflowActionCatalogEntry;
    };

export interface WorkflowLiveVaultArtifactMetadataDurableEvidenceInput
  extends WorkflowLiveVaultArtifactMetadataInvocationInput {
  store: PolarisControlStore;
}

const MAX_LATEST_ARTIFACTS = 5;
const MAX_LATEST_TITLES = 5;
const MAX_RETRIEVAL_REASONS = 5;
export const WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID = "vault.artifact.metadata.read";
const WORKFLOW_LIVE_VAULT_METADATA_AUDIT_ACTION = "workflow.live.vault.metadata.read";

export class WorkflowLiveVaultMetadataReadError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "WorkflowLiveVaultMetadataReadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toFiniteInteger(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return Math.floor(numeric);
}

function toStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .slice(0, limit)
    .map((entry) => String(entry).trim())
    .filter(Boolean);
}

function normalizeArtifactEntry(value: unknown): WorkflowLiveVaultArtifactMetadataEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const title = String(value.title ?? "").trim();
  const kind = String(value.kind ?? "").trim();
  const status = String(value.status ?? "").trim();
  if (!title || !kind || !status) {
    return null;
  }
  const entry: WorkflowLiveVaultArtifactMetadataEntry = {
    title,
    kind,
    status,
  };
  const whyExists = String(value.whyExists ?? "").trim();
  const whyRetrieved = toStringArray(value.whyRetrieved, MAX_RETRIEVAL_REASONS);
  const curatorAction = String(value.curatorAction ?? "").trim();
  const curatorReason = String(value.curatorReason ?? "").trim();
  const suppressedBecause = String(value.suppressedBecause ?? "").trim();
  if (whyExists) entry.whyExists = whyExists;
  if (whyRetrieved.length > 0) entry.whyRetrieved = whyRetrieved;
  if (curatorAction) entry.curatorAction = curatorAction;
  if (curatorReason) entry.curatorReason = curatorReason;
  if (suppressedBecause) entry.suppressedBecause = suppressedBecause;
  return entry;
}

export function normalizeWorkflowLiveVaultArtifactMetadata(
  value: unknown,
): WorkflowLiveVaultArtifactMetadata {
  const record = isRecord(value) ? value : {};
  return {
    artifactCount: toFiniteInteger(record.artifactCount),
    activeVaultArtifacts: toFiniteInteger(record.activeVaultArtifacts),
    activeUserArtifacts: toFiniteInteger(record.activeUserArtifacts),
    latestTitles: toStringArray(record.latestTitles, MAX_LATEST_TITLES),
    latestArtifacts: Array.isArray(record.latestArtifacts)
      ? record.latestArtifacts
        .slice(0, MAX_LATEST_ARTIFACTS)
        .map(normalizeArtifactEntry)
        .filter((entry): entry is WorkflowLiveVaultArtifactMetadataEntry => entry != null)
      : [],
    pendingMemoryChanges: toFiniteInteger(record.pendingMemoryChanges),
  };
}

function selectedTargetsMatch(
  left: { backend: string; profile?: string },
  right: { backend: string; profile?: string },
): boolean {
  return left.backend === right.backend && (left.profile ?? "") === (right.profile ?? "");
}

export function readWorkflowLiveVaultArtifactMetadata(
  input: WorkflowLiveVaultArtifactMetadataReaderInput,
): WorkflowLiveVaultArtifactMetadata {
  const tenantId = input.request.tenantId.trim();
  const vaultId = input.request.vaultId.trim();
  if (!tenantId || !vaultId) {
    throw new WorkflowLiveVaultMetadataReadError(
      "Workflow live Vault metadata requires tenant and Vault scope",
      "vault-scope-required",
    );
  }
  if (!listOwnedVaults(tenantId).includes(vaultId)) {
    throw new WorkflowLiveVaultMetadataReadError(
      "Workflow live Vault metadata requires a user-owned Vault",
      "vault-not-owned",
    );
  }
  const status = readVaultStatus(tenantId, vaultId);
  if (!status) {
    throw new WorkflowLiveVaultMetadataReadError(
      "Workflow live Vault metadata requires current Vault status",
      "vault-status-required",
    );
  }
  const selected = status.driver?.selected ?? null;
  if (!selected) {
    throw new WorkflowLiveVaultMetadataReadError(
      "Workflow live Vault metadata requires a selected Vault driver",
      "vault-driver-selected-required",
    );
  }
  if (status.driver?.status !== "running") {
    throw new WorkflowLiveVaultMetadataReadError(
      "Workflow live Vault metadata requires a running Vault",
      "vault-running-required",
    );
  }
  const selectedAvailable = listVaultDriverTargets(tenantId, vaultId).some((target) =>
    target.available && selectedTargetsMatch(target, selected)
  );
  if (!selectedAvailable) {
    throw new WorkflowLiveVaultMetadataReadError(
      "Workflow live Vault metadata requires the selected Vault driver config",
      "vault-selected-driver-config-required",
    );
  }
  return normalizeWorkflowLiveVaultArtifactMetadata(status.evolution ?? {});
}

export async function invokeWorkflowLiveVaultArtifactMetadata(
  input: WorkflowLiveVaultArtifactMetadataInvocationInput,
): Promise<WorkflowLiveVaultArtifactMetadataInvocationResult> {
  const decision = evaluateWorkflowLiveInvocation(input);
  if (!decision.allowed) {
    return decision;
  }
  if (decision.action.id !== WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID) {
    return {
      allowed: false,
      code: "workflow-vault-metadata-action-required",
      message: "Workflow live Vault metadata adapter accepts only the Vault metadata action",
      reasons: ["metadata-action-required"],
      action: decision.action,
    };
  }
  try {
    const readMetadata = input.readMetadata ?? readWorkflowLiveVaultArtifactMetadata;
    const metadata = normalizeWorkflowLiveVaultArtifactMetadata(
      await readMetadata({
        request: input.request,
        action: decision.action,
        decision,
      }),
    );
    return {
      allowed: true,
      action: decision.action,
      reasons: decision.reasons,
      metadata,
    };
  } catch (error) {
    return {
      allowed: false,
      code: "live-vault-metadata-read-failed",
      message: error instanceof Error
        ? error.message
        : "Workflow live Vault metadata read failed",
      reasons: ["metadata-read-failed"],
      action: decision.action,
    };
  }
}

function metadataDigest(metadata: WorkflowLiveVaultArtifactMetadata): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(metadata), "utf8")
    .digest("hex")}`;
}

function receiptForMetadataInvocation(input: {
  request: FfiRpcRequest;
  result: WorkflowLiveVaultArtifactMetadataInvocationResult;
  startedAt: string;
  completedAt: string;
}): WorkflowEffectReceiptRecord {
  const status = input.result.allowed ? "completed" : "failed";
  return {
    id: `receipt-${input.request.requestId}`,
    runId: input.request.runId,
    tenantId: input.request.tenantId,
    requestId: input.request.requestId,
    port: input.request.call.port,
    version: input.request.call.version,
    effect: input.request.call.effect,
    status,
    input: input.request.input,
    output: input.result.allowed
      ? {
        metadataDigest: metadataDigest(input.result.metadata),
        artifactCount: input.result.metadata.artifactCount,
        pendingMemoryChanges: input.result.metadata.pendingMemoryChanges,
      }
      : {},
    ...(!input.result.allowed
      ? {
        errorCode: input.result.code,
        errorMessage: input.result.message,
      }
      : {}),
    createdAt: input.startedAt,
    completedAt: input.completedAt,
  };
}

function auditIdForMetadataInvocation(request: FfiRpcRequest): string {
  return `workflow-live-vault-metadata:${createHash("sha256")
    .update(request.tenantId, "utf8")
    .update("\0", "utf8")
    .update(request.runId, "utf8")
    .update("\0", "utf8")
    .update(request.requestId, "utf8")
    .digest("hex")}`;
}

export async function invokeWorkflowLiveVaultArtifactMetadataWithEvidence(
  input: WorkflowLiveVaultArtifactMetadataDurableEvidenceInput,
): Promise<WorkflowLiveVaultArtifactMetadataInvocationResult> {
  const startedAt = new Date().toISOString();
  const result = await invokeWorkflowLiveVaultArtifactMetadata(input);
  const completedAt = new Date().toISOString();
  const shouldRecordEvidence = result.allowed
    || (
      !result.allowed
      && result.code === "live-vault-metadata-read-failed"
      && result.action?.id === WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID
    );
  if (!shouldRecordEvidence) {
    return result;
  }
  input.store.recordWorkflowEffectReceipt(
    receiptForMetadataInvocation({
      request: input.request,
      result,
      startedAt,
      completedAt,
    }),
  );
  input.store.recordAuditOnce({
    id: auditIdForMetadataInvocation(input.request),
    actorId: input.request.tenantId,
    tenantId: input.request.tenantId,
    vaultId: input.request.vaultId,
    action: WORKFLOW_LIVE_VAULT_METADATA_AUDIT_ACTION,
    requestId: input.request.requestId,
    outcome: result.allowed ? "success" : "failure",
    metadata: {
      action: result.action?.id ?? WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
      port: input.request.call.port,
      version: input.request.call.version,
      effect: input.request.call.effect,
      runId: input.request.runId,
      idempotencyKey: input.request.idempotencyKey,
      reasons: result.reasons,
      ...(result.allowed
        ? {
          artifactCount: result.metadata.artifactCount,
          metadataDigest: metadataDigest(result.metadata),
        }
        : { errorCode: result.code }),
    },
  });
  return result;
}
