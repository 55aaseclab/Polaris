import assert from "node:assert/strict";
import test from "node:test";
import {
  workflowOverviewStatusItems,
  workflowNeedsManualReview,
  workflowRunning,
} from "../lib/workflow-overview-status.js";

function baseWorkflow() {
  return {
    last_run: null,
    pipeline_status: "incomplete" as const,
    stages: [
      {
        inputs: [],
        outputs: [],
        status: {
          facts: [],
          ready: false,
          status: null,
        },
      },
    ],
  };
}

test("completed workflow does not count historical manual-review assets as pending review", () => {
  const workflow = {
    ...baseWorkflow(),
    last_run: { status: "succeeded" },
    pipeline_status: "current" as const,
    stages: [
      {
        inputs: [],
        outputs: [{ path: "workflows/demo/data-collection/outputs/manual-review-list.json" }],
        status: {
          facts: [],
          ready: true,
          status: "final",
        },
      },
    ],
  };

  assert.equal(workflowNeedsManualReview(workflow), false);
  assert.equal(workflowRunning(workflow), false);
});

test("unfinished workflow with manual-review asset still counts as pending review", () => {
  const workflow = {
    ...baseWorkflow(),
    stages: [
      {
        inputs: [],
        outputs: [{ path: "workflows/demo/data-collection/outputs/manual-review-list.json" }],
        status: {
          facts: [],
          ready: false,
          status: "missing",
        },
      },
    ],
  };

  assert.equal(workflowNeedsManualReview(workflow), true);
  assert.equal(workflowRunning(workflow), true);
});

test("unfinished workflow with partial review fact still counts as pending review", () => {
  const workflow = {
    ...baseWorkflow(),
    stages: [
      {
        inputs: [],
        outputs: [],
        status: {
          facts: [{ label: "审核", value: "manual_review · 2/5" }],
          ready: false,
          status: "missing",
        },
      },
    ],
  };

  assert.equal(workflowNeedsManualReview(workflow), true);
  assert.equal(workflowRunning(workflow), true);
});

test("overview status items use explicit combined labels", () => {
  const runningWorkflow = {
    ...baseWorkflow(),
    last_run: { status: "running" },
    stages: [
      {
        inputs: [],
        outputs: [],
        status: {
          facts: [],
          ready: false,
          status: "running",
        },
      },
    ],
  };
  const completedWorkflow = {
    ...baseWorkflow(),
    last_run: { status: "succeeded" },
    pipeline_status: "current" as const,
    stages: [
      {
        inputs: [],
        outputs: [],
        status: {
          facts: [],
          ready: true,
          status: "final",
        },
      },
    ],
  };

  assert.deepEqual(
    workflowOverviewStatusItems([runningWorkflow, completedWorkflow]),
    [
      { label: "需要评审", value: "0" },
      { label: "暂停/运行中", value: "0/1" },
      { label: "成功/已完成", value: "1/1" },
    ],
  );
});
