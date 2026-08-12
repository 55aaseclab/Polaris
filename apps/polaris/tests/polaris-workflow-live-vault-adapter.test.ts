import assert from "node:assert/strict";
import test from "node:test";
import type { FfiRpcRequest } from "polaris-workflow";
import {
  invokeWorkflowLiveVaultArtifactMetadata,
  normalizeWorkflowLiveVaultArtifactMetadata,
} from "../scripts/portal/workflow-live-vault-adapter.js";
import {
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

function enabledAction(): WorkflowActionCatalogEntry {
  return {
    id: "vault.artifact.metadata.read",
    version: 1,
    port: "ArtifactMetadata",
    portVersion: "1.0.0",
    effect: "read",
    risk: "read",
    adapter: "future-vault",
    liveEnabled: true,
    requiredGates: REQUIRED_WORKFLOW_LIVE_GATES,
    description: "Synthetic live Vault metadata action.",
  };
}

test("the disabled live vault adapter never calls the metadata reader", async () => {
  let calls = 0;
  const result = await invokeWorkflowLiveVaultArtifactMetadata({
    request: request(),
    environment: { [WORKFLOW_LIVE_ADAPTER_FLAG]: "enabled" },
    readiness: completeReadiness(),
    readMetadata: async () => {
      calls += 1;
      return {
        artifactCount: 1,
        activeVaultArtifacts: 1,
        activeUserArtifacts: 0,
        latestTitles: ["should-not-read"],
        latestArtifacts: [],
        pendingMemoryChanges: 0,
      };
    },
  });
  assert.equal(result.allowed, false);
  assert.equal(calls, 0);
  if (!result.allowed) {
    assert.equal(result.code, "workflow-action-disabled");
  }
});

test("the live vault adapter fails closed before reading metadata when gates are incomplete", async () => {
  let calls = 0;
  const result = await invokeWorkflowLiveVaultArtifactMetadata({
    request: request(),
    environment: { [WORKFLOW_LIVE_ADAPTER_FLAG]: "enabled" },
    readiness: { ...completeReadiness(), rollback: false },
    catalog: [enabledAction()],
    readMetadata: async () => {
      calls += 1;
      return {};
    },
  });
  assert.equal(result.allowed, false);
  assert.equal(calls, 0);
  if (!result.allowed) {
    assert.equal(result.code, "live-adapter-gates-incomplete");
    assert.deepEqual(result.reasons, ["rollback"]);
  }
});

test("the live vault adapter fails closed before reading metadata for invalid admission", async () => {
  let calls = 0;
  const result = await invokeWorkflowLiveVaultArtifactMetadata({
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
    catalog: [enabledAction()],
    readMetadata: async () => {
      calls += 1;
      return {};
    },
  });
  assert.equal(result.allowed, false);
  assert.equal(calls, 0);
  if (!result.allowed) {
    assert.equal(result.code, "pack-digest-mismatch");
    assert.deepEqual(result.reasons, ["ffi-admission-denied"]);
  }
});

test("the live vault adapter fails closed before reading metadata for an unsupported action", async () => {
  let calls = 0;
  const result = await invokeWorkflowLiveVaultArtifactMetadata({
    request: request({
      call: {
        port: "UnknownMetadata",
        version: "1.0.0",
        effect: "read",
      },
    }),
    environment: { [WORKFLOW_LIVE_ADAPTER_FLAG]: "enabled" },
    readiness: completeReadiness(),
    catalog: [enabledAction()],
    readMetadata: async () => {
      calls += 1;
      return {};
    },
  });
  assert.equal(result.allowed, false);
  assert.equal(calls, 0);
  if (!result.allowed) {
    assert.equal(result.code, "workflow-action-not-cataloged");
    assert.deepEqual(result.reasons, ["action-catalog-required"]);
  }
});

test("the live vault metadata projection is bounded and strips extra fields", async () => {
  const result = await invokeWorkflowLiveVaultArtifactMetadata({
    request: request(),
    environment: { [WORKFLOW_LIVE_ADAPTER_FLAG]: "enabled" },
    readiness: completeReadiness(),
    catalog: [enabledAction()],
    readMetadata: () => ({
      artifactCount: "3",
      activeVaultArtifacts: 2,
      activeUserArtifacts: 1,
      latestTitles: [
        "first",
        "second",
        "third",
        "fourth",
        "fifth",
        "sixth",
      ],
      latestArtifacts: [
        {
          title: "one",
          kind: "vault-memory",
          status: "active",
          whyExists: "kept for traceability",
          whyRetrieved: ["relevant", "recent", "synthetic", "bounded", "read-only", "ignored"],
          curatorAction: "retain",
          curatorReason: "synthetic",
          suppressedBecause: "",
          content: "hidden-content",
          path: "/vault/workspaces/demo/.polaris/MEMORY.md",
        },
        {
          title: "two",
          kind: "user-memory",
          status: "suppressed",
          summary: "not projected",
          digest: "sha256:" + "c".repeat(64),
        },
        null,
      ],
      pendingMemoryChanges: "1",
      extraField: "drop-me",
    }),
  });
  assert.equal(result.allowed, true);
  if (!result.allowed) {
    throw new Error("expected allowed metadata read");
  }
  assert.equal(result.metadata.artifactCount, 3);
  assert.equal(result.metadata.activeVaultArtifacts, 2);
  assert.equal(result.metadata.activeUserArtifacts, 1);
  assert.deepEqual(result.metadata.latestTitles, [
    "first",
    "second",
    "third",
    "fourth",
    "fifth",
  ]);
  assert.equal(result.metadata.latestArtifacts.length, 2);
  assert.deepEqual(result.metadata.latestArtifacts[0], {
    title: "one",
    kind: "vault-memory",
    status: "active",
    whyExists: "kept for traceability",
    whyRetrieved: ["relevant", "recent", "synthetic", "bounded", "read-only"],
    curatorAction: "retain",
    curatorReason: "synthetic",
  });
  assert.equal("content" in (result.metadata.latestArtifacts[0] as Record<string, unknown>), false);
  assert.equal("path" in (result.metadata.latestArtifacts[0] as Record<string, unknown>), false);
  assert.equal(result.metadata.latestArtifacts[1].title, "two");
  assert.equal(result.metadata.pendingMemoryChanges, 1);
});

test("normalizeWorkflowLiveVaultArtifactMetadata accepts a minimal synthetic payload", () => {
  assert.deepEqual(normalizeWorkflowLiveVaultArtifactMetadata(null), {
    artifactCount: 0,
    activeVaultArtifacts: 0,
    activeUserArtifacts: 0,
    latestTitles: [],
    latestArtifacts: [],
    pendingMemoryChanges: 0,
  });
});
