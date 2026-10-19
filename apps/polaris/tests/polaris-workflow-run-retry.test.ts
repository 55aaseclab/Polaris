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
  WorkflowRunProjection,
} from "@polaris/polaris-shell";

// Synthetic fixture: dispatcher-backed ports whose tool behavior is fully
// controlled by env vars (no business data). The tool's attempt counter lives
// in the per-run workspace, so it keeps counting across run-level rounds.
const RUN_RETRY_PACK_SOURCE = `
domain RunRetryPack version "1.0.0"
title "Synthetic run retry pack"
description "Synthetic run-level maxRuns fixture"

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

flow RetryRunSingle title "Synthetic single-round run" create {
  needs { StepFixture }
  input {
    payload: String
  }
  steps {
    first "First step" {
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
  ui { layout form primary "Retry" }
}

flow RetryRun title "Synthetic retry run" maxRuns 3 create {
  needs { StepFixture }
  input {
    payload: String
  }
  steps {
    first "First step" {
      uses { payload }
      call StepFixture
      output {
        attempt: Number
        status: String
      }
    }
    second "Second step" {
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
  ui { layout form primary "Retry" }
}

flow RetryRunExhaust title "Synthetic retry exhaustion run" maxRuns 3 create {
  needs { StepFixture }
  input {
    payload: String
  }
  steps {
    first "First step" {
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
  ui { layout form primary "Retry" }
}

flow RetryRunBudgetCap title "Synthetic budget-capped retry run" budgetUsd 0.4 maxRuns 5 create {
  needs { StepFixture }
  input {
    payload: String
  }
  steps {
    first "First step" {
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
  ui { layout form primary "Retry" }
}
`;

const RETRY_ENV_KEYS = [
  "POLARIS_WORKFLOW_STEP_POLICY",
  "POLARIS_WORKFLOW_STEP_MAX_ATTEMPTS",
  "POLARIS_RUN_BUDGET_USD",
  "POLARIS_RUN_TIMEOUT_MS",
  "POLARIS_SYNTHETIC_FAIL_UNTIL",
  "POLARIS_SYNTHETIC_SLEEP_MS",
  "POLARIS_SYNTHETIC_COST_USD",
];

function testEnvironment(): { root: string; previous: Record<string, string | undefined> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-run-retry-"));
  const keys = ["NODE_ENV", "POLARIS_DATA_ROOT", "POLARIS_CONTROL_STORE_PATH", ...RETRY_ENV_KEYS];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = "test";
  process.env.POLARIS_DATA_ROOT = path.join(root, "data");
  process.env.POLARIS_CONTROL_STORE_PATH = path.join(root, "control.sqlite");
  for (const key of RETRY_ENV_KEYS) delete process.env[key];
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

async function installRunRetryPack(root: string): Promise<WorkflowDomainPackProjection> {
  const sourcePath = path.join(root, "run-retry-pack.ord");
  fs.writeFileSync(sourcePath, RUN_RETRY_PACK_SOURCE, "utf8");
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

async function runFlow(
  service: WorkflowControlService,
  tenantId: string,
  packId: string,
  flowId: string,
): Promise<WorkflowRunProjection> {
  const admitted = await service.createRun(tenantId, {
    packId,
    flowId,
    driver: "none",
    values: { payload: "synthetic" },
  });
  const listed = await service.listRuns(tenantId);
  const run = listed.runs.find((candidate) => candidate.id === admitted.id);
  assert.ok(run);
  return run;
}

function stepReceipts(
  receipts: unknown[],
  stepId: string,
): Array<{ status: string; requestId: string; errorCode?: string }> {
  return (receipts as Array<{ stepId?: string; status: string; requestId: string; errorCode?: string }>)
    .filter((receipt) => receipt.stepId === stepId)
    .map((receipt) => ({
      status: receipt.status,
      requestId: receipt.requestId,
      ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
    }));
}

test("default maxRuns keeps single-round behavior with no run-attempt markers", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  process.env.POLARIS_SYNTHETIC_FAIL_UNTIL = "1";
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installRunRetryPack(fixture.root);
    service = serviceFor(pack);
    const run = await runFlow(service, "tenant-run-retry-default", pack.id, "RetryRunSingle");
    assert.equal(run.status, "failed");
    assert.notEqual(run.error?.code, "run-retries-exhausted");
    assert.equal(run.steps.length, 1);
    assert.equal(run.steps[0]?.status, "failed");
    assert.doesNotMatch(run.steps[0]?.detail ?? "", /run attempt/u);
    const attempts = stepReceipts(run.receipts, "first");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.status, "failed");
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("a failed run reruns as a whole and a later round succeeds (PRD 3.10.9)", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  process.env.POLARIS_SYNTHETIC_FAIL_UNTIL = "1";
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installRunRetryPack(fixture.root);
    service = serviceFor(pack);
    const run = await runFlow(service, "tenant-run-retry-recover", pack.id, "RetryRun");
    assert.equal(run.status, "succeeded");
    // Every step reran in the winning round from zero: the SECOND step of the
    // SECOND round consumed attempt counter 3.
    const secondStep = run.steps.find((step) => step.stepId === "second");
    assert.equal(secondStep?.output.attempt, 3);
    // Round 1: first step failed. Round 2: first and second both completed.
    const first = stepReceipts(run.receipts, "first");
    assert.deepEqual(first.map((receipt) => receipt.status), ["failed", "completed"]);
    const second = stepReceipts(run.receipts, "second");
    assert.deepEqual(second.map((receipt) => receipt.status), ["completed"]);
    assert.equal(run.steps.length, 3);
    assert.deepEqual(run.steps.map((step) => step.status), ["failed", "completed", "completed"]);
    assert.match(run.steps[0]?.detail ?? "", / \(run attempt 1\/3\)$/u);
    assert.match(run.steps[1]?.detail ?? "", / \(run attempt 2\/3\)$/u);
    assert.match(run.steps[2]?.detail ?? "", / \(run attempt 2\/3\)$/u);
    assert.equal(new Set(run.receipts.map((receipt) => receipt.requestId)).size, 3);
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("exhausted maxRuns fails the run with the stable code and attempt values", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  process.env.POLARIS_SYNTHETIC_FAIL_UNTIL = "99";
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installRunRetryPack(fixture.root);
    service = serviceFor(pack);
    const run = await runFlow(service, "tenant-run-retry-exhaust", pack.id, "RetryRunExhaust");
    assert.equal(run.status, "failed");
    assert.equal(run.error?.code, "run-retries-exhausted");
    assert.deepEqual(run.error?.values, { attempts: 3, maxRuns: 3 });
    const attempts = stepReceipts(run.receipts, "first");
    assert.equal(attempts.length, 3);
    assert.deepEqual(attempts.map((receipt) => receipt.status), ["failed", "failed", "failed"]);
    assert.equal(new Set(attempts.map((receipt) => receipt.requestId)).size, 3);
    assert.equal(run.steps.length, 3);
    assert.match(run.steps[2]?.detail ?? "", / \(run attempt 3\/3\)$/u);
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});

test("the flow budget cap stays shared across retry rounds (PRD 3.10.9)", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  process.env.POLARIS_SYNTHETIC_FAIL_UNTIL = "99";
  process.env.POLARIS_SYNTHETIC_COST_USD = "0.3";
  let service: WorkflowControlService | undefined;
  try {
    const pack = await installRunRetryPack(fixture.root);
    service = serviceFor(pack);
    const run = await runFlow(service, "tenant-run-retry-budget", pack.id, "RetryRunBudgetCap");
    assert.equal(run.status, "failed");
    // Round 1 spent $0.3; the shared cap let round 2 start and trip at $0.6.
    // Without the carry-over, round 2 would bill $0.3 and round 3 would run.
    assert.equal(run.error?.code, "run-budget-exceeded");
    assert.deepEqual(run.error?.values, { total: "$0.6", budget: "$0.4" });
    const attempts = stepReceipts(run.receipts, "first");
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map((receipt) => receipt.status), ["failed", "failed"]);
    assert.match(run.steps[1]?.detail ?? "", /run-budget-exceeded \(\$0\.6 > \$0\.4\)/u);
  } finally {
    service?.close();
    restoreEnvironment(fixture);
  }
});
