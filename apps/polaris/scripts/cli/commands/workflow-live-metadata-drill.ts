import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FfiRpcRequest } from "polaris-workflow";
import {
  FFI_RPC_PROTOCOL_VERSION,
} from "polaris-workflow";
import {
  listPortalProfiles,
  listOwnedVaults,
  readVaultStatus,
} from "../../core/portal.js";
import {
  getPolarisControlStore,
  type PolarisControlStore,
  type WorkflowRunRecord,
} from "../../portal/control-store.js";
import {
  invokeWorkflowLiveVaultArtifactMetadataFromWorker,
  type WorkflowLiveMetadataWorkerBindingResult,
} from "../../portal/workflow-live-worker-binding.js";
import {
  REQUIRED_WORKFLOW_LIVE_GATES,
  WORKFLOW_LIVE_ADAPTER_FLAG,
  WORKFLOW_LIVE_RELEASE_PROFILE_ID,
  WORKFLOW_LIVE_WORKER_BINDING_FLAG,
  WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
  type WorkflowActionCatalogEntry,
  type WorkflowLiveReadiness,
  type WorkflowLiveWorkerIntegrationPreconditions,
  type WorkflowLiveWorkerReleaseProfile,
} from "../../portal/workflow-live-boundary.js";
import { repoRoot } from "../../utils/paths.js";

type DrillOptions = {
  userId?: string;
  vault?: string;
  json: boolean;
  candidateLiveEnabled: boolean;
  releaseId?: string;
};

type ReleaseProfileFile = {
  id?: string;
  capacity?: {
    jobWorkerConcurrency?: number;
    jobLeaseMs?: number;
  };
  slo?: {
    readP95Ms?: number;
    recoverySeconds?: number;
  };
};

export type WorkflowLiveMetadataDrillSummary = {
  mode: "live";
  tool: typeof WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID;
  workerBinding: "disabled" | "executed";
  allowed: boolean;
  code?: string;
  reasons: string[];
  tenantId: string;
  vaultId: string;
  runId: string;
  requestId: string;
  attempts: number;
  receipts: number;
  auditEvents: number;
  auditChainValid: boolean;
  metadata?: {
    artifactCount: number;
    activeVaultArtifacts: number;
    activeUserArtifacts: number;
    pendingMemoryChanges: number;
    latestTitles: string[];
  };
};

function usage(): never {
  throw new Error(
    "Usage: pnpm --dir apps/polaris run polaris -- ops workflow-live-metadata-drill --user <userId> --vault <vault> --candidate-live-enabled [--release-id <id>] [--json]",
  );
}

function parseArgs(argv: string[]): DrillOptions {
  const options: DrillOptions = {
    json: false,
    candidateLiveEnabled: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") {
      options.json = true;
      continue;
    }
    if (value === "--candidate-live-enabled") {
      options.candidateLiveEnabled = true;
      continue;
    }
    if (value === "--user") {
      const userId = argv[index + 1]?.trim();
      if (!userId) usage();
      options.userId = userId;
      index += 1;
      continue;
    }
    if (value === "--vault") {
      const vault = argv[index + 1]?.trim();
      if (!vault) usage();
      options.vault = vault;
      index += 1;
      continue;
    }
    if (value === "--release-id") {
      const releaseId = argv[index + 1]?.trim();
      if (!releaseId) usage();
      options.releaseId = releaseId;
      index += 1;
      continue;
    }
    usage();
  }
  if (!options.userId || !options.vault || !options.candidateLiveEnabled) {
    usage();
  }
  return options;
}

function assertEnvironmentEnabled(environment: NodeJS.ProcessEnv): void {
  const missing = [
    WORKFLOW_LIVE_ADAPTER_FLAG,
    WORKFLOW_LIVE_WORKER_BINDING_FLAG,
  ].filter((key) => environment[key] !== "enabled");
  if (missing.length > 0) {
    const requirements = missing.map((key) => `${key}=enabled`).join(", ");
    throw new Error(
      `workflow-live-metadata-drill requires ${requirements}`,
    );
  }
}

function assertCandidateLiveEnabled(options: DrillOptions): void {
  if (!options.candidateLiveEnabled) {
    throw new Error(
      "workflow-live-metadata-drill requires --candidate-live-enabled",
    );
  }
}

function readReleaseProfile(): WorkflowLiveWorkerReleaseProfile {
  const profilePath = path.join(
    repoRoot(import.meta.url),
    "config",
    "release-profiles",
    `${WORKFLOW_LIVE_RELEASE_PROFILE_ID}.json`,
  );
  const parsed = JSON.parse(fs.readFileSync(profilePath, "utf8")) as ReleaseProfileFile;
  return {
    id: String(parsed.id ?? ""),
    capacity: {
      jobWorkerConcurrency: Number(parsed.capacity?.jobWorkerConcurrency),
      jobLeaseMs: Number(parsed.capacity?.jobLeaseMs),
    },
    slo: {
      readP95Ms: Number(parsed.slo?.readP95Ms),
      recoverySeconds: Number(parsed.slo?.recoverySeconds),
    },
  };
}

function liveReadiness(): WorkflowLiveReadiness {
  return {
    receiptReconciliation: true,
    budget: true,
    killSwitch: true,
    audit: true,
    rollback: true,
    deploymentEvidence: true,
  };
}

function livePreconditions(
  profile: WorkflowLiveWorkerReleaseProfile,
  releaseId: string,
): WorkflowLiveWorkerIntegrationPreconditions {
  const perAttemptMs = Math.max(1, Math.floor(profile.slo.readP95Ms / 2));
  const maxTotalMs = Math.max(perAttemptMs, profile.slo.readP95Ms);
  return {
    sourceReview: true,
    workerWiring: "candidate",
    timeout: {
      perAttemptMs,
      maxTotalMs,
      abortSignal: true,
    },
    retry: {
      maxAttempts: 2,
      idempotentByRequestId: true,
      retryOnlyReadFailures: true,
    },
    budget: {
      releaseProfileId: profile.id,
      maxConcurrentLiveReads: 1,
      countsAgainstJobWorker: true,
      readP95Ms: profile.slo.readP95Ms,
    },
    killSwitch: {
      environmentFlag: WORKFLOW_LIVE_WORKER_BINDING_FLAG,
      disabledValue: "disabled",
      failClosedWhenUnset: true,
      checkedBeforeEachAttempt: true,
    },
    receiptReconciliation: {
      durableReceipts: true,
      duplicateRequestIdsReconcile: true,
      admittedFailuresPersisted: true,
    },
    audit: {
      immutableEvents: true,
      noPreAdmissionWrites: true,
    },
    rollback: {
      disablesWorkerBinding: true,
      preservesDurableEvidence: true,
    },
    deploymentEvidence: {
      releaseId,
      profileId: profile.id,
      focusedChecks: [
        "polaris-workflow-live-boundary",
        "polaris-workflow-live-vault-adapter",
        "polaris-workflow-control",
      ],
    },
  };
}

function candidateMetadataAction(): WorkflowActionCatalogEntry {
  return {
    id: WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
    version: 1,
    port: "ArtifactMetadata",
    portVersion: "1.0.0",
    effect: "read",
    risk: "read",
    adapter: "future-vault",
    liveEnabled: true,
    requiredGates: REQUIRED_WORKFLOW_LIVE_GATES,
    description: "Candidate read-only Vault artifact metadata action.",
  };
}

function requireOwnedVault(userId: string, vault: string): void {
  if (!listPortalProfiles().some((profile) => profile.id === userId)) {
    throw new Error(`Polaris user '${userId}' was not found`);
  }
  if (!listOwnedVaults(userId).includes(vault)) {
    throw new Error(`Vault '${vault}' is not owned by Polaris user '${userId}'`);
  }
  const status = readVaultStatus(userId, vault);
  if (status?.driver?.status !== "running") {
    throw new Error(`Vault '${vault}' must have a running selected driver`);
  }
}

function digestForDrill(userId: string, vault: string): string {
  return `sha256:${createHash("sha256")
    .update("workflow-live-metadata-drill", "utf8")
    .update("\0", "utf8")
    .update(userId, "utf8")
    .update("\0", "utf8")
    .update(vault, "utf8")
    .digest("hex")}`;
}

function createDrillRun(
  store: PolarisControlStore,
  input: {
    userId: string;
    vault: string;
    releaseId: string;
    packDigest: string;
  },
): WorkflowRunRecord {
  const now = new Date();
  const runId = `run-live-metadata-${randomUUID()}`;
  const leaseId = `lease-live-metadata-${randomUUID()}`;
  return store.createWorkflowRun({
    id: runId,
    tenantId: input.userId,
    vaultId: input.vault,
    vaultName: input.vault,
    packId: "polaris-live-tool-drill",
    packVersion: "1.0.0",
    packDigest: input.packDigest,
    flowId: WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
    source: "manual",
    priority: "low",
    input: {
      tool: WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
      releaseId: input.releaseId,
    },
    approvalRequired: false,
    executionClass: "workspace",
    capabilityLease: {
      id: leaseId,
      capabilities: [WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID],
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    },
    policy: {
      decision: "allow",
      mode: "live",
      reasons: [
        "candidate-live-metadata-drill",
        "pack-digest-pinned",
        "vault-capability-lease",
      ],
    },
    dedupeKey: `workflow-live-metadata-drill:${input.userId}:${input.vault}:${runId}`,
    event: {
      kind: "submitted",
      title: "Live metadata drill submitted",
      detail: "Polaris is drilling the read-only Vault metadata tool.",
      tone: "neutral",
    },
  });
}

function requestForRun(run: WorkflowRunRecord, requestId: string): FfiRpcRequest {
  return {
    protocolVersion: FFI_RPC_PROTOCOL_VERSION,
    requestId,
    idempotencyKey: `${run.id}:${requestId}`,
    runId: run.id,
    tenantId: run.tenantId,
    vaultId: run.vaultId,
    pack: {
      id: run.packId,
      version: run.packVersion,
      digest: run.packDigest,
    },
    capabilityLease: {
      id: run.capabilityLeaseId,
      packDigest: run.packDigest,
      vaultId: run.vaultId,
      expiresAt: run.capabilityLeaseExpiresAt,
    },
    call: {
      port: "ArtifactMetadata",
      version: "1.0.0",
      effect: "read",
    },
    input: {
      artifactScope: "latest",
    },
    mode: "live",
    traceId: "workflow-live-metadata-drill",
  };
}

function completeDrillRun(
  store: PolarisControlStore,
  run: WorkflowRunRecord,
  result: WorkflowLiveMetadataWorkerBindingResult,
): WorkflowRunRecord {
  if (result.allowed) {
    return store.updateWorkflowRun({
      tenantId: run.tenantId,
      runId: run.id,
      status: "succeeded",
      progress: 100,
      output: {
        tool: WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
        metadata: result.metadata,
      },
      event: {
        kind: "succeeded",
        title: "Live metadata drill succeeded",
        detail: "Polaris recorded a read-only Vault metadata receipt and audit event.",
        tone: "success",
      },
    });
  }
  return store.updateWorkflowRun({
    tenantId: run.tenantId,
    runId: run.id,
    status: "failed",
    progress: 100,
    output: {
      tool: WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
      reasons: result.reasons,
    },
    errorCode: result.code,
    errorMessage: result.message,
    event: {
      kind: "failed",
      title: "Live metadata drill failed",
      detail: result.message,
      tone: "warning",
    },
  });
}

export async function runWorkflowLiveMetadataDrill(
  options: DrillOptions,
): Promise<WorkflowLiveMetadataDrillSummary> {
  const userId = options.userId?.trim() ?? "";
  const vault = options.vault?.trim() ?? "";
  const releaseId = options.releaseId?.trim() || process.env.POLARIS_RELEASE_ID?.trim() || "local-drill";
  assertCandidateLiveEnabled(options);
  assertEnvironmentEnabled(process.env);
  requireOwnedVault(userId, vault);

  const store = getPolarisControlStore(import.meta.url);
  const profile = readReleaseProfile();
  const run = createDrillRun(store, {
    userId,
    vault,
    releaseId,
    packDigest: digestForDrill(userId, vault),
  });
  const requestId = `ffi-${run.id}-metadata`;
  const result = await invokeWorkflowLiveVaultArtifactMetadataFromWorker({
    store,
    request: requestForRun(run, requestId),
    environment: process.env,
    readiness: liveReadiness(),
    releaseProfile: profile,
    preconditions: livePreconditions(profile, releaseId),
    catalog: [candidateMetadataAction()],
  });
  const completed = completeDrillRun(store, run, result);
  const auditEvents = store.listAuditEvents().filter((event) =>
    event.requestId === requestId
  );
  const integrity = store.verifyAuditChain();
  return {
    mode: "live",
    tool: WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
    workerBinding: result.workerBinding,
    allowed: result.allowed,
    ...(!result.allowed ? { code: result.code } : {}),
    reasons: result.reasons,
    tenantId: userId,
    vaultId: vault,
    runId: run.id,
    requestId,
    attempts: result.attempts,
    receipts: completed.receipts.length,
    auditEvents: auditEvents.length,
    auditChainValid: integrity.valid,
    ...(result.allowed
      ? {
        metadata: {
          artifactCount: result.metadata.artifactCount,
          activeVaultArtifacts: result.metadata.activeVaultArtifacts,
          activeUserArtifacts: result.metadata.activeUserArtifacts,
          pendingMemoryChanges: result.metadata.pendingMemoryChanges,
          latestTitles: result.metadata.latestTitles,
        },
      }
      : {}),
  };
}

export async function workflowLiveMetadataDrillCommand(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const summary = await runWorkflowLiveMetadataDrill(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `workflow-live-metadata-drill tool=${summary.tool}`,
      `allowed=${summary.allowed ? "yes" : "no"}`,
      `tenant=${summary.tenantId}`,
      `vault=${summary.vaultId}`,
      `run=${summary.runId}`,
      `request=${summary.requestId}`,
      `attempts=${summary.attempts}`,
      `receipts=${summary.receipts}`,
      `audit-events=${summary.auditEvents}`,
      `audit-chain=${summary.auditChainValid ? "valid" : "invalid"}`,
      ...(summary.code ? [`code=${summary.code}`] : []),
    ].join(" "),
  );
  process.stdout.write("\n");
}
