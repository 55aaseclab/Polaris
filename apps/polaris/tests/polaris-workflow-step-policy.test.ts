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
} from "../scripts/portal/control-store.js";
import {
  WorkflowControlService,
} from "../scripts/portal/workflow/workflow-control.js";
import type {
  WorkflowDomainPackProjection,
} from "@polaris/polaris-shell";

// Synthetic fixture: a single dispatcher-backed port whose tool behavior is
// fully controlled by env vars (no business data).
const STEP_POLICY_PACK_SOURCE = `
domain StepPolicyPack version "1.0.0"
title "Synthetic step policy pack"
description "Synthetic step-level retry and budget fixture"

port StepFixture version "1.0.0" {
  binding {
    tool synthetic.step.policy
    command workflow
  }
  in {
    payload: String?
  }
  out {
    attempt: Number
    status: String
  }
  effect write
}

flow PolicyRun title "Synthetic step policy run" create {
  needs { StepFixture }
  input {
    payload: String
  }
  steps {
    fixture "Fixture step" {
      uses { payload }
      call StepFixture
      output {
        attempt: Number
        status: String
      }
    }
  }
  output {
    attempt: Number from attempt
    status: String from status
  }
  ui { layout form primary "Policy" }
}

flow PolicyRunMaxAttempts title "Synthetic DSL maxAttempts run" create {
  needs { StepFixture }
  input {
    payload: String
  }
  steps {
    fixture "Fixture step" {
      uses { payload }
      call StepFixture
      maxAttempts 3
      output {
        attempt: Number
        status: String
      }
    }
  }
  output {
    attempt: Number from attempt
    status: String from status
  }
  ui { layout form primary "Policy" }
}

flow PolicyRunFlowCap title "Synthetic budget cap run" budgetUsd 0.4 create {
  needs { StepFixture }
  input {
    payload: String
  }
  steps {
    fixture "Fixture step" {
      uses { payload }
      call StepFixture
      output {
        attempt: Number
        status: String
      }
    }
  }
  output {
    attempt: Number from attempt
    status: String from status
  }
  ui { layout form primary "Policy" }
}
`;

const POLICY_ENV_KEYS = [
  "POLARIS_WORKFLOW_STEP_POLICY",
  "POLARIS_WORKFLOW_STEP_MAX_ATTEMPTS",
  "POLARIS_WORKFLOW_STEP_TIMEOUT_MS",
  "POLARIS_WORKFLOW_STEP_BUDGET_USD",
  "POLARIS_RUN_BUDGET_USD",
  "POLARIS_RUN_TIMEOUT_MS",
  "POLARIS_SYNTHETIC_FAIL_UNTIL",
  "POLARIS_SYNTHETIC_SLEEP_MS",
  "POLARIS_SYNTHETIC_COST_USD",
];

function testEnvironment(): { root: string; previous: Record<string, string | undefined> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-step-policy-"));
  const keys = ["NODE_ENV", "POLARIS_DATA_ROOT", "POLARIS_CONTROL_STORE_PATH", ...POLICY_ENV_KEYS];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = "test";
  process.env.POLARIS_DATA_ROOT = path.join(root, "data");
  process.env.POLARIS_CONTROL_STORE_PATH = path.join(root, "control.sqlite");
  for (const key of POLICY_ENV_KEYS) delete process.env[key];
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

async function installStepPolicyPack(root: string): Promise<WorkflowDomainPackProjection> {
  const sourcePath = path.join(root, "step-policy-pack.ord");
  fs.writeFileSync(sourcePath, STEP_POLICY_PACK_SOURCE, "utf8");
  const installed = await addDomainPack(import.meta.url, sourcePath);
  const projection = listDomainPackProjections(import.meta.url).find(
    (pack) => pack.id === installed.pack.id,
  );
  assert.ok(projection);
  return projection;
}

function serviceFor(pack: WorkflowDomainPackProjection): WorkflowControlService {
  return new WorkflowControlService({
    importMetaUrl: import.meta.url,
    listPacks: () => [pack],
    listVaults: async () => [],
    autoStart: false,
  });
}

function stepReceipts(
  receipts: unknown[],
): Array<{ status: string; requestId: string; errorCode?: string; errorValues?: Record<string, string | number> }> {
  return (receipts as Array<{ stepId?: string; status: string; requestId: string; errorCode?: string; errorValues?: Record<string, string | number> }>)
    .filter((receipt) => receipt.stepId === "fixture")
    .map((receipt) => ({
      status: receipt.status,
      requestId: receipt.requestId,
      ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
      ...(receipt.errorValues ? { errorValues: receipt.errorValues } : {}),
    }));
}

test("default policy keeps single-attempt behavior without retries", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  process.env.POLARIS_SYNTHETIC_FAIL_UNTIL = "99";
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installStepPolicyPack(fixture.root);
    service = serviceFor(pack);
    const admitted = await service.createRun("tenant-step-policy-default", {
      packId: pack.id,
      flowId: "PolicyRun",
      driver: "none",
      values: { payload: "synthetic" },
    });
    const listed = await service.listRuns("tenant-step-policy-default");
    const run = listed.runs.find((candidate) => candidate.id === admitted.id);
    assert.ok(run);
    assert.equal(run.status, "failed");
    assert.equal(run.steps.length, 1);
    assert.equal(run.steps[0]?.status, "failed");
    assert.match(run.steps[0]?.detail ?? "", /synthetic-step-policy failed with exit code 1/u);
    const attempts = stepReceipts(run.receipts);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.status, "failed");
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("default policy completes a healthy tool exactly like the current path", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installStepPolicyPack(fixture.root);
    service = serviceFor(pack);
    const admitted = await service.createRun("tenant-step-policy-ok", {
      packId: pack.id,
      flowId: "PolicyRun",
      driver: "none",
      values: { payload: "synthetic" },
    });
    const listed = await service.listRuns("tenant-step-policy-ok");
    const run = listed.runs.find((candidate) => candidate.id === admitted.id);
    assert.ok(run);
    assert.equal(run.status, "succeeded");
    assert.equal(run.steps[0]?.status, "completed");
    assert.match(run.steps[0]?.detail ?? "", /rpc:\/\/StepFixture@1\.0\.0 \(completed\)$/u);
    const attempts = stepReceipts(run.receipts);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.status, "completed");
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("maxAttempts exhaustion fails the step and preserves every attempt receipt", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  process.env.POLARIS_WORKFLOW_STEP_MAX_ATTEMPTS = "3";
  process.env.POLARIS_SYNTHETIC_FAIL_UNTIL = "99";
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installStepPolicyPack(fixture.root);
    service = serviceFor(pack);
    await service.createRun("tenant-step-policy-exhausted", {
      packId: pack.id,
      flowId: "PolicyRun",
      driver: "none",
      values: { payload: "synthetic" },
    });
    const listed = await service.listRuns("tenant-step-policy-exhausted");
    const run = listed.runs.find((candidate) => candidate.flowId === "PolicyRun");
    assert.ok(run);
    assert.equal(run.status, "failed");
    assert.equal(run.steps[0]?.status, "failed");
    assert.match(run.steps[0]?.detail ?? "", /step-attempts-exhausted \(3\/3\)/u);
    const attempts = stepReceipts(run.receipts);
    assert.equal(attempts.length, 3);
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["failed", "failed", "failed"]);
    assert.equal(attempts[2]?.errorCode, "step-attempts-exhausted");
    assert.deepEqual(attempts[2]?.errorValues, { count: 3 });
    assert.equal(new Set(attempts.map((attempt) => attempt.requestId)).size, 3);
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("a later successful attempt recovers the step after retries", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  process.env.POLARIS_WORKFLOW_STEP_POLICY = JSON.stringify({ maxAttempts: 3 });
  process.env.POLARIS_SYNTHETIC_FAIL_UNTIL = "2";
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installStepPolicyPack(fixture.root);
    service = serviceFor(pack);
    await service.createRun("tenant-step-policy-recovers", {
      packId: pack.id,
      flowId: "PolicyRun",
      driver: "none",
      values: { payload: "synthetic" },
    });
    const listed = await service.listRuns("tenant-step-policy-recovers");
    const run = listed.runs.find((candidate) => candidate.flowId === "PolicyRun");
    assert.ok(run);
    assert.equal(run.status, "succeeded");
    assert.equal(run.steps[0]?.status, "completed");
    assert.equal(run.steps[0]?.output.attempt, 3);
    const attempts = stepReceipts(run.receipts);
    assert.equal(attempts.length, 3);
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["failed", "failed", "completed"]);
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("budget stop-loss halts retries immediately and fails the step", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  process.env.POLARIS_WORKFLOW_STEP_POLICY = JSON.stringify({ maxAttempts: 5, budgetUsd: 0.5 });
  process.env.POLARIS_SYNTHETIC_FAIL_UNTIL = "99";
  process.env.POLARIS_SYNTHETIC_COST_USD = "0.4";
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installStepPolicyPack(fixture.root);
    service = serviceFor(pack);
    await service.createRun("tenant-step-policy-budget", {
      packId: pack.id,
      flowId: "PolicyRun",
      driver: "none",
      values: { payload: "synthetic" },
    });
    const listed = await service.listRuns("tenant-step-policy-budget");
    const run = listed.runs.find((candidate) => candidate.flowId === "PolicyRun");
    assert.ok(run);
    assert.equal(run.status, "failed");
    assert.equal(run.steps[0]?.status, "failed");
    assert.match(run.steps[0]?.detail ?? "", /step-budget-exceeded \(0\.8 > 0\.5\)/u);
    const attempts = stepReceipts(run.receipts);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["failed", "failed"]);
    assert.equal(attempts[1]?.errorCode, "step-budget-exceeded");
    assert.deepEqual(attempts[1]?.errorValues, { total: "$0.8", budget: "$0.5" });
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("timeout marks the attempt failed without crashing the run", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  process.env.POLARIS_WORKFLOW_STEP_TIMEOUT_MS = "100";
  process.env.POLARIS_SYNTHETIC_SLEEP_MS = "1500";
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installStepPolicyPack(fixture.root);
    service = serviceFor(pack);
    await service.createRun("tenant-step-policy-timeout", {
      packId: pack.id,
      flowId: "PolicyRun",
      driver: "none",
      values: { payload: "synthetic" },
    });
    const listed = await service.listRuns("tenant-step-policy-timeout");
    const run = listed.runs.find((candidate) => candidate.flowId === "PolicyRun");
    assert.ok(run);
    assert.equal(run.status, "failed");
    assert.equal(run.steps[0]?.status, "failed");
    assert.match(run.steps[0]?.detail ?? "", /step-attempt-timeout \(100ms\)/u);
    const attempts = stepReceipts(run.receipts);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.status, "failed");
    assert.equal(attempts[0]?.errorCode, "step-attempt-timeout");
    assert.deepEqual(attempts[0]?.errorValues, { timeout: 100 });
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("POLARIS_WORKFLOW_STEP_POLICY JSON takes precedence over individual env vars", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  process.env.POLARIS_WORKFLOW_STEP_POLICY = JSON.stringify({ maxAttempts: 2 });
  process.env.POLARIS_WORKFLOW_STEP_MAX_ATTEMPTS = "9";
  process.env.POLARIS_SYNTHETIC_FAIL_UNTIL = "99";
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installStepPolicyPack(fixture.root);
    service = serviceFor(pack);
    await service.createRun("tenant-step-policy-precedence", {
      packId: pack.id,
      flowId: "PolicyRun",
      driver: "none",
      values: { payload: "synthetic" },
    });
    const listed = await service.listRuns("tenant-step-policy-precedence");
    const run = listed.runs.find((candidate) => candidate.flowId === "PolicyRun");
    assert.ok(run);
    const attempts = stepReceipts(run.receipts);
    assert.equal(attempts.length, 2);
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("a step-level maxAttempts declaration overrides the env default (PRD 3.10.9)", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  process.env.POLARIS_WORKFLOW_STEP_MAX_ATTEMPTS = "1";
  process.env.POLARIS_SYNTHETIC_FAIL_UNTIL = "99";
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installStepPolicyPack(fixture.root);
    service = serviceFor(pack);
    await service.createRun("tenant-step-policy-dsl-attempts", {
      packId: pack.id,
      flowId: "PolicyRunMaxAttempts",
      driver: "none",
      values: { payload: "synthetic" },
    });
    const listed = await service.listRuns("tenant-step-policy-dsl-attempts");
    const run = listed.runs.find((candidate) => candidate.flowId === "PolicyRunMaxAttempts");
    assert.ok(run);
    assert.equal(run.status, "failed");
    assert.match(run.steps[0]?.detail ?? "", /step-attempts-exhausted \(3\/3\)/u);
    const attempts = stepReceipts(run.receipts);
    assert.equal(attempts.length, 3);
    assert.equal(new Set(attempts.map((attempt) => attempt.requestId)).size, 3);
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("the run-level timeout cap fails the whole run with a stable code (PRD 3.10.9)", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  process.env.POLARIS_RUN_TIMEOUT_MS = "200";
  process.env.POLARIS_SYNTHETIC_SLEEP_MS = "400";
  process.env.POLARIS_SYNTHETIC_FAIL_UNTIL = "99";
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installStepPolicyPack(fixture.root);
    service = serviceFor(pack);
    await service.createRun("tenant-run-policy-timeout", {
      packId: pack.id,
      flowId: "PolicyRun",
      driver: "none",
      values: { payload: "synthetic" },
    });
    const listed = await service.listRuns("tenant-run-policy-timeout");
    const run = listed.runs.find((candidate) => candidate.flowId === "PolicyRun");
    assert.ok(run);
    assert.equal(run.status, "failed");
    assert.equal(run.error?.code, "run-timeout-exceeded");
    assert.match(run.steps[0]?.detail ?? "", /run-timeout-exceeded \(\d+ms > 200ms\)/u);
    const attempts = stepReceipts(run.receipts);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.errorCode, "run-timeout-exceeded");
    assert.equal(attempts[0]?.errorValues?.timeout, 200);
    assert.equal(typeof attempts[0]?.errorValues?.elapsed, "number");
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("the flow-level budget cap stops loss for the whole run with a stable code (PRD 3.10.9)", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  process.env.POLARIS_WORKFLOW_STEP_MAX_ATTEMPTS = "5";
  process.env.POLARIS_SYNTHETIC_COST_USD = "0.4";
  process.env.POLARIS_SYNTHETIC_FAIL_UNTIL = "99";
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installStepPolicyPack(fixture.root);
    service = serviceFor(pack);
    await service.createRun("tenant-flow-cap-budget", {
      packId: pack.id,
      flowId: "PolicyRunFlowCap",
      driver: "none",
      values: { payload: "synthetic" },
    });
    const listed = await service.listRuns("tenant-flow-cap-budget");
    const run = listed.runs.find((candidate) => candidate.flowId === "PolicyRunFlowCap");
    assert.ok(run);
    assert.equal(run.status, "failed");
    assert.equal(run.error?.code, "run-budget-exceeded");
    assert.match(run.steps[0]?.detail ?? "", /run-budget-exceeded \(\$0\.8 > \$0\.4\)/u);
    const attempts = stepReceipts(run.receipts);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["failed", "failed"]);
    assert.equal(attempts[1]?.errorCode, "run-budget-exceeded");
    assert.deepEqual(attempts[1]?.errorValues, { total: "$0.8", budget: "$0.4" });
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("a flow-level budget declaration overrides the env fallback (PRD 3.10.9)", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  process.env.POLARIS_RUN_BUDGET_USD = "0.1";
  process.env.POLARIS_WORKFLOW_STEP_MAX_ATTEMPTS = "5";
  process.env.POLARIS_SYNTHETIC_COST_USD = "0.4";
  process.env.POLARIS_SYNTHETIC_FAIL_UNTIL = "99";
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installStepPolicyPack(fixture.root);
    service = serviceFor(pack);
    await service.createRun("tenant-flow-cap-priority", {
      packId: pack.id,
      flowId: "PolicyRunFlowCap",
      driver: "none",
      values: { payload: "synthetic" },
    });
    const listed = await service.listRuns("tenant-flow-cap-priority");
    const run = listed.runs.find((candidate) => candidate.flowId === "PolicyRunFlowCap");
    assert.ok(run);
    assert.equal(run.status, "failed");
    assert.equal(run.error?.code, "run-budget-exceeded");
    // The env cap 0.1 would stop after attempt 1 (0.4 > 0.1 with budget $0.1);
    // the flow declaration 0.4 governs, so the stop lands after attempt 2.
    assert.match(run.steps[0]?.detail ?? "", /run-budget-exceeded \(\$0\.8 > \$0\.4\)/u);
    const attempts = stepReceipts(run.receipts);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1]?.errorCode, "run-budget-exceeded");
    assert.deepEqual(attempts[1]?.errorValues, { total: "$0.8", budget: "$0.4" });
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});
