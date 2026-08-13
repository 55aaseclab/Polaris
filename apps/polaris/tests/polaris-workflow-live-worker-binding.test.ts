import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FfiRpcRequest } from "polaris-workflow";
import { PolarisControlStore } from "../scripts/portal/control-store.js";
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
} from "../scripts/portal/workflow-live-boundary.js";
import {
  invokeWorkflowLiveVaultArtifactMetadataFromWorker,
  rollbackWorkflowLiveMetadataWorkerBinding,
} from "../scripts/portal/workflow-live-worker-binding.js";
import { WorkflowLiveVaultMetadataReadError } from "../scripts/portal/workflow-live-vault-adapter.js";

function request(overrides: Partial<FfiRpcRequest> = {}): FfiRpcRequest {
  return {
    protocolVersion: "1.0",
    requestId: "request-synthetic",
    idempotencyKey: "idempotency-synthetic",
    runId: "run-synthetic",
    tenantId: "tenant-synthetic",
    vaultId: "vault-synthetic",
    pack: {
      id: "pack-synthetic",
      version: "1.0.0",
      digest: "sha256:" + "a".repeat(64),
    },
    capabilityLease: {
      id: "lease-synthetic",
      packDigest: "sha256:" + "a".repeat(64),
      vaultId: "vault-synthetic",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    call: {
      port: "ArtifactMetadata",
      version: "1.0.0",
      effect: "read",
    },
    input: {},
    mode: "live",
    ...overrides,
  };
}

function readiness(): WorkflowLiveReadiness {
  return {
    receiptReconciliation: true,
    budget: true,
    killSwitch: true,
    audit: true,
    rollback: true,
    deploymentEvidence: true,
  };
}

function releaseProfile(): WorkflowLiveWorkerReleaseProfile {
  return {
    id: WORKFLOW_LIVE_RELEASE_PROFILE_ID,
    capacity: {
      jobWorkerConcurrency: 1,
      jobLeaseMs: 60_000,
    },
    slo: {
      readP95Ms: 500,
      recoverySeconds: 120,
    },
  };
}

function preconditions(
  overrides: Partial<WorkflowLiveWorkerIntegrationPreconditions> = {},
): WorkflowLiveWorkerIntegrationPreconditions {
  return {
    sourceReview: true,
    workerWiring: "candidate",
    timeout: {
      perAttemptMs: 200,
      maxTotalMs: 400,
      abortSignal: true,
    },
    retry: {
      maxAttempts: 2,
      idempotentByRequestId: true,
      retryOnlyReadFailures: true,
    },
    budget: {
      releaseProfileId: WORKFLOW_LIVE_RELEASE_PROFILE_ID,
      maxConcurrentLiveReads: 1,
      countsAgainstJobWorker: true,
      readP95Ms: 500,
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
      releaseId: "release-synthetic",
      profileId: WORKFLOW_LIVE_RELEASE_PROFILE_ID,
      focusedChecks: [
        "polaris-workflow-live-boundary",
        "polaris-workflow-live-tool-gateway",
        "polaris-workflow-control",
      ],
    },
    ...overrides,
  };
}

function candidateAction(): WorkflowActionCatalogEntry {
  return {
    id: WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
    version: 1,
    port: "ArtifactMetadata",
    portVersion: "1.0.0",
    effect: "read",
    risk: "read",
    adapter: "polaris.projection",
    liveEnabled: true,
    requiredGates: REQUIRED_WORKFLOW_LIVE_GATES,
    description: "Synthetic candidate metadata worker action.",
  };
}

async function withTemporaryStore<T>(
  fn: (store: PolarisControlStore) => Promise<T> | T,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-workflow-live-worker-"));
  const store = PolarisControlStore.open(path.join(root, "control.sqlite"));
  try {
    return await fn(store);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function createSyntheticRun(store: PolarisControlStore): void {
  store.createWorkflowRun({
    id: "run-synthetic",
    tenantId: "tenant-synthetic",
    vaultId: "vault-synthetic",
    vaultName: "Synthetic Vault",
    packId: "pack-synthetic",
    packVersion: "1.0.0",
    packDigest: "sha256:" + "a".repeat(64),
    flowId: "flow-synthetic",
    source: "manual",
    priority: "normal",
    input: { subject: "synthetic" },
    approvalRequired: false,
    executionClass: "workspace",
    capabilityLease: {
      id: "lease-synthetic",
      capabilities: [WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID],
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    policy: { decision: "allow", mode: "live" },
    dedupeKey: "workflow-live-worker:tenant-synthetic:run-synthetic",
    event: {
      kind: "submitted",
      title: "Synthetic run submitted",
      detail: "Synthetic live worker binding run",
      tone: "neutral",
    },
  });
}

function environment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    [WORKFLOW_LIVE_ADAPTER_FLAG]: "enabled",
    [WORKFLOW_LIVE_WORKER_BINDING_FLAG]: "enabled",
    ...overrides,
  };
}

test("metadata worker binding stays disabled until the worker flag is enabled", async () => {
  await withTemporaryStore(async (store) => {
    createSyntheticRun(store);
    let calls = 0;
    const result = await invokeWorkflowLiveVaultArtifactMetadataFromWorker({
      store,
      request: request(),
      environment: environment({ [WORKFLOW_LIVE_WORKER_BINDING_FLAG]: undefined }),
      readiness: readiness(),
      releaseProfile: releaseProfile(),
      preconditions: preconditions(),
      catalog: [candidateAction()],
      readMetadata: () => {
        calls += 1;
        return {};
      },
    });

    assert.equal(result.allowed, false);
    assert.equal(result.code, "live-worker-binding-disabled");
    assert.equal(result.attempts, 0);
    assert.equal(calls, 0);
    assert.equal(store.getWorkflowRun("tenant-synthetic", "run-synthetic")?.receipts.length, 0);
    assert.equal(store.listAuditEvents().length, 0);
  });
});

test("metadata worker binding refuses an unreviewed default disabled action", async () => {
  await withTemporaryStore(async (store) => {
    createSyntheticRun(store);
    let calls = 0;
    const result = await invokeWorkflowLiveVaultArtifactMetadataFromWorker({
      store,
      request: request(),
      environment: environment(),
      readiness: readiness(),
      releaseProfile: releaseProfile(),
      preconditions: preconditions(),
      catalog: [{
        ...candidateAction(),
        liveEnabled: false,
      }],
      readMetadata: () => {
        calls += 1;
        return {};
      },
    });

    assert.equal(result.allowed, false);
    assert.equal(result.code, "workflow-live-worker-preconditions-incomplete");
    assert.deepEqual(result.reasons, ["action-enabled"]);
    assert.equal(result.attempts, 0);
    assert.equal(calls, 0);
    assert.equal(store.getWorkflowRun("tenant-synthetic", "run-synthetic")?.receipts.length, 0);
  });
});

test("metadata worker binding retries one admitted read failure and reconciles evidence", async () => {
  await withTemporaryStore(async (store) => {
    createSyntheticRun(store);
    let calls = 0;
    const result = await invokeWorkflowLiveVaultArtifactMetadataFromWorker({
      store,
      request: request(),
      environment: environment(),
      readiness: readiness(),
      releaseProfile: releaseProfile(),
      preconditions: preconditions(),
      catalog: [candidateAction()],
      readMetadata: ({ signal }) => {
        assert.equal(signal?.aborted, false);
        calls += 1;
        if (calls === 1) {
          throw new Error("synthetic transient metadata failure");
        }
        return {
          artifactCount: 1,
          activeVaultArtifacts: 1,
          activeUserArtifacts: 0,
          latestTitles: ["Synthetic metadata"],
          latestArtifacts: [],
          pendingMemoryChanges: 0,
        };
      },
    });

    assert.equal(result.allowed, true);
    assert.equal(result.attempts, 2);
    assert.equal(calls, 2);
    const run = store.getWorkflowRun("tenant-synthetic", "run-synthetic");
    assert.equal(run?.receipts.length, 1);
    assert.equal(run?.receipts[0]?.status, "completed");
    assert.equal(store.listAuditEvents().length, 1);
    assert.equal(store.listAuditEvents()[0]?.outcome, "success");
    assert.deepEqual(store.verifyAuditChain(), { valid: true, checked: 1 });
  });
});

test("metadata worker binding records final admitted read failure after retry budget", async () => {
  await withTemporaryStore(async (store) => {
    createSyntheticRun(store);
    let calls = 0;
    const result = await invokeWorkflowLiveVaultArtifactMetadataFromWorker({
      store,
      request: request(),
      environment: environment(),
      readiness: readiness(),
      releaseProfile: releaseProfile(),
      preconditions: preconditions(),
      catalog: [candidateAction()],
      readMetadata: () => {
        calls += 1;
        throw new Error("synthetic persistent metadata failure");
      },
    });

    assert.equal(result.allowed, false);
    assert.equal(result.code, "live-vault-metadata-read-failed");
    assert.equal(result.attempts, 2);
    assert.equal(calls, 2);
    const run = store.getWorkflowRun("tenant-synthetic", "run-synthetic");
    assert.equal(run?.receipts.length, 1);
    assert.equal(run?.receipts[0]?.status, "failed");
    assert.equal(run?.receipts[0]?.errorCode, "live-vault-metadata-read-failed");
    assert.equal(store.listAuditEvents()[0]?.outcome, "failure");
  });
});

test("metadata worker binding enforces the one-worker live-read budget", async () => {
  await withTemporaryStore(async (store) => {
    createSyntheticRun(store);
    let releaseFirstRead: (() => void) | null = null;
    const first = invokeWorkflowLiveVaultArtifactMetadataFromWorker({
      store,
      request: request({ requestId: "request-first", idempotencyKey: "idem-first" }),
      environment: environment(),
      readiness: readiness(),
      releaseProfile: releaseProfile(),
      preconditions: preconditions(),
      catalog: [candidateAction()],
      readMetadata: () => new Promise((resolve) => {
        releaseFirstRead = () => resolve({
          artifactCount: 1,
          activeVaultArtifacts: 1,
          activeUserArtifacts: 0,
          latestTitles: ["Synthetic metadata"],
          latestArtifacts: [],
          pendingMemoryChanges: 0,
        });
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));

    const second = await invokeWorkflowLiveVaultArtifactMetadataFromWorker({
      store,
      request: request({ requestId: "request-second", idempotencyKey: "idem-second" }),
      environment: environment(),
      readiness: readiness(),
      releaseProfile: releaseProfile(),
      preconditions: preconditions(),
      catalog: [candidateAction()],
      readMetadata: () => {
        throw new Error("second read should not start");
      },
    });

    assert.equal(second.allowed, false);
    assert.equal(second.code, "live-worker-budget-exhausted");
    assert.equal(second.attempts, 0);
    assert.equal(store.getWorkflowRun("tenant-synthetic", "run-synthetic")?.receipts.length, 0);

    assert.ok(releaseFirstRead);
    releaseFirstRead();
    const firstResult = await first;
    assert.equal(firstResult.allowed, true);
    assert.equal(firstResult.attempts, 1);
    assert.equal(store.getWorkflowRun("tenant-synthetic", "run-synthetic")?.receipts.length, 1);
  });
});

test("metadata worker binding records timeout evidence and aborts the attempt", async () => {
  await withTemporaryStore(async (store) => {
    createSyntheticRun(store);
    let observedAbort = false;
    const result = await invokeWorkflowLiveVaultArtifactMetadataFromWorker({
      store,
      request: request(),
      environment: environment(),
      readiness: readiness(),
      releaseProfile: releaseProfile(),
      preconditions: preconditions({
        timeout: {
          perAttemptMs: 10,
          maxTotalMs: 20,
          abortSignal: true,
        },
      }),
      catalog: [candidateAction()],
      readMetadata: ({ signal }) => new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => {
          observedAbort = true;
          reject(new WorkflowLiveVaultMetadataReadError(
            "Workflow live Vault metadata read exceeded its execution deadline",
            "live-vault-metadata-timeout",
          ));
        });
        setTimeout(() => resolve({ artifactCount: 1 }), 100);
      }),
    });

    assert.equal(result.allowed, false);
    assert.equal(result.code, "live-vault-metadata-timeout");
    assert.equal(result.attempts, 1);
    assert.equal(observedAbort, true);
    const run = store.getWorkflowRun("tenant-synthetic", "run-synthetic");
    assert.equal(run?.receipts.length, 1);
    assert.equal(run?.receipts[0]?.status, "failed");
    assert.equal(run?.receipts[0]?.errorCode, "live-vault-metadata-timeout");
    assert.equal(store.listAuditEvents()[0]?.outcome, "failure");
  });
});

test("metadata worker binding rollback disables future calls without deleting evidence", async () => {
  await withTemporaryStore(async (store) => {
    createSyntheticRun(store);
    const first = await invokeWorkflowLiveVaultArtifactMetadataFromWorker({
      store,
      request: request(),
      environment: environment(),
      readiness: readiness(),
      releaseProfile: releaseProfile(),
      preconditions: preconditions(),
      catalog: [candidateAction()],
      readMetadata: () => ({
        artifactCount: 1,
        activeVaultArtifacts: 1,
        activeUserArtifacts: 0,
        latestTitles: ["Synthetic metadata"],
        latestArtifacts: [],
        pendingMemoryChanges: 0,
      }),
    });
    assert.equal(first.allowed, true);

    const rolledBackEnvironment = rollbackWorkflowLiveMetadataWorkerBinding(environment());
    const second = await invokeWorkflowLiveVaultArtifactMetadataFromWorker({
      store,
      request: request({ requestId: "request-after-rollback", idempotencyKey: "idem-after-rollback" }),
      environment: rolledBackEnvironment,
      readiness: readiness(),
      releaseProfile: releaseProfile(),
      preconditions: preconditions(),
      catalog: [candidateAction()],
      readMetadata: () => {
        throw new Error("rollback should prevent this read");
      },
    });

    assert.equal(second.allowed, false);
    assert.equal(second.code, "live-worker-binding-disabled");
    assert.equal(second.attempts, 0);
    assert.equal(store.getWorkflowRun("tenant-synthetic", "run-synthetic")?.receipts.length, 1);
    assert.equal(store.listAuditEvents().length, 1);
  });
});
