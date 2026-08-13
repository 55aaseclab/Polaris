import type { FfiRpcRequest } from "polaris-workflow";
import {
  createHash,
} from "node:crypto";
import type {
  PolarisControlStore,
} from "./control-store.js";
import {
  listOwnedVaults,
  listVaultDriverTargets,
  readVaultStatus,
} from "../core/portal.js";
import {
  type EvaluateWorkflowLiveInvocationInput,
  type WorkflowActionCatalogEntry,
  type WorkflowLiveInvocationDecision,
  WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
} from "./workflow-live-boundary.js";
import {
  invokeWorkflowLiveTool,
  invokeWorkflowLiveToolWithEvidence,
  recordWorkflowLiveToolEvidence,
  WorkflowLiveToolExecutionError,
  type WorkflowLiveToolDefinition,
  type WorkflowLiveToolInvocationResult,
} from "./workflow-live-tool-gateway.js";

export { WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID } from "./workflow-live-boundary.js";

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
  signal?: AbortSignal;
}

export type WorkflowLiveVaultArtifactMetadataReader = (
  input: WorkflowLiveVaultArtifactMetadataReaderInput,
) => Promise<unknown> | unknown;

export interface WorkflowLiveVaultArtifactMetadataInvocationInput
  extends EvaluateWorkflowLiveInvocationInput {
  readMetadata?: WorkflowLiveVaultArtifactMetadataReader;
  signal?: AbortSignal;
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
const WORKFLOW_LIVE_VAULT_METADATA_AUDIT_ACTION = "workflow.live.vault.metadata.read";
const WORKFLOW_LIVE_VAULT_METADATA_EXECUTOR_FAMILY = "polaris.projection";

export class WorkflowLiveVaultMetadataReadError extends WorkflowLiveToolExecutionError {
  constructor(
    message: string,
    code: string,
  ) {
    super(message, code);
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

function metadataDigest(metadata: WorkflowLiveVaultArtifactMetadata): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(metadata), "utf8")
    .digest("hex")}`;
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

export const WORKFLOW_LIVE_VAULT_METADATA_TOOL =
  {
    actionId: WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
    executorFamily: WORKFLOW_LIVE_VAULT_METADATA_EXECUTOR_FAMILY,
    auditAction: WORKFLOW_LIVE_VAULT_METADATA_AUDIT_ACTION,
    auditId: auditIdForMetadataInvocation,
    failureReason: "metadata-read-failed",
    timeoutReason: "metadata-read-timeout",
    execute: readWorkflowLiveVaultArtifactMetadata,
    normalize: normalizeWorkflowLiveVaultArtifactMetadata,
    receiptOutput: (metadata) => ({
      metadataDigest: metadataDigest(metadata),
      artifactCount: metadata.artifactCount,
      pendingMemoryChanges: metadata.pendingMemoryChanges,
    }),
    auditMetadata: (metadata) => ({
      artifactCount: metadata.artifactCount,
      metadataDigest: metadataDigest(metadata),
    }),
    unsupportedActionCode: "workflow-vault-metadata-action-required",
    unsupportedActionMessage:
      "Workflow live Vault metadata gateway accepts only the Vault metadata action",
    unsupportedActionReason: "metadata-action-required",
    readFailedCode: "live-vault-metadata-read-failed",
    readFailedMessage: "Workflow live Vault metadata read failed",
  } as const satisfies WorkflowLiveToolDefinition<WorkflowLiveVaultArtifactMetadata>;

function toMetadataInvocationResult(
  result: WorkflowLiveToolInvocationResult<WorkflowLiveVaultArtifactMetadata>,
): WorkflowLiveVaultArtifactMetadataInvocationResult {
  if (!result.allowed) {
    return result;
  }
  return {
    allowed: true,
    action: result.action,
    reasons: result.reasons,
    metadata: result.output,
  };
}

function toToolInvocationResult(
  result: WorkflowLiveVaultArtifactMetadataInvocationResult,
): WorkflowLiveToolInvocationResult<WorkflowLiveVaultArtifactMetadata> {
  if (!result.allowed) {
    return result;
  }
  return {
    allowed: true,
    action: result.action,
    reasons: result.reasons,
    output: result.metadata,
  };
}

export async function invokeWorkflowLiveVaultArtifactMetadata(
  input: WorkflowLiveVaultArtifactMetadataInvocationInput,
): Promise<WorkflowLiveVaultArtifactMetadataInvocationResult> {
  return toMetadataInvocationResult(
    await invokeWorkflowLiveTool({
      ...input,
      tool: WORKFLOW_LIVE_VAULT_METADATA_TOOL,
      ...(input.readMetadata ? { execute: input.readMetadata } : {}),
    }),
  );
}

export function recordWorkflowLiveVaultArtifactMetadataEvidence(input: {
  store: PolarisControlStore;
  request: FfiRpcRequest;
  result: WorkflowLiveVaultArtifactMetadataInvocationResult;
  startedAt: string;
  completedAt: string;
}): void {
  recordWorkflowLiveToolEvidence({
    ...input,
    tool: WORKFLOW_LIVE_VAULT_METADATA_TOOL,
    result: toToolInvocationResult(input.result),
  });
}

export async function invokeWorkflowLiveVaultArtifactMetadataWithEvidence(
  input: WorkflowLiveVaultArtifactMetadataDurableEvidenceInput,
): Promise<WorkflowLiveVaultArtifactMetadataInvocationResult> {
  return toMetadataInvocationResult(
    await invokeWorkflowLiveToolWithEvidence({
      ...input,
      tool: WORKFLOW_LIVE_VAULT_METADATA_TOOL,
      ...(input.readMetadata ? { execute: input.readMetadata } : {}),
    }),
  );
}
