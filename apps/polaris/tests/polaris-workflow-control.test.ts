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
import type { HostLiteratureReviewExecutor } from "../scripts/portal/literature-review-host.js";
import {
  WORKFLOW_LIVE_ADAPTER_FLAG,
  WORKFLOW_LIVE_WORKER_BINDING_FLAG,
  WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
} from "../scripts/portal/workflow-live-boundary.js";
import type {
  WorkflowLiveVaultArtifactMetadataReader,
} from "../scripts/portal/workflow-live-vault-adapter.js";
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
  in {
    title: String
    instructions: String
  }
  out {
    approved: Boolean
    reviewId: ID
  }
  effect human
}

flow Review title "Synthetic review" create {
  needs { ReviewPlan }
  input {
    subject: String required
  }
  steps {
    review "Review" {
      uses { subject }
      call ReviewPlan
      output {
        approved: Boolean
        reviewId: ID
      }
    }
  }
  output {
    approved: Boolean from approved
    reviewId: ID from reviewId
  }
  ui { layout form primary "Review" }
}

flow Summarize title "Synthetic summary" create {
  input {
    subject: String required
  }
  steps {
    summarize "Summarize" {
      uses { subject }
      output {
        summary: String
      }
    }
  }
  output {
    summary: String from summary
  }
  ui { layout form primary "Summarize" }
}
`;

const METADATA_PACK_SOURCE = `
domain MetadataPack version "1.0.0"
title "Synthetic metadata pack"
description "Synthetic live metadata workflow fixture"

port ArtifactMetadata version "1.0.0" {
  in {
    artifactScope: String?
  }
  out {
    artifactCount: Number
    latestTitles: String
    pendingMemoryChanges: Number
  }
  effect read
}

flow ReadMetadata title "Read metadata" create {
  needs { ArtifactMetadata }
  input {
    artifactScope: String
  }
  steps {
    metadata "Read metadata" {
      uses { artifactScope }
      call ArtifactMetadata
      output {
        artifactCount: Number
        latestTitles: String
        pendingMemoryChanges: Number
      }
    }
  }
  output {
    artifactCount: Number from artifactCount
    latestTitles: String from latestTitles
    pendingMemoryChanges: Number from pendingMemoryChanges
  }
  ui { layout form primary "Read" }
}
`;

const HOST_LITERATURE_PACK_SOURCE = `
domain AutoResearch version "1.0.0"
title "Literature Review"
description "Synthetic host Literature Review pack"

flow LiteratureReview title "文献综述" create {
  input { brief: String required }
  steps {
    intake "Research intake" {
      uses { brief }
      output { result: String }
    }
  }
  output { result: String from result }
  ui { layout form primary "开始综述" }
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
  const keys = [
    "NODE_ENV",
    "POLARIS_DATA_ROOT",
    "POLARIS_CONTROL_STORE_PATH",
    "POLARIS_WORKFLOW_LIVE_ADAPTER",
    "POLARIS_WORKFLOW_LIVE_WORKER_BINDING",
    "POLARIS_RELEASE_ID",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = "test";
  process.env.POLARIS_DATA_ROOT = path.join(root, "data");
  process.env.POLARIS_CONTROL_STORE_PATH = path.join(root, "control.sqlite");
  delete process.env.POLARIS_WORKFLOW_LIVE_ADAPTER;
  delete process.env.POLARIS_WORKFLOW_LIVE_WORKER_BINDING;
  delete process.env.POLARIS_RELEASE_ID;
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
  return installPack(sourcePath);
}

async function installSyntheticMetadataPack(root: string): Promise<WorkflowDomainPackProjection> {
  const sourcePath = path.join(root, "metadata-pack.ord");
  fs.writeFileSync(sourcePath, METADATA_PACK_SOURCE, "utf8");
  return installPack(sourcePath);
}

async function installPack(sourcePath: string): Promise<WorkflowDomainPackProjection> {
  const installed = await addDomainPack(import.meta.url, sourcePath);
  const projection = listDomainPackProjections(import.meta.url).find(
    (pack) => pack.id === installed.pack.id,
  );
  assert.ok(projection);
  return projection;
}

function serviceFor(
  pack: WorkflowDomainPackProjection,
  options: {
    autoStart?: boolean;
    liveMetadataReader?: WorkflowLiveVaultArtifactMetadataReader;
    vaults?: WorkflowVaultProjection[];
    listVaults?: (tenantId: string) => Promise<WorkflowVaultProjection[]>;
    hostLiteratureReview?: HostLiteratureReviewExecutor;
  } = {},
): WorkflowControlService {
  return new WorkflowControlService({
    importMetaUrl: import.meta.url,
    listPacks: () => [pack],
    listVaults: options.listVaults ?? (async () => options.vaults ?? [syntheticVault()]),
    autoStart: options.autoStart ?? false,
    liveMetadataReader: options.liveMetadataReader,
    hostLiteratureReview: options.hostLiteratureReview,
  });
}

test("driver=none executes a durable workflow on the Polaris host without a Vault", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installSyntheticPack(fixture.root);
    service = serviceFor(pack, { vaults: [] });
    const admitted = await service.createRun("tenant-host", {
      packId: pack.id,
      flowId: "Summarize",
      driver: "none",
      values: { subject: "host execution" },
    });

    assert.equal(admitted.driver, "none");
    assert.equal(admitted.vaultId, null);
    assert.equal(admitted.vaultName, "Polaris host");

    const listed = await service.listRuns("tenant-host");
    const completed = listed.runs.find((run) => run.id === admitted.id);
    assert.equal(completed?.status, "succeeded");
    assert.equal(completed?.driver, "none");
    assert.equal(completed?.vaultId, null);
    assert.equal(completed?.policy.reasons.includes("host-execution"), true);
    assert.equal(completed?.artifacts.length, 1);
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("driver=none rejects an accidental Vault target", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installSyntheticPack(fixture.root);
    service = serviceFor(pack);
    await assert.rejects(
      () => service!.createRun("tenant-host", {
        packId: pack.id,
        flowId: "Summarize",
        driver: "none",
        vaultId: "vault-synthetic",
        values: { subject: "conflict" },
      }),
      (error: unknown) => error instanceof WorkflowControlError && error.code === "host-driver-vault-conflict",
    );
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("AutoResearch LiteratureReview uses the real host adapter without consulting Vaults", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let service: WorkflowControlService | undefined;
  try {
    const sourcePath = path.join(fixture.root, "host-literature-pack.ord");
    fs.writeFileSync(sourcePath, HOST_LITERATURE_PACK_SOURCE, "utf8");
    const pack = await installPack(sourcePath);
    let receivedBrief = "";
    const hostLiteratureReview: HostLiteratureReviewExecutor = async ({ run, onProgress }) => {
      receivedBrief = run.input.brief ?? "";
      onProgress?.({ progress: 40, stage: "collection", detail: "synthetic collection" });
      return {
        status: "succeeded",
        output: { execution: "host", status: "succeeded" },
        artifacts: [{
          id: "artifact-host-literature",
          name: "report.md",
          kind: "report",
          size: "1 B",
          summary: "real host adapter result",
          content: "# Real host report",
          digest: "sha256:synthetic",
          redacted: false,
        }],
        receipts: [{
          id: "receipt-host-literature",
          requestId: "host-request",
          port: "LiteratureReviewHost",
          version: "1.0.0",
          effect: "ffi",
          status: "completed",
          input: {},
          output: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:00.000Z",
        }],
      };
    };
    service = serviceFor(pack, { vaults: [], hostLiteratureReview });
    const admitted = await service.createRun("tenant-host-literature", {
      packId: pack.id,
      flowId: "LiteratureReview",
      driver: "none",
      values: { brief: "bounded workflow evidence" },
    });
    assert.equal(admitted.policy.mode, "host");
    assert.equal(admitted.approvalRequired, false);
    const deadline = Date.now() + 2_000;
    let completed: Awaited<ReturnType<typeof service.getRun>> | undefined;
    while (Date.now() < deadline) {
      const candidate = (await service.listRuns("tenant-host-literature")).runs.find(
        (run) => run.id === admitted.id,
      );
      if (!candidate) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      if (candidate.status === "succeeded") {
        completed = candidate;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(completed?.status, "succeeded");
    assert.equal(completed?.policy.mode, "host");
    assert.equal(completed?.artifacts[0]?.content, "# Real host report");
    assert.equal(receivedBrief, "bounded workflow evidence");
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("host run listing remains available when an optional Vault projection fails", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installSyntheticPack(fixture.root);
    let vaultReads = 0;
    service = serviceFor(pack, {
      listVaults: async () => {
        vaultReads += 1;
        throw new Error("synthetic Vault observer failure");
      },
    });
    const admitted = await service.createRun("tenant-host-resilient", {
      packId: pack.id,
      flowId: "Summarize",
      driver: "none",
      values: { subject: "host remains available" },
    });
    const listed = await service.listRuns("tenant-host-resilient");
    const completed = listed.runs.find((run) => run.id === admitted.id);
    assert.equal(completed?.status, "succeeded");
    assert.equal(vaultReads, 0);
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("host run reads return while native Literature Review work is still running", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let service: WorkflowControlService | undefined;
  let releaseExecution = () => undefined;
  try {
    const sourcePath = path.join(fixture.root, "host-literature-long-pack.ord");
    fs.writeFileSync(sourcePath, HOST_LITERATURE_PACK_SOURCE, "utf8");
    const pack = await installPack(sourcePath);
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    let fallbackRelease: NodeJS.Timeout | undefined;
    const blocked = new Promise<void>((resolve) => {
      fallbackRelease = setTimeout(resolve, 5_000);
      releaseExecution = () => {
        if (fallbackRelease) clearTimeout(fallbackRelease);
        resolve();
      };
    });
    service = serviceFor(pack, {
      vaults: [],
      autoStart: true,
      hostLiteratureReview: async ({ onProgress }) => {
        onProgress?.({ progress: 24, stage: "collection", detail: "synthetic long-running collection" });
        resolveStarted();
        await blocked;
        return { status: "succeeded", output: { execution: "host" }, artifacts: [], receipts: [] };
      },
    });
    const admitted = await service.createRun("tenant-host-long", {
      packId: pack.id,
      flowId: "LiteratureReview",
      driver: "none",
      values: { brief: "bounded long-running host review" },
    });
    await started;

    let timeout: NodeJS.Timeout | undefined;
    const listed = await Promise.race([
      service.listRuns("tenant-host-long"),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("host run listing waited for execution")), 500);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    assert.equal(listed.runs.find((run) => run.id === admitted.id)?.status, "running");
    releaseExecution();

    const deadline = Date.now() + 2_000;
    let completed = false;
    while (Date.now() < deadline) {
      if ((await service.getRun("tenant-host-long", admitted.id)).status === "succeeded") {
        completed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(completed, true);
    if (fallbackRelease) clearTimeout(fallbackRelease);
  } finally {
    releaseExecution();
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("workflow setup can be completed for host execution without a Vault", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installSyntheticPack(fixture.root);
    service = serviceFor(pack, { vaults: [] });
    const setup = await service.saveSetup("tenant-host-setup", {
      completed: true,
      domainPackId: pack.id,
      vaultId: null,
      enabledWorkflowKeys: [`${pack.id}:Summarize`],
      completedAt: null,
    });
    assert.equal(setup.completed, true);
    assert.equal(setup.vaultId, null);
    assert.equal((await service.listRuns("tenant-host-setup")).runs.length, 0);
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

function createLiveMetadataRun(pack: WorkflowDomainPackProjection): string {
  const runId = `run-live-metadata-${Date.now()}`;
  const store = PolarisControlStore.open(process.env.POLARIS_CONTROL_STORE_PATH!);
  try {
    store.createWorkflowRun({
      id: runId,
      tenantId: "tenant-synthetic",
      vaultId: "vault-synthetic",
      vaultName: "Synthetic Vault",
      packId: pack.id,
      packVersion: pack.version,
      packDigest: pack.digest,
      flowId: "ReadMetadata",
      source: "manual",
      priority: "normal",
      input: { artifactScope: "recent" },
      approvalRequired: false,
      executionClass: "ai",
      capabilityLease: {
        id: `lease-${runId}`,
        capabilities: [WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID],
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      policy: {
        decision: "allow",
        mode: "live",
        reasons: [
          "pack-digest-pinned",
          "vault-capability-lease",
          "candidate-live-metadata",
        ],
      },
      dedupeKey: `workflow-live-metadata:tenant-synthetic:${runId}`,
      event: {
        kind: "submitted",
        title: "Synthetic live metadata run submitted",
        detail: "Synthetic live metadata run",
        tone: "neutral",
      },
    });
  } finally {
    store.close();
  }
  return runId;
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

test("a durable live-policy metadata run invokes the candidate worker binding", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installSyntheticMetadataPack(fixture.root);
    const runId = createLiveMetadataRun(pack);
    let calls = 0;
    process.env[WORKFLOW_LIVE_ADAPTER_FLAG] = "enabled";
    process.env[WORKFLOW_LIVE_WORKER_BINDING_FLAG] = "enabled";
    process.env.POLARIS_RELEASE_ID = "release-synthetic";
    service = serviceFor(pack, {
      liveMetadataReader: ({ request }) => {
        calls += 1;
        assert.equal(request.input.artifactScope, "recent");
        return {
          artifactCount: 2,
          activeVaultArtifacts: 1,
          activeUserArtifacts: 1,
          latestTitles: ["Synthetic metadata"],
          latestArtifacts: [],
          pendingMemoryChanges: 1,
        };
      },
    });

    const listed = await service.listRuns("tenant-synthetic");
    const completed = listed.runs.find((run) => run.id === runId);
    assert.equal(completed?.status, "succeeded");
    assert.equal(completed?.policy.mode, "live");
    assert.equal(completed?.receipts.length, 1);
    assert.equal(completed?.receipts[0]?.port, "ArtifactMetadata");
    assert.equal(completed?.receipts[0]?.status, "completed");
    assert.equal(completed?.artifacts.length, 1);
    assert.equal(calls, 1);

    const store = PolarisControlStore.open(process.env.POLARIS_CONTROL_STORE_PATH!);
    try {
      const stored = store.getWorkflowRun("tenant-synthetic", runId);
      assert.equal(stored?.output.artifactCount, 2);
      assert.equal(stored?.output.latestTitles, "Synthetic metadata");
      assert.equal(stored?.output.pendingMemoryChanges, 1);
      assert.equal(stored?.receipts.length, 1);
      assert.equal(stored?.receipts[0]?.output.artifactCount, 2);
      assert.equal(store.listAuditEvents().length, 1);
      assert.deepEqual(store.verifyAuditChain(), { valid: true, checked: 1 });
    } finally {
      store.close();
    }
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("operator live admission creates a durable live-policy metadata run", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installSyntheticMetadataPack(fixture.root);
    let calls = 0;
    process.env[WORKFLOW_LIVE_ADAPTER_FLAG] = "enabled";
    process.env[WORKFLOW_LIVE_WORKER_BINDING_FLAG] = "enabled";
    process.env.POLARIS_RELEASE_ID = "release-synthetic";
    service = serviceFor(pack, {
      liveMetadataReader: ({ request }) => {
        calls += 1;
        assert.equal(request.input.artifactScope, "recent");
        return {
          artifactCount: 3,
          activeVaultArtifacts: 2,
          activeUserArtifacts: 1,
          latestTitles: ["Admitted metadata"],
          latestArtifacts: [],
          pendingMemoryChanges: 2,
        };
      },
    });

    const admitted = await service.admitLiveMetadataRun("tenant-synthetic", {
      operatorId: "operator-synthetic",
      vaultId: "vault-synthetic",
      packId: pack.id,
      flowId: "ReadMetadata",
      values: { artifactScope: "recent" },
      candidateLiveEnabled: true,
      releaseId: "release-synthetic",
      dedupeKey: "workflow-live-metadata-admission:test",
    });
    assert.equal(admitted.status, "queued");
    assert.equal(admitted.policy.mode, "live");
    assert.deepEqual(admitted.policy.reasons, [
      "operator-live-admission",
      "candidate-live-metadata",
      "pack-digest-pinned",
      "vault-capability-lease",
      "release:release-synthetic",
    ]);

    const listed = await service.listRuns("tenant-synthetic");
    const completed = listed.runs.find((run) => run.id === admitted.id);
    assert.equal(completed?.status, "succeeded");
    assert.equal(completed?.policy.mode, "live");
    assert.equal(completed?.receipts.length, 1);
    assert.equal(completed?.receipts[0]?.port, "ArtifactMetadata");
    assert.equal(completed?.artifacts.length, 1);
    assert.equal(calls, 1);

    const store = PolarisControlStore.open(process.env.POLARIS_CONTROL_STORE_PATH!);
    try {
      const stored = store.getWorkflowRun("tenant-synthetic", admitted.id);
      assert.equal(stored?.output.artifactCount, 3);
      assert.equal(stored?.output.latestTitles, "Admitted metadata");
      assert.equal(stored?.output.pendingMemoryChanges, 2);
      assert.deepEqual(
        store.listAuditEvents().map((event) => event.action).sort(),
        [
          "workflow.live.admit",
          "workflow.live.vault.metadata.read",
        ],
      );
      assert.deepEqual(store.verifyAuditChain(), { valid: true, checked: 2 });
    } finally {
      store.close();
    }
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("operator live admission rejects non-metadata workflow calls before persistence", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installSyntheticPack(fixture.root);
    process.env[WORKFLOW_LIVE_ADAPTER_FLAG] = "enabled";
    process.env[WORKFLOW_LIVE_WORKER_BINDING_FLAG] = "enabled";
    service = serviceFor(pack);

    await assert.rejects(
      () => service!.admitLiveMetadataRun("tenant-synthetic", {
        operatorId: "operator-synthetic",
        vaultId: "vault-synthetic",
        packId: pack.id,
        flowId: "Review",
        values: { subject: "synthetic" },
        candidateLiveEnabled: true,
        releaseId: "release-synthetic",
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowControlError);
        assert.equal(error.code, "live-flow-call-not-supported");
        assert.equal(error.statusCode, 400);
        return true;
      },
    );

    const store = PolarisControlStore.open(process.env.POLARIS_CONTROL_STORE_PATH!);
    try {
      assert.equal(store.listWorkflowRuns("tenant-synthetic").length, 0);
      assert.equal(store.listAuditEvents().length, 0);
    } finally {
      store.close();
    }
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("a durable live-policy metadata run fails closed when live flags are unset", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installSyntheticMetadataPack(fixture.root);
    const runId = createLiveMetadataRun(pack);
    let calls = 0;
    service = serviceFor(pack, {
      liveMetadataReader: () => {
        calls += 1;
        return {};
      },
    });

    const listed = await service.listRuns("tenant-synthetic");
    const failed = listed.runs.find((run) => run.id === runId);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.policy.mode, "live");
    assert.equal(failed?.error?.code, "workflow-execution-failed");
    assert.match(
      failed?.error?.message ?? "",
      /Workflow live metadata worker binding is disabled by deployment policy/u,
    );
    assert.equal(failed?.receipts.length, 0);
    assert.equal(failed?.artifacts.length, 0);
    assert.equal(calls, 0);

    const store = PolarisControlStore.open(process.env.POLARIS_CONTROL_STORE_PATH!);
    try {
      assert.equal(store.getWorkflowRun("tenant-synthetic", runId)?.receipts.length, 0);
      assert.equal(store.listAuditEvents().length, 0);
    } finally {
      store.close();
    }
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
