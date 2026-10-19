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
} from "../scripts/portal/workflow/workflow-control.js";
import {
  WORKFLOW_LIVE_ADAPTER_FLAG,
  WORKFLOW_LIVE_WORKER_BINDING_FLAG,
  WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
} from "../scripts/portal/workflow/workflow-live-boundary.js";
import type {
  WorkflowLiveVaultArtifactMetadataReader,
} from "../scripts/portal/workflow/workflow-live-vault-adapter.js";
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

const THREADING_PACK_SOURCE = `
domain ThreadPack version "1.0.0"
title "Synthetic threading pack"
description "Synthetic host-mode tool failure threading fixture"

port CveProcess version "1.0.0" {
  in {
    cveId: String
    cveDescription: String?
  }
  out {
    knowledgeRef: String
    rootCauseRef: String
    processorStatus: String
  }
  effect ffi
  binding { tool "cve.processor" }
}

flow BuildKnowledge title "Build knowledge" create {
  input {
    cveId: String required
    cveDescription: String required
  }
  steps {
    build "Build knowledge" {
      uses { cveId, cveDescription }
      call CveProcess
      command "build-knowledge"
      output { knowledgeRef: String, rootCauseRef: String, processorStatus: String }
    }
  }
  output {
    knowledgeRef: String from knowledgeRef
    rootCauseRef: String from rootCauseRef
    processorStatus: String from processorStatus
  }
  ui { layout form primary "Build" }
}
`;

const PRICING_PACK_SOURCE = (flowHeader: string) => `
domain PricingPack version "1.0.0"
title "Synthetic pricing pack"
description "Synthetic budget fail-closed fixture"

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

flow PricedRun title "Priced run" ${flowHeader} create {
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
  ui { layout form primary "Run" }
}
`;

const PRICING_HARNESS_PRESET = `id: dev
kind: api
model: strong
toolBoundary: none
loopCap: 1
outputContract: artifact
permission: read-only
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

async function installPricingPack(
  root: string,
  flowHeader: string,
): Promise<WorkflowDomainPackProjection> {
  const packDir = path.join(root, "pricing-pack");
  fs.mkdirSync(path.join(packDir, "harness"), { recursive: true });
  fs.writeFileSync(path.join(packDir, "main.ord"), PRICING_PACK_SOURCE(flowHeader), "utf8");
  fs.writeFileSync(path.join(packDir, "harness", "dev.yaml"), PRICING_HARNESS_PRESET, "utf8");
  return installPack(packDir);
}

/** Saves and restores the CLH env keys the run-start pricing gate reads. */
function saveClhEnvironment(): Record<string, string | undefined> {
  const keys = [
    "POLARIS_CLH_ENDPOINT",
    "POLARIS_CLH_API_KEY",
    "POLARIS_CLH_LIGHT_MODEL",
    "POLARIS_CLH_STRONG_MODEL",
    "POLARIS_CLH_STRONG_PRICE_INPUT_PER_MTOK",
    "POLARIS_CLH_STRONG_PRICE_OUTPUT_PER_MTOK",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  return previous;
}

function restoreClhEnvironment(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function serviceFor(
  pack: WorkflowDomainPackProjection,
  options: {
    autoStart?: boolean;
    liveMetadataReader?: WorkflowLiveVaultArtifactMetadataReader;
    vaults?: WorkflowVaultProjection[];
    listVaults?: (tenantId: string) => Promise<WorkflowVaultProjection[]>;
  } = {},
): WorkflowControlService {
  return new WorkflowControlService({
    importMetaUrl: import.meta.url,
    listPacks: () => [pack],
    listVaults: options.listVaults ?? (async () => options.vaults ?? [syntheticVault()]),
    autoStart: options.autoStart ?? false,
    liveMetadataReader: options.liveMetadataReader,
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
    assert.equal(completed?.steps.length, 1);
    assert.equal(completed?.steps[0]?.stepId, "summarize");
    assert.equal(completed?.steps[0]?.stepLabel, "Summarize");
    assert.deepEqual(completed?.steps[0]?.outputFields, ["summary"]);
    assert.equal(completed?.artifacts.length, 1);
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("a failing host tool threads its stable error code and values into the run record", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let service: WorkflowControlService | undefined;
  try {
    // Missing CLH credentials make the tool fail closed deterministically.
    delete process.env["POLARIS_CLH_ENDPOINT"];
    delete process.env["POLARIS_CLH_API_KEY"];
    const sourcePath = path.join(fixture.root, "threading-pack.ord");
    fs.writeFileSync(sourcePath, THREADING_PACK_SOURCE, "utf8");
    const pack = await installPack(sourcePath);
    service = serviceFor(pack, { vaults: [] });
    const admitted = await service.createRun("tenant-threading", {
      packId: pack.id,
      flowId: "BuildKnowledge",
      driver: "none",
      values: { cveId: "CVE-SYNTH-0001", cveDescription: "synthetic vulnerability" },
    });
    const listed = await service.listRuns("tenant-threading");
    const failed = listed.runs.find((run) => run.id === admitted.id);
    assert.equal(failed?.status, "failed");
    // The run record carries the tool's stable CLH error code and values
    // (PRD 3.14) instead of a generic execution failure.
    assert.equal(failed?.error?.code, "CLH_MISSING_CREDENTIAL");
    assert.equal(failed?.error?.values?.["envVar"], "POLARIS_CLH_ENDPOINT");
    // The failed step's receipt keeps the same code plus structured values.
    const receipt = failed?.receipts.find((entry) => entry.stepId === "build");
    assert.equal(receipt?.errorCode, "CLH_MISSING_CREDENTIAL");
    assert.equal(receipt?.errorValues?.["envVar"], "POLARIS_CLH_ENDPOINT");
    assert.equal(failed?.steps[0]?.status, "failed");
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("a declared budget fails the run closed when preset pricing is unresolvable", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  const clhPrevious = saveClhEnvironment();
  let service: WorkflowControlService | undefined;
  try {
    // PRD 3.14.8: the strong-tier preset resolves to a gateway model with no
    // env price override and no catalog entry, so the declared budget could
    // never accrue; the run must be rejected before its first step.
    process.env["POLARIS_CLH_STRONG_MODEL"] = "openai/gpt-oss-20b";
    const pack = await installPricingPack(fixture.root, "budgetUsd 5.0");
    service = serviceFor(pack, { vaults: [] });
    const admitted = await service.createRun("tenant-pricing", {
      packId: pack.id,
      flowId: "PricedRun",
      driver: "none",
      values: { subject: "priced run" },
    });
    const listed = await service.listRuns("tenant-pricing");
    const failed = listed.runs.find((run) => run.id === admitted.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.error?.code, "CLH_PRICING_UNRESOLVED");
    assert.equal(failed?.error?.values?.["unresolvedModels"], "openai/gpt-oss-20b");
    assert.equal(failed?.error?.values?.["budgetUsd"], 5);
    // The gate fires before the flow body: no steps, no receipts.
    assert.equal(failed?.steps.length, 0);
    assert.equal(failed?.receipts.length, 0);
  } finally {
    service?.close();
    restoreClhEnvironment(clhPrevious);
    restoreEnvironment(fixture);
  }
});

test("an env price override lets a budget-declaring run start", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  const clhPrevious = saveClhEnvironment();
  let service: WorkflowControlService | undefined;
  try {
    process.env["POLARIS_CLH_STRONG_MODEL"] = "openai/gpt-oss-20b";
    // The env override makes the declared budget accruable, so the gate passes.
    process.env["POLARIS_CLH_STRONG_PRICE_INPUT_PER_MTOK"] = "0.3";
    process.env["POLARIS_CLH_STRONG_PRICE_OUTPUT_PER_MTOK"] = "1.2";
    const pack = await installPricingPack(fixture.root, "budgetUsd 5.0");
    service = serviceFor(pack, { vaults: [] });
    const admitted = await service.createRun("tenant-pricing-override", {
      packId: pack.id,
      flowId: "PricedRun",
      driver: "none",
      values: { subject: "priced run" },
    });
    const listed = await service.listRuns("tenant-pricing-override");
    const completed = listed.runs.find((run) => run.id === admitted.id);
    // Past the gate, the run proceeds into normal execution (the human-effect
    // port parks it waiting for approval; the gate must not have failed it).
    assert.equal(completed?.status, "waiting");
    assert.notEqual(completed?.error?.code, "CLH_PRICING_UNRESOLVED");
  } finally {
    service?.close();
    restoreClhEnvironment(clhPrevious);
    restoreEnvironment(fixture);
  }
});

test("without a declared budget an unresolvable preset model keeps the run startable", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  const clhPrevious = saveClhEnvironment();
  let service: WorkflowControlService | undefined;
  try {
    // PRD 3.14.8: no budget declaration means no gate; costUsd stays honestly
    // undefined instead of failing the run.
    process.env["POLARIS_CLH_STRONG_MODEL"] = "openai/gpt-oss-20b";
    const pack = await installPricingPack(fixture.root, "");
    service = serviceFor(pack, { vaults: [] });
    const admitted = await service.createRun("tenant-pricing-unbudgeted", {
      packId: pack.id,
      flowId: "PricedRun",
      driver: "none",
      values: { subject: "unbudgeted run" },
    });
    const listed = await service.listRuns("tenant-pricing-unbudgeted");
    const completed = listed.runs.find((run) => run.id === admitted.id);
    // Unbudgeted runs keep the pre-D6 behavior: no gate, no rejection.
    assert.equal(completed?.status, "waiting");
    assert.notEqual(completed?.error?.code, "CLH_PRICING_UNRESOLVED");
  } finally {
    service?.close();
    restoreClhEnvironment(clhPrevious);
    restoreEnvironment(fixture);
  }
});

test("workflow admission validates required inputs from the flow projection", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installSyntheticPack(fixture.root);
    service = serviceFor(pack, { vaults: [] });
    await assert.rejects(
      () => service!.createRun("tenant-required-input", {
        packId: pack.id,
        flowId: "Summarize",
        driver: "none",
        values: {},
      }),
      (error: unknown) =>
        error instanceof WorkflowControlError
        && error.code === "workflow-input-required"
        && error.statusCode === 400,
    );
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

test("POLARIS_VAULT_MODE=host rejects Vault execution", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  const previousMode = process.env.POLARIS_VAULT_MODE;
  let service: WorkflowControlService | undefined;
  try {
    process.env.POLARIS_VAULT_MODE = "host";
    const pack = await installSyntheticPack(fixture.root);
    service = serviceFor(pack);
    await assert.rejects(
      () => service!.createRun("tenant-host-mode", {
        packId: pack.id,
        flowId: "Summarize",
        driver: "vault",
        vaultId: "vault-synthetic",
        values: { subject: "blocked" },
      }),
      (error: unknown) => error instanceof WorkflowControlError && error.code === "host-vault-mode",
    );
  } finally {
    if (previousMode === undefined) delete process.env.POLARIS_VAULT_MODE;
    else process.env.POLARIS_VAULT_MODE = previousMode;
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
    assert.equal(summary?.steps.length, 1);
    assert.equal(summary?.steps[0]?.stepId, "summarize");
    assert.deepEqual(summary?.steps[0]?.outputFields, ["summary"]);
    assert.match(summary?.artifacts[0]?.digest ?? "", /^sha256:[a-f0-9]{64}$/u);
    assert.equal(review?.receipts[0]?.status, "waiting");
    assert.equal(review?.steps.length, 1);
    assert.equal(review?.steps[0]?.stepId, "review");
    assert.deepEqual(review?.steps[0]?.outputFields, ["approved", "reviewId"]);
    assert.equal(typeof review?.receipts[0]?.input, "object");
    assert.equal(typeof review?.receipts[0]?.output, "object");
    assert.equal(review?.receipts[0]?.stepId, "review");
    assert.equal(review?.receipts[0]?.stepLabel, "Review");
    assert.deepEqual(review?.receipts[0]?.outputFields, ["approved", "reviewId"]);
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

test("host retry requeues the same run id and keeps completed steps", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installSyntheticPack(fixture.root);
    service = serviceFor(pack, { vaults: [] });
    const created = await service.createRun("tenant-host-retry", {
      packId: pack.id,
      flowId: "Summarize",
      driver: "none",
      values: { subject: "retry-same-run" },
    });
    const store = PolarisControlStore.open(process.env.POLARIS_CONTROL_STORE_PATH!);
    store.recordWorkflowStepResult({
      id: `step-${created.id}-1`,
      sequence: 1,
      runId: created.id,
      tenantId: "tenant-host-retry",
      stepId: "summarize",
      stepLabel: "Summarize",
      status: "completed",
      detail: "completed before failure",
      input: { subject: "retry-same-run" },
      output: { summary: "keep this step" },
      outputFields: ["summary"],
      createdAt: "2026-09-11T00:00:00.000Z",
      completedAt: "2026-09-11T00:00:00.000Z",
    });
    store.updateWorkflowRun({
      tenantId: "tenant-host-retry",
      runId: created.id,
      status: "failed",
      progress: 40,
      errorCode: "workflow-execution-failed",
      errorMessage: "synthetic host failure",
      event: {
        kind: "failed",
        title: "工作流执行失败",
        detail: "synthetic host failure",
        tone: "warning",
      },
    });
    const before = store.getWorkflowRun("tenant-host-retry", created.id);
    assert.equal(before?.steps.length, 1);
    assert.equal(before?.steps[0]?.status, "completed");
    assert.equal(before?.steps[0]?.output.summary, "keep this step");
    store.close();
    const retried = await service.retry("tenant-host-retry", created.id);
    assert.equal(retried.id, created.id);
    assert.equal(retried.source, "retry");
    assert.equal(retried.status, "queued");
    assert.equal(retried.steps.length, 1);
    assert.equal(retried.steps[0]?.stepId, "summarize");
    assert.equal(retried.steps[0]?.status, "completed");
    assert.equal(retried.steps[0]?.output.summary, "keep this step");
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
    assert.equal(retried.id, queued.id);
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

test("terminal workflow runs can be deleted while active runs are protected", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installSyntheticPack(fixture.root);
    service = serviceFor(pack);
    const active = await service.createRun("tenant-a", {
      packId: pack.id,
      flowId: "Summarize",
      driver: "none",
      values: { subject: "synthetic active" },
    });
    await assert.rejects(
      () => service!.deleteRun("tenant-a", active.id),
      (error: unknown) => error instanceof WorkflowControlError
        && error.code === "delete-not-available"
        && error.statusCode === 409,
    );

    const completed = await service.listRuns("tenant-a");
    const terminal = completed.runs.find((run) => run.id === active.id);
    assert.equal(terminal?.status, "succeeded");
    await service.deleteRun("tenant-a", active.id);
    await assert.rejects(
      () => service!.getRun("tenant-a", active.id),
      (error: unknown) => error instanceof WorkflowControlError
        && error.code === "run-not-found"
        && error.statusCode === 404,
    );
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
      assert.equal(stored?.steps.length, 1);
      assert.equal(stored?.steps[0]?.stepId, "metadata");
      assert.deepEqual(stored?.steps[0]?.outputFields, [
        "artifactCount",
        "latestTitles",
        "pendingMemoryChanges",
      ]);
      assert.equal(stored?.receipts[0]?.stepId, "metadata");
      assert.equal(stored?.receipts[0]?.stepLabel, "Read metadata");
      assert.deepEqual(stored?.receipts[0]?.outputFields, [
        "artifactCount",
        "latestTitles",
        "pendingMemoryChanges",
      ]);
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
