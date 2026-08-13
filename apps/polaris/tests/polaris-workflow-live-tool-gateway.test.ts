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
  type WorkflowActionCatalogEntry,
  type WorkflowLiveReadiness,
} from "../scripts/portal/workflow-live-boundary.js";
import {
  invokeWorkflowLiveTool,
  invokeWorkflowLiveToolWithEvidence,
  type WorkflowLiveToolDefinition,
} from "../scripts/portal/workflow-live-tool-gateway.js";

type SyntheticOutput = {
  count: number;
};

const SYNTHETIC_ACTION_ID = "synthetic.projection.read";
const SYNTHETIC_EXECUTOR_FAMILY = "polaris.projection";

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
      port: "SyntheticProjection",
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

function action(
  overrides: Partial<WorkflowActionCatalogEntry> = {},
): WorkflowActionCatalogEntry {
  return {
    id: SYNTHETIC_ACTION_ID,
    version: 1,
    port: "SyntheticProjection",
    portVersion: "1.0.0",
    effect: "read",
    risk: "read",
    adapter: SYNTHETIC_EXECUTOR_FAMILY,
    liveEnabled: true,
    requiredGates: REQUIRED_WORKFLOW_LIVE_GATES,
    description: "Synthetic projection action.",
    ...overrides,
  };
}

function tool(): WorkflowLiveToolDefinition<SyntheticOutput> {
  return {
    actionId: SYNTHETIC_ACTION_ID,
    executorFamily: SYNTHETIC_EXECUTOR_FAMILY,
    auditAction: "workflow.live.synthetic.projection.read",
    failureReason: "synthetic-read-failed",
    timeoutReason: "synthetic-read-timeout",
    execute: () => ({ count: 1 }),
    normalize: (value) => ({
      count: Number((value as { count?: unknown } | null)?.count ?? 0),
    }),
    receiptOutput: (output) => ({ count: output.count }),
  };
}

async function withTemporaryStore<T>(
  fn: (store: PolarisControlStore) => Promise<T> | T,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-workflow-live-tool-"));
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
      capabilities: [SYNTHETIC_ACTION_ID],
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    policy: { decision: "allow", mode: "live" },
    dedupeKey: "workflow-live-tool:tenant-synthetic:run-synthetic",
    event: {
      kind: "submitted",
      title: "Synthetic run submitted",
      detail: "Synthetic live tool gateway run",
      tone: "neutral",
    },
  });
}

test("live tool gateway does not call the executor before admission", async () => {
  let calls = 0;
  const result = await invokeWorkflowLiveTool({
    request: request(),
    environment: { [WORKFLOW_LIVE_ADAPTER_FLAG]: "enabled" },
    readiness: { ...readiness(), audit: false },
    catalog: [action()],
    tool: tool(),
    execute: () => {
      calls += 1;
      return { count: 1 };
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(calls, 0);
  if (!result.allowed) {
    assert.equal(result.code, "live-adapter-gates-incomplete");
    assert.deepEqual(result.reasons, ["audit"]);
  }
});

test("live tool gateway rejects action and executor-family mismatches", async () => {
  let calls = 0;
  const result = await invokeWorkflowLiveTool({
    request: request(),
    environment: { [WORKFLOW_LIVE_ADAPTER_FLAG]: "enabled" },
    readiness: readiness(),
    catalog: [action({ adapter: "polaris.human" })],
    tool: tool(),
    execute: () => {
      calls += 1;
      return { count: 1 };
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(calls, 0);
  if (!result.allowed) {
    assert.equal(result.code, "workflow-live-tool-action-required");
    assert.deepEqual(result.reasons, ["tool-action-required"]);
  }
});

test("live tool gateway records one durable receipt and audit event", async () => {
  await withTemporaryStore(async (store) => {
    createSyntheticRun(store);
    const result = await invokeWorkflowLiveToolWithEvidence({
      store,
      request: request(),
      environment: { [WORKFLOW_LIVE_ADAPTER_FLAG]: "enabled" },
      readiness: readiness(),
      catalog: [action()],
      tool: tool(),
      execute: () => ({ count: 7 }),
    });

    assert.equal(result.allowed, true);
    const run = store.getWorkflowRun("tenant-synthetic", "run-synthetic");
    assert.equal(run?.receipts.length, 1);
    assert.equal(run?.receipts[0]?.status, "completed");
    assert.deepEqual(run?.receipts[0]?.output, { count: 7 });
    const audit = store.listAuditEvents();
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.action, "workflow.live.synthetic.projection.read");
    assert.equal(audit[0]?.outcome, "success");
    assert.deepEqual(store.verifyAuditChain(), { valid: true, checked: 1 });
  });
});

test("live tool gateway leaves the store untouched before admission", async () => {
  await withTemporaryStore(async (store) => {
    createSyntheticRun(store);
    const result = await invokeWorkflowLiveToolWithEvidence({
      store,
      request: request(),
      environment: { [WORKFLOW_LIVE_ADAPTER_FLAG]: "enabled" },
      readiness: { ...readiness(), rollback: false },
      catalog: [action()],
      tool: tool(),
      execute: () => {
        throw new Error("executor should not run");
      },
    });

    assert.equal(result.allowed, false);
    const run = store.getWorkflowRun("tenant-synthetic", "run-synthetic");
    assert.equal(run?.receipts.length, 0);
    assert.equal(store.listAuditEvents().length, 0);
  });
});
