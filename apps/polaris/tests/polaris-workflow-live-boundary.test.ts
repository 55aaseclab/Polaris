import assert from "node:assert/strict";
import test from "node:test";
import type { FfiRpcRequest } from "polaris-workflow";
import {
  evaluateWorkflowLiveInvocation,
  findWorkflowActionForCall,
  listWorkflowActionCatalog,
  REQUIRED_WORKFLOW_LIVE_GATES,
  WORKFLOW_LIVE_ADAPTER_FLAG,
  type WorkflowActionCatalogEntry,
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
    adapter: "future-vault",
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
