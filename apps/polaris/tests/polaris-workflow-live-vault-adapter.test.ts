import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FfiRpcRequest } from "polaris-workflow";
import {
  invokeWorkflowLiveVaultArtifactMetadata,
  invokeWorkflowLiveVaultArtifactMetadataWithEvidence,
  normalizeWorkflowLiveVaultArtifactMetadata,
  readWorkflowLiveVaultArtifactMetadata,
} from "../scripts/portal/workflow-live-vault-adapter.js";
import {
  REQUIRED_WORKFLOW_LIVE_GATES,
  WORKFLOW_LIVE_ADAPTER_FLAG,
  type WorkflowActionCatalogEntry,
  type WorkflowLiveReadiness,
} from "../scripts/portal/workflow-live-boundary.js";
import { createCommand } from "../scripts/cli/commands/create.js";
import { createUserCommand } from "../scripts/cli/commands/create-user.js";
import {
  writeVaultDriverSelection,
  writeVaultStatus,
} from "../scripts/output/state-store.js";
import { polarisUsersRoot } from "../scripts/utils/paths.js";
import { PolarisControlStore } from "../scripts/portal/control-store.js";

const USER_ROOT = polarisUsersRoot(import.meta.url);

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

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

async function withSyntheticVault(
  fn: (input: { userId: string; vault: string }) => Promise<void>,
): Promise<void> {
  const userId = uniqueName("workflow-live-metadata-user");
  const vault = uniqueName("workflow-live-metadata-vault");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);
  try {
    await createUserCommand([
      userId,
      "--name",
      "Workflow Live Metadata User",
      "--email",
      `${userId}@polaris.local`,
    ]);
    await createCommand([vault, "--user", userId]);
    await fn({ userId, vault });
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
}

async function withTemporaryStore<T>(
  fn: (store: PolarisControlStore) => Promise<T> | T,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-workflow-live-metadata-"));
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
      capabilities: ["vault.artifact.metadata.read"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    policy: { decision: "allow", mode: "live" },
    dedupeKey: "workflow-live-metadata:tenant-synthetic:run-synthetic",
    event: {
      kind: "submitted",
      title: "Synthetic run submitted",
      detail: "Synthetic workflow live metadata run",
      tone: "neutral",
    },
  });
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

test("the live vault adapter rejects a non-metadata action before reading metadata", async () => {
  let calls = 0;
  const action = {
    ...enabledAction(),
    id: "synthetic.read",
  };
  const result = await invokeWorkflowLiveVaultArtifactMetadata({
    request: request(),
    environment: { [WORKFLOW_LIVE_ADAPTER_FLAG]: "enabled" },
    readiness: completeReadiness(),
    catalog: [action],
    readMetadata: async () => {
      calls += 1;
      return {};
    },
  });
  assert.equal(result.allowed, false);
  assert.equal(calls, 0);
  if (!result.allowed) {
    assert.equal(result.code, "workflow-vault-metadata-action-required");
    assert.deepEqual(result.reasons, ["metadata-action-required"]);
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

test("the default live vault metadata reader projects user-owned Vault status metadata", async () => {
  await withSyntheticVault(async ({ userId, vault }) => {
    writeVaultDriverSelection(vault, { backend: "docker" }, userId);
    writeVaultStatus({
      schemaVersion: 1.1,
      project: vault,
      driver: {
        selected: { backend: "docker" },
        status: "running",
      },
      paseo: {
        daemon: "ready",
        web: "connectable",
        reconnectMode: "reconnectable",
        liveTarget: "https://paseo.example.test/#offer=synthetic",
        reconnectTarget: "https://paseo.example.test/h/synthetic",
      },
      details: {},
      evolution: {
        artifactCount: 2,
        activeVaultArtifacts: 1,
        activeUserArtifacts: 1,
        latestTitles: ["Synthetic run lesson"],
        latestArtifacts: [{
          title: "Synthetic run lesson",
          kind: "vault-memory",
          status: "active",
          whyExists: "recorded by synthetic test",
          whyRetrieved: ["recent"],
          curatorAction: "kept",
        }],
        pendingMemoryChanges: 0,
      },
    }, userId);

    const metadata = readWorkflowLiveVaultArtifactMetadata({
      request: request({
        tenantId: userId,
        vaultId: vault,
        capabilityLease: {
          id: "lease-synthetic",
          packDigest: "sha256:" + "a".repeat(64),
          vaultId: vault,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      }),
      action: enabledAction(),
      decision: {
        allowed: true,
        action: enabledAction(),
        reasons: ["ffi-admission-allowed", "live-gates-complete"],
      },
    });

    assert.equal(metadata.artifactCount, 2);
    assert.equal(metadata.activeVaultArtifacts, 1);
    assert.equal(metadata.activeUserArtifacts, 1);
    assert.deepEqual(metadata.latestTitles, ["Synthetic run lesson"]);
    assert.equal(metadata.latestArtifacts[0]?.title, "Synthetic run lesson");
    assert.equal(metadata.pendingMemoryChanges, 0);
  });
});

test("the default live vault metadata reader rejects cross-user Vault scope", async () => {
  await withSyntheticVault(async ({ userId, vault }) => {
    assert.throws(
      () => readWorkflowLiveVaultArtifactMetadata({
        request: request({
          tenantId: `${userId}-other`,
          vaultId: vault,
          capabilityLease: {
            id: "lease-synthetic",
            packDigest: "sha256:" + "a".repeat(64),
            vaultId: vault,
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        }),
        action: enabledAction(),
        decision: {
          allowed: true,
          action: enabledAction(),
          reasons: ["ffi-admission-allowed", "live-gates-complete"],
        },
      }),
      /user-owned Vault/u,
    );
  });
});

test("durable evidence records one receipt and audit event for an admitted metadata read", async () => {
  await withTemporaryStore(async (store) => {
    createSyntheticRun(store);
    const result = await invokeWorkflowLiveVaultArtifactMetadataWithEvidence({
      store,
      request: request(),
      environment: { [WORKFLOW_LIVE_ADAPTER_FLAG]: "enabled" },
      readiness: completeReadiness(),
      catalog: [enabledAction()],
      readMetadata: () => ({
        artifactCount: 1,
        activeVaultArtifacts: 1,
        activeUserArtifacts: 0,
        latestTitles: ["Synthetic metadata"],
        latestArtifacts: [],
        pendingMemoryChanges: 0,
      }),
    });
    assert.equal(result.allowed, true);

    const run = store.getWorkflowRun("tenant-synthetic", "run-synthetic");
    assert.equal(run?.receipts.length, 1);
    assert.equal(run?.receipts[0]?.requestId, "request-synthetic");
    assert.equal(run?.receipts[0]?.status, "completed");
    assert.deepEqual(store.verifyAuditChain(), { valid: true, checked: 1 });
    const audit = store.listAuditEvents();
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.action, "workflow.live.vault.metadata.read");
    assert.equal(audit[0]?.outcome, "success");
  });
});

test("durable evidence reconciles duplicate metadata request IDs", async () => {
  await withTemporaryStore(async (store) => {
    createSyntheticRun(store);
    const input = {
      store,
      request: request(),
      environment: { [WORKFLOW_LIVE_ADAPTER_FLAG]: "enabled" },
      readiness: completeReadiness(),
      catalog: [enabledAction()],
      readMetadata: () => ({
        artifactCount: 1,
        activeVaultArtifacts: 1,
        activeUserArtifacts: 0,
        latestTitles: ["Synthetic metadata"],
        latestArtifacts: [],
        pendingMemoryChanges: 0,
      }),
    };
    await invokeWorkflowLiveVaultArtifactMetadataWithEvidence(input);
    await invokeWorkflowLiveVaultArtifactMetadataWithEvidence(input);

    const run = store.getWorkflowRun("tenant-synthetic", "run-synthetic");
    assert.equal(run?.receipts.length, 1);
    assert.equal(store.listAuditEvents().length, 1);
    assert.deepEqual(store.verifyAuditChain(), { valid: true, checked: 1 });
  });
});

test("durable evidence leaves the store untouched before admission", async () => {
  await withTemporaryStore(async (store) => {
    createSyntheticRun(store);
    const result = await invokeWorkflowLiveVaultArtifactMetadataWithEvidence({
      store,
      request: request(),
      environment: { [WORKFLOW_LIVE_ADAPTER_FLAG]: "enabled" },
      readiness: { ...completeReadiness(), audit: false },
      catalog: [enabledAction()],
      readMetadata: () => {
        throw new Error("reader should not run");
      },
    });
    assert.equal(result.allowed, false);
    const run = store.getWorkflowRun("tenant-synthetic", "run-synthetic");
    assert.equal(run?.receipts.length, 0);
    assert.equal(store.listAuditEvents().length, 0);
  });
});

test("durable evidence records admitted metadata reader failures", async () => {
  await withTemporaryStore(async (store) => {
    createSyntheticRun(store);
    const result = await invokeWorkflowLiveVaultArtifactMetadataWithEvidence({
      store,
      request: request(),
      environment: { [WORKFLOW_LIVE_ADAPTER_FLAG]: "enabled" },
      readiness: completeReadiness(),
      catalog: [enabledAction()],
      readMetadata: () => {
        throw new Error("synthetic metadata unavailable");
      },
    });
    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.equal(result.code, "live-vault-metadata-read-failed");
    }
    const run = store.getWorkflowRun("tenant-synthetic", "run-synthetic");
    assert.equal(run?.receipts.length, 1);
    assert.equal(run?.receipts[0]?.status, "failed");
    assert.equal(run?.receipts[0]?.errorCode, "live-vault-metadata-read-failed");
    assert.equal(store.listAuditEvents()[0]?.outcome, "failure");
  });
});
