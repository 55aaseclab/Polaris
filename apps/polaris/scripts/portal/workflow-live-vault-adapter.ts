import type { FfiRpcRequest } from "polaris-workflow";
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
  readMetadata: WorkflowLiveVaultArtifactMetadataReader;
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

const MAX_LATEST_ARTIFACTS = 5;
const MAX_LATEST_TITLES = 5;
const MAX_RETRIEVAL_REASONS = 5;

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

export async function invokeWorkflowLiveVaultArtifactMetadata(
  input: WorkflowLiveVaultArtifactMetadataInvocationInput,
): Promise<WorkflowLiveVaultArtifactMetadataInvocationResult> {
  const decision = evaluateWorkflowLiveInvocation(input);
  if (!decision.allowed) {
    return decision;
  }
  try {
    const metadata = normalizeWorkflowLiveVaultArtifactMetadata(
      await input.readMetadata({
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
