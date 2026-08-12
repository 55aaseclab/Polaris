import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addDomainPack,
  listDomainPackProjections,
} from "../scripts/config/domain-packs.js";
import {
  closePolarisControlStore,
  PolarisControlStore,
} from "../scripts/portal/control-store.js";
import {
  WorkflowControlError,
  WorkflowControlService,
} from "../scripts/portal/workflow-control.js";
import type {
  WorkflowDomainPackProjection,
  WorkflowVaultProjection,
} from "@polaris/polaris-shell";

const DOMAIN_PACK_SOURCE = `
domain ReviewPack version "1.0.0"
title "Synthetic review pack"
description "Synthetic workflow fixture"

port ReviewPlan version "1.0.0" {
  builtin manual.review
  in { title: String, instructions: String }
  out { approved: Boolean, reviewId: ID }
  effect human
}

flow Review title "Synthetic review" create {
  needs { ReviewPlan }
  input { subject: String required }
  steps {
    review "Review" {
      uses { subject }
      call ReviewPlan
      output { approved: Boolean, reviewId: ID }
    }
  }
  output { approved: Boolean from approved, reviewId: ID from reviewId }
  ui { layout form primary "Review" }
}

flow Summarize title "Synthetic summary" create {
  input { subject: String required }
  steps {
    summarize "Summarize" {
      uses { subject }
      output { summary: String }
    }
  }
  output { summary: String from summary }
  ui { layout form primary "Summarize" }
}
`;

function syntheticVault(id = "vault-synthetic"): WorkflowVaultProjection {
  return {
    id,
    name: id,
    description: "Synthetic executable Vault",
    kind: "existing",
    status: "running",
    canRun: true,
    availabilityReason: null,
    profile: "Synthetic / test",
    capacity: "Synthetic capacity",
    surfaces: [],
    serverId: null,
    wanghaiId: null,
  };
}

function testEnvironment(): { root: string; previous: Record<string, string | undefined> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-workflow-control-"));
  const keys = ["NODE_ENV", "POLARIS_DATA_ROOT", "POLARIS_CONTROL_STORE_PATH"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = "test";
  process.env.POLARIS_DATA_ROOT = path.join(root, "data");
  process.env.POLARIS_CONTROL_STORE_PATH = path.join(root, "control.sqlite");
  return { root, previous };
}

function restoreEnvironment(fixture: ReturnType<typeof testEnvironment>): void {
  for (const [key, value] of Object.entries(fixture.previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  closePolarisControlStore();
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

async function installSyntheticPack(root: string): Promise<WorkflowDomainPackProjection> {
  const sourcePath = path.join(root, "review-pack.ord");
  fs.writeFileSync(sourcePath, DOMAIN_PACK_SOURCE, "utf8");
  const installed = await addDomainPack(import.meta.url, sourcePath);
  const projection = listDomainPackProjections(import.meta.url).find(
    (pack) => pack.id === installed.pack.id,
  );
  assert.ok(projection);
  return projection;
}

function serviceFor(
  pack: WorkflowDomainPackProjection,
  options: { autoStart?: boolean } = {},
): WorkflowControlService {
  return new WorkflowControlService({
    importMetaUrl: import.meta.url,
    listPacks: () => [pack],
    listVaults: async () => [syntheticVault()],
    autoStart: options.autoStart ?? false,
  });
}

test("setup atomically enqueues every enabled flow and completes manual review", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installSyntheticPack(fixture.root);
    service = serviceFor(pack);
    const setup = await service.saveSetup("tenant-synthetic", {
      completed: true,
      domainPackId: pack.id,
      vaultId: "vault-synthetic",
      enabledWorkflowKeys: [`${pack.id}:Review`, `${pack.id}:Summarize`],
      completedAt: null,
    });
    assert.equal(setup.completed, true);

    const first = await service.listRuns("tenant-synthetic");
    assert.equal(first.runs.length, 2);
    assert.deepEqual(
      new Set(first.runs.map((run) => run.source)),
      new Set(["provisioning"]),
    );
    const review = first.runs.find((run) => run.flowId === "Review");
    const summary = first.runs.find((run) => run.flowId === "Summarize");
    assert.equal(review?.status, "waiting");
    assert.equal(summary?.status, "succeeded");
    assert.equal(summary?.artifacts.length, 1);
    assert.match(summary?.artifacts[0]?.digest ?? "", /^sha256:[a-f0-9]{64}$/u);
    assert.equal(review?.receipts[0]?.status, "waiting");
    assert.match(review?.capabilityLeaseId ?? "", /^lease-/u);
    assert.equal(review?.policy.mode, "mock");
    const replay = await service.events("tenant-synthetic", review!.id, 0);
    assert.equal(replay.events.length, 2);
    assert.equal(replay.events[0]?.kind, "submitted");

    const repeated = await service.listRuns("tenant-synthetic");
    assert.equal(repeated.runs.length, 2);
    assert.equal(repeated.replayCursor >= 2, true);

    service.close();
    closePolarisControlStore();
    service = serviceFor(pack);
    const reopened = await service.listRuns("tenant-synthetic");
    assert.equal(reopened.runs.length, 2);
    assert.equal(reopened.runs.find((run) => run.flowId === "Summarize")?.artifacts.length, 1);

    assert.ok(review);
    const approved = await service.approve("tenant-synthetic", review.id);
    assert.equal(approved.status, "running");
    const completed = await service.listRuns("tenant-synthetic");
    const completedReview = completed.runs.find((run) => run.id === review.id);
    assert.equal(completedReview?.status, "succeeded");
    assert.equal(completedReview?.artifacts.length, 1);
    assert.equal(completedReview?.events.some((event) => event.kind === "approved"), true);
    const postApprovalEvents = await service.events("tenant-synthetic", review.id, replay.nextCursor);
    assert.equal(postApprovalEvents.events.some((event) => event.kind === "approved"), true);

    const suggestion = await service.createSuggestion("tenant-synthetic", completedReview!.id);
    assert.equal(suggestion.status, "suggested");
    assert.deepEqual(suggestion.evidence.includes(completedReview!.id), true);
    assert.equal(service.listSuggestions("tenant-synthetic").length, 1);
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("workflow cancellation, retry, tenant isolation, and lease denial are durable", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installSyntheticPack(fixture.root);
    service = serviceFor(pack);
    const queued = await service.createRun("tenant-a", {
      packId: pack.id,
      flowId: "Summarize",
      vaultId: "vault-synthetic",
      values: { subject: "synthetic" },
      scenario: "executor-failure",
    });
    const cancelled = await service.cancel("tenant-a", queued.id);
    assert.equal(cancelled.status, "cancelled");
    await assert.rejects(
      () => service!.getRun("tenant-b", queued.id),
      (error: unknown) => error instanceof WorkflowControlError && error.code === "run-not-found",
    );

    const retried = await service.retry("tenant-a", queued.id);
    assert.equal(retried.source, "retry");
    const store = PolarisControlStore.open(process.env.POLARIS_CONTROL_STORE_PATH!);
    assert.equal(store.revokeWorkflowCapabilityLease("tenant-a", retried.capabilityLeaseId), true);
    store.close();
    const denied = await service.listRuns("tenant-a");
    const deniedRun = denied.runs.find((run) => run.id === retried.id);
    assert.equal(deniedRun?.status, "failed");
    assert.equal(deniedRun?.error?.code, "capability-lease-invalid");
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("a reviewed source digest is required before admission", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installSyntheticPack(fixture.root);
    const drifted = { ...pack, digest: "sha256:" + "0".repeat(64) };
    service = serviceFor(drifted);
    await assert.rejects(
      () => service!.createRun("tenant-synthetic", {
        packId: drifted.id,
        flowId: "Summarize",
        vaultId: "vault-synthetic",
        values: { subject: "synthetic" },
      }),
      (error: unknown) => error instanceof WorkflowControlError && error.code === "pack-pin-unavailable",
    );
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});
