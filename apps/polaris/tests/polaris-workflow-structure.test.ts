import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addDomainPack,
  getDomainPackFlowGraphProjection,
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

// Synthetic fixture: dispatcher-backed ports whose behavior is fully
// controlled by env vars (no business data). DSL v2 structured constructs
// (PRD 3.13) exercise parallel branches, choice paths, and run-level budget.
const STRUCTURE_PACK_SOURCE = `
domain StructurePack version "1.0.0"
title "Synthetic structure pack"
description "Synthetic DSL v2 structured orchestration fixture"

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

flow ParallelRun title "Synthetic parallel run" create {
  needs { StepFixture }
  input {
    payload: String
  }
  steps {
    parallel {
      branch left {
        leftStep "Left branch step" {
          uses { payload }
          call StepFixture
          output {
            attempt: Number
            status: String
          }
        }
      }
      branch right {
        rightStep "Right branch step" {
          uses { payload }
          call StepFixture
          output {
            attempt: Number
            status: String
          }
        }
      }
    }
  }
  output {
    status: String from status
  }
  ui { layout form primary "Run" }
}

flow ChoiceRun title "Synthetic choice run" create {
  needs { StepFixture }
  input {
    payload: String
    mode: String
  }
  steps {
    choice {
      when mode == "fast" {
        fastStep "Fast branch step" {
          uses { payload }
          call StepFixture
          output {
            attempt: Number
            status: String
          }
        }
      }
      else {
        slowStep "Slow branch step" {
          uses { payload }
          call StepFixture
          output {
            attempt: Number
            status: String
          }
        }
      }
    }
  }
  output {
    status: String from status
  }
  ui { layout form primary "Run" }
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-workflow-structure-"));
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

async function installStructurePack(root: string): Promise<WorkflowDomainPackProjection> {
  const sourcePath = path.join(root, "structure-pack.ord");
  fs.writeFileSync(sourcePath, STRUCTURE_PACK_SOURCE, "utf8");
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
  pack: WorkflowDomainPackProjection,
  tenantId: string,
  flowId: string,
  values: Record<string, string>,
): Promise<ReturnType<WorkflowControlService["listRuns"]> extends Promise<infer T> ? T : never> {
  let service: WorkflowControlService | undefined;
  try {
    service = serviceFor(pack);
    await service.createRun(tenantId, { packId: pack.id, flowId, driver: "none", values });
    const listed = await service.listRuns(tenantId);
    const run = listed.runs.find((candidate) => candidate.flowId === flowId);
    assert.ok(run);
    return run;
  } finally {
    service?.close();
  }
}

test("parallel branches run and their step results carry branch groups", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let pack: WorkflowDomainPackProjection | undefined;
  try {
    pack = await installStructurePack(fixture.root);
    const run = await runFlow(pack, "tenant-structure-parallel", "ParallelRun", { payload: "synthetic" });
    assert.equal(run.status, "succeeded");
    const branches = run.steps
      .map((step) => step.group)
      .filter((group) => group?.kind === "parallel")
      .map((group) => group?.branch);
    assert.deepEqual([...new Set(branches)].sort(), ["left", "right"]);
  } finally {
    restoreEnvironment(fixture);
  }
});

test("choice records the taken path in step results", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let pack: WorkflowDomainPackProjection | undefined;
  try {
    pack = await installStructurePack(fixture.root);
    const run = await runFlow(
      pack,
      "tenant-structure-choice",
      "ChoiceRun",
      { payload: "synthetic", mode: "fast" },
    );
    assert.equal(run.status, "succeeded");
    const fast = run.steps.find((step) => step.stepId === "fastStep");
    assert.ok(fast);
    assert.equal(fast.group?.kind, "choice");
    assert.equal(fast.group?.branch, "when-1");
    assert.ok(!run.steps.some((step) => step.stepId === "slowStep"));
  } finally {
    restoreEnvironment(fixture);
  }
});

test("parallel branches share the run-level step budget (PRD 3.13.5)", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let pack: WorkflowDomainPackProjection | undefined;
  try {
    pack = await installStructurePack(fixture.root);
    process.env.POLARIS_WORKFLOW_STEP_POLICY = JSON.stringify({ maxAttempts: 1, budgetUsd: 0.5 });
    process.env.POLARIS_SYNTHETIC_FAIL_UNTIL = "99";
    process.env.POLARIS_SYNTHETIC_COST_USD = "0.4";
    const run = await runFlow(pack, "tenant-structure-budget", "ParallelRun", { payload: "synthetic" });
    assert.equal(run.status, "failed");
    // Each branch attempt costs 0.4; the cumulative is host-level, so the
    // second branch to fail sees 0.8 over the 0.5 budget and stops loss.
    const budgetVerdicts = run.receipts.filter(
      (receipt) => (receipt as { errorCode?: string }).errorCode === "step-budget-exceeded",
    );
    assert.equal(budgetVerdicts.length, 1);
    const values = (budgetVerdicts[0] as { errorValues?: Record<string, string | number> }).errorValues;
    assert.equal(values?.total, "$0.8");
    assert.equal(values?.budget, "$0.5");
  } finally {
    restoreEnvironment(fixture);
  }
});

test("the run-level budget cap stops loss across parallel branches (PRD 3.10.9)", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let pack: WorkflowDomainPackProjection | undefined;
  try {
    pack = await installStructurePack(fixture.root);
    process.env.POLARIS_RUN_BUDGET_USD = "0.5";
    process.env.POLARIS_SYNTHETIC_FAIL_UNTIL = "99";
    process.env.POLARIS_SYNTHETIC_COST_USD = "0.4";
    const run = await runFlow(pack, "tenant-run-policy-budget", "ParallelRun", { payload: "synthetic" });
    assert.equal(run.status, "failed");
    // Both branch steps' cumulative cost (0.4 + 0.4 = 0.8) crosses the
    // run-wide 0.5 cap, so the run fails with the stable run-stop code.
    assert.equal(run.error?.code, "run-budget-exceeded");
    assert.match(run.error?.message ?? "", /run-budget-exceeded/u);
    const stopVerdicts = run.receipts.filter(
      (receipt) => (receipt as { errorCode?: string }).errorCode === "run-budget-exceeded",
    );
    assert.ok(stopVerdicts.length >= 1);
    const values = (stopVerdicts[0] as { errorValues?: Record<string, string | number> }).errorValues;
    assert.equal(values?.total, "$0.8");
    assert.equal(values?.budget, "$0.5");
  } finally {
    restoreEnvironment(fixture);
  }
});

test("graph projection renders construct nodes, branch groups, and when edges", { concurrency: false }, async () => {
  const fixture = testEnvironment();
  let pack: WorkflowDomainPackProjection | undefined;
  try {
    pack = await installStructurePack(fixture.root);
    const parallelGraph = getDomainPackFlowGraphProjection(import.meta.url, pack.id, "ParallelRun");
    const parallelMarker = parallelGraph.flow.nodes.find((node) => node.kind === "parallel");
    assert.ok(parallelMarker);
    const branchGroups = parallelGraph.flow.nodes
      .filter((node) => node.group?.kind === "parallel")
      .map((node) => node.group?.branch);
    assert.deepEqual([...new Set(branchGroups)].sort(), ["left", "right"]);

    const choiceGraph = getDomainPackFlowGraphProjection(import.meta.url, pack.id, "ChoiceRun");
    const choiceMarker = choiceGraph.flow.nodes.find((node) => node.kind === "choice");
    assert.ok(choiceMarker);
    const whenEdges = choiceGraph.flow.edges.filter((edge) => edge.when);
    assert.deepEqual(whenEdges.map((edge) => edge.when).sort(), ['else', 'mode == "fast"']);
  } finally {
    restoreEnvironment(fixture);
  }
});
