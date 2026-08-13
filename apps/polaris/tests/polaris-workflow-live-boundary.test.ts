import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import type { FfiRpcRequest } from "polaris-workflow";
import {
  evaluateWorkflowLiveWorkerIntegration,
  evaluateWorkflowLiveInvocation,
  findWorkflowActionForCall,
  listWorkflowActionCatalog,
  missingWorkflowLiveWorkerIntegrationPreconditions,
  REQUIRED_WORKFLOW_LIVE_GATES,
  WORKFLOW_LIVE_ADAPTER_FLAG,
  WORKFLOW_LIVE_RELEASE_PROFILE_ID,
  WORKFLOW_LIVE_WORKER_BINDING_FLAG,
  WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
  type WorkflowActionCatalogEntry,
  type WorkflowLiveWorkerIntegrationPreconditions,
  type WorkflowLiveWorkerReleaseProfile,
  type WorkflowLiveReadiness,
} from "../scripts/portal/workflow-live-boundary.js";

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

function completeReadiness(): WorkflowLiveReadiness {
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

function completeWorkerPreconditions(): WorkflowLiveWorkerIntegrationPreconditions {
  return {
    sourceReview: true,
    workerWiring: "unwired",
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
  };
}

test("the default workflow action catalog is disabled for live execution", () => {
  const catalog = listWorkflowActionCatalog();
  assert.ok(catalog.length > 0);
  assert.ok(catalog.every((action) => action.liveEnabled === false));
  assert.ok(catalog.every((action) => (
    action.requiredGates.length === REQUIRED_WORKFLOW_LIVE_GATES.length
  )));

  const action = findWorkflowActionForCall(request(), catalog);
  assert.equal(action?.id, "vault.artifact.metadata.read");
  const decision = evaluateWorkflowLiveInvocation({
    request: request(),
    environment: { [WORKFLOW_LIVE_ADAPTER_FLAG]: "enabled" },
    readiness: completeReadiness(),
  });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) {
    assert.equal(decision.code, "workflow-action-disabled");
  }
});

test("the live boundary fails closed when deployment gates are incomplete", () => {
  const decision = evaluateWorkflowLiveInvocation({
    request: request(),
    environment: { [WORKFLOW_LIVE_ADAPTER_FLAG]: "enabled" },
    readiness: { ...completeReadiness(), rollback: false },
  });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) {
    assert.equal(decision.code, "live-adapter-gates-incomplete");
    assert.deepEqual(decision.reasons, ["rollback"]);
  }
});

test("the live boundary preserves FFI admission before action evaluation", () => {
  const decision = evaluateWorkflowLiveInvocation({
    request: request({
      capabilityLease: {
        id: "lease-synthetic",
        packDigest: "sha256:" + "b".repeat(64),
        vaultId: "vault-synthetic",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }),
    environment: { [WORKFLOW_LIVE_ADAPTER_FLAG]: "enabled" },
    readiness: completeReadiness(),
  });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) {
    assert.equal(decision.code, "pack-digest-mismatch");
    assert.deepEqual(decision.reasons, ["ffi-admission-denied"]);
  }
});

test("a fully gated action can be evaluated without wiring a live executor", () => {
  const action: WorkflowActionCatalogEntry = {
    id: "synthetic.read",
    version: 1,
    port: "ArtifactMetadata",
    portVersion: "1.0.0",
    effect: "read",
    risk: "read",
    adapter: "polaris.projection",
    liveEnabled: true,
    requiredGates: REQUIRED_WORKFLOW_LIVE_GATES,
    description: "Synthetic test action.",
  };
  const decision = evaluateWorkflowLiveInvocation({
    request: request(),
    environment: { [WORKFLOW_LIVE_ADAPTER_FLAG]: "enabled" },
    readiness: completeReadiness(),
    catalog: [action],
  });
  assert.deepEqual(decision, {
    allowed: true,
    action,
    reasons: ["ffi-admission-allowed", "live-gates-complete"],
  });
});

test("metadata worker integration preconditions fail closed by default", () => {
  const decision = evaluateWorkflowLiveWorkerIntegration();
  assert.equal(decision.ready, false);
  if (!decision.ready) {
    assert.equal(decision.code, "workflow-live-worker-preconditions-incomplete");
    assert.deepEqual(decision.reasons, [
      "source-review",
      "worker-unwired",
      "release-profile",
      "timeout",
      "retry",
      "budget",
      "kill-switch",
      "receipt-reconciliation",
      "audit",
      "rollback",
      "deployment-evidence",
    ]);
  }
});

function candidateMetadataAction(): WorkflowActionCatalogEntry {
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

test("metadata worker integration preconditions keep the review-stage catalog unwired", () => {
  const decision = evaluateWorkflowLiveWorkerIntegration({
    releaseProfile: releaseProfile(),
    preconditions: completeWorkerPreconditions(),
    stage: "review",
  });
  assert.equal(decision.ready, true);
  if (!decision.ready) {
    throw new Error("expected complete review-stage preconditions");
  }
  assert.equal(decision.action.id, WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID);
  assert.deepEqual(decision.reasons, [
    "metadata-action-source-reviewed",
    "worker-remains-unwired",
    "release-profile-budget-preserved",
  ]);
});

test("metadata worker integration preconditions allow only candidate worker wiring", () => {
  const preconditions = {
    ...completeWorkerPreconditions(),
    workerWiring: "candidate" as const,
  };
  const decision = evaluateWorkflowLiveWorkerIntegration({
    releaseProfile: releaseProfile(),
    preconditions,
    catalog: [candidateMetadataAction()],
    stage: "candidate",
  });
  assert.equal(decision.ready, true);
  if (!decision.ready) {
    throw new Error("expected complete candidate-stage preconditions");
  }
  assert.equal(decision.action.id, WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID);
  assert.deepEqual(decision.reasons, [
    "metadata-action-source-reviewed",
    "worker-binding-candidate",
    "release-profile-budget-preserved",
  ]);

  const workerSource = fs.readFileSync(
    new URL("../scripts/portal/workflow-control.ts", import.meta.url),
    "utf8",
  );
  assert.equal(workerSource.includes('this.run.policy.mode === "live"'), true);
  assert.equal(workerSource.includes("WORKFLOW_LIVE_WORKER_BINDING_FLAG"), true);
  assert.equal(workerSource.includes("program.runAsync"), true);
  assert.equal(workerSource.includes('entry.request.mode === "live"'), true);
});

test("metadata worker integration preconditions reject budget growth beyond the release profile", () => {
  const preconditions = completeWorkerPreconditions();
  const missing = missingWorkflowLiveWorkerIntegrationPreconditions({
    releaseProfile: releaseProfile(),
    preconditions: {
      ...preconditions,
      budget: {
        ...preconditions.budget,
        maxConcurrentLiveReads: 2,
      },
    },
  });
  assert.deepEqual(missing, ["budget"]);
});

test("metadata worker integration preconditions bind timeout and retry to the read SLO", () => {
  const preconditions = completeWorkerPreconditions();
  assert.deepEqual(
    missingWorkflowLiveWorkerIntegrationPreconditions({
      releaseProfile: releaseProfile(),
      preconditions: {
        ...preconditions,
        timeout: {
          ...preconditions.timeout,
          maxTotalMs: 501,
        },
      },
    }),
    ["timeout"],
  );
  assert.deepEqual(
    missingWorkflowLiveWorkerIntegrationPreconditions({
      releaseProfile: releaseProfile(),
      preconditions: {
        ...preconditions,
        timeout: {
          ...preconditions.timeout,
          perAttemptMs: 300,
        },
      },
    }),
    ["retry"],
  );
});

test("metadata worker integration preconditions require rollback and kill-switch control", () => {
  const preconditions = completeWorkerPreconditions();
  const missing = missingWorkflowLiveWorkerIntegrationPreconditions({
    releaseProfile: releaseProfile(),
    preconditions: {
      ...preconditions,
      killSwitch: {
        ...preconditions.killSwitch,
        checkedBeforeEachAttempt: false,
      },
      rollback: {
        ...preconditions.rollback,
        disablesWorkerBinding: false,
      },
    },
  });
  assert.deepEqual(missing, ["kill-switch", "rollback"]);
});
