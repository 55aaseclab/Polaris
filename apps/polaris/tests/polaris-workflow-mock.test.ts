import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkflowDomainPackProjection,
  WorkflowVaultProjection,
} from "@polaris/polaris-shell";
import type { PortalVaultSummary } from "../scripts/core/portal.js";
import {
  projectWorkflowVault,
  WorkflowMockError,
  WorkflowMockService,
} from "../scripts/portal/workflow-mock.js";

const PACK: WorkflowDomainPackProjection = {
  id: "FixturePack",
  title: "Fixture Pack",
  category: "Fixture",
  description: "Synthetic workflow fixture.",
  version: "1.2.3",
  digest: "sha256:fixture-pack-digest",
  capabilities: ["Read fixture"],
  accent: "green",
  flows: [
    {
      id: "ApprovalFlow",
      title: "Approval flow",
      summary: "A flow that pauses for approval.",
      estimate: "2 stages",
      approvalRequired: true,
      fields: [{ id: "question", label: "Question", type: "text", placeholder: "", required: true }],
    },
    {
      id: "ReadFlow",
      title: "Read flow",
      summary: "A flow that completes without approval.",
      estimate: "1 stage",
      approvalRequired: false,
      fields: [],
    },
  ],
};

const RUNNING_VAULT: WorkflowVaultProjection = {
  id: "vault-running",
  name: "vault-running",
  description: "Synthetic running Vault.",
  kind: "existing",
  status: "running",
  canRun: true,
  availabilityReason: null,
  profile: "docker",
  capacity: "fixture capacity",
  surfaces: [],
  serverId: null,
  wanghaiId: null,
};

const FAILED_VAULT: WorkflowVaultProjection = {
  ...RUNNING_VAULT,
  id: "vault-failed",
  name: "vault-failed",
  status: "failed",
  canRun: false,
  availabilityReason: "Vault unavailable",
};

function createService(vaults: WorkflowVaultProjection[] = [RUNNING_VAULT]) {
  return new WorkflowMockService({
    listPacks: () => [PACK],
    listVaults: async () => vaults,
    now: () => new Date("2026-08-11T10:00:00.000Z"),
    startDelayMs: 5,
    completionDelayMs: 5,
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertMockError(action: () => Promise<unknown>, code: string, statusCode: number): Promise<void> {
  return assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof WorkflowMockError);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    return true;
  });
}

test("Phase 1 mock runs pin pack metadata, replay events, approval, and artifacts", async () => {
  const service = createService();
  try {
    const created = await service.createRun("tenant-a", {
      packId: PACK.id,
      flowId: "ApprovalFlow",
      vaultId: RUNNING_VAULT.id,
      values: { question: "fixture question" },
    });
    assert.equal(created.status, "queued");
    assert.equal(created.packVersion, PACK.version);
    assert.equal(created.packDigest, PACK.digest);

    await wait(20);
    const waiting = (await service.listRuns("tenant-a")).runs.find((run) => run.id === created.id);
    assert.equal(waiting?.status, "waiting");

    const firstReplay = await service.events("tenant-a", created.id, 0);
    const secondReplay = await service.events("tenant-a", created.id, 0);
    assert.deepEqual(firstReplay.events.map((event) => event.id), secondReplay.events.map((event) => event.id));
    assert.ok(firstReplay.events.every((event) => event.sequence > 0));
    const afterFirst = await service.events("tenant-a", created.id, firstReplay.events.at(-1)?.sequence ?? 0);
    assert.equal(afterFirst.events.length, 0);

    const approved = await service.approve("tenant-a", created.id);
    assert.equal(approved.status, "running");
    await wait(15);
    const completed = (await service.listRuns("tenant-a")).runs.find((run) => run.id === created.id);
    assert.equal(completed?.status, "succeeded");
    assert.equal(completed?.artifacts.length, 1);
    assert.match(completed?.artifacts[0]?.digest ?? "", /^sha256:/u);
  } finally {
    service.close();
  }
});

test("Phase 1 mock models quota denial, unavailable Vaults, and executor failure retry", async () => {
  const service = createService([RUNNING_VAULT, FAILED_VAULT]);
  try {
    await assertMockError(
      () => service.createRun("tenant-a", {
        packId: PACK.id,
        flowId: "ReadFlow",
        vaultId: RUNNING_VAULT.id,
        values: {},
        scenario: "quota-denied",
      }),
      "quota-denied",
      429,
    );
    await assertMockError(
      () => service.createRun("tenant-a", {
        packId: PACK.id,
        flowId: "ReadFlow",
        vaultId: FAILED_VAULT.id,
        values: {},
      }),
      "vault-unavailable",
      409,
    );

    const failed = await service.createRun("tenant-a", {
      packId: PACK.id,
      flowId: "ReadFlow",
      vaultId: RUNNING_VAULT.id,
      values: {},
      scenario: "executor-failure",
    });
    await wait(20);
    const failedProjection = (await service.listRuns("tenant-a")).runs.find((run) => run.id === failed.id);
    assert.equal(failedProjection?.status, "failed");
    assert.equal(failedProjection?.error?.code, "executor-failure");

    const retry = await service.retry("tenant-a", failed.id, "normal");
    assert.equal(retry.id, failed.id);
    assert.equal(retry.source, "retry");
    await wait(20);
    const retryProjection = (await service.listRuns("tenant-a")).runs.find((run) => run.id === retry.id);
    assert.equal(retryProjection?.status, "succeeded");
  } finally {
    service.close();
  }
});

test("Phase 1 mock cancellation and tenant scope preserve run ownership", async () => {
  const service = createService();
  try {
    const created = await service.createRun("tenant-a", {
      packId: PACK.id,
      flowId: "ReadFlow",
      vaultId: RUNNING_VAULT.id,
      values: {},
    });
    const cancelled = await service.cancel("tenant-a", created.id);
    assert.equal(cancelled.status, "cancelled");
    await assertMockError(
      () => service.events("tenant-b", created.id),
      "run-not-found",
      404,
    );
    await assertMockError(
      () => service.cancel("tenant-a", created.id),
      "cancel-not-available",
      409,
    );
  } finally {
    service.close();
  }
});

test("real Portal Vault summaries become workflow Vault projections", () => {
  const summary: PortalVaultSummary = {
    name: "fixture-real-vault",
    surfaces: ["paseo"],
    serverId: "fixture-server",
    wanghaiId: null,
    drivers: [{ backend: "docker" }],
    status: {
      project: "fixture-real-vault",
      driver: {
        selected: { backend: "docker" },
        status: "running",
        reason: "ready for work",
      },
      paseo: {
        daemon: "ready",
        web: "connectable",
        reconnectMode: "reconnectable",
        liveTarget: null,
        reconnectTarget: null,
      },
      details: {
        capacity: "2 slots",
      },
    },
  };
  const projection = projectWorkflowVault(summary);
  assert.deepEqual(projection, {
    id: "fixture-real-vault",
    name: "fixture-real-vault",
    description: "ready for work",
    kind: "existing",
    status: "running",
    canRun: true,
    availabilityReason: null,
    profile: "docker",
    capacity: "2 slots",
    surfaces: ["paseo"],
    serverId: "fixture-server",
    wanghaiId: null,
  });
});

test("workflow Vault projection preserves stopped canonical state and denies execution", () => {
  const summary: PortalVaultSummary = {
    name: "fixture-stopped-vault",
    surfaces: [],
    serverId: null,
    wanghaiId: null,
    drivers: [{ backend: "docker" }],
    status: {
      project: "fixture-stopped-vault",
      driver: {
        selected: { backend: "docker" },
        status: "stopped",
        reason: "stopped by owner",
      },
      paseo: {
        daemon: "absent",
        web: "unavailable",
        reconnectMode: "unknown",
        liveTarget: null,
        reconnectTarget: null,
      },
    },
  };
  const projection = projectWorkflowVault(summary);
  assert.equal(projection.status, "stopped");
  assert.equal(projection.canRun, false);
  assert.equal(projection.availabilityReason, "stopped by owner");
});
