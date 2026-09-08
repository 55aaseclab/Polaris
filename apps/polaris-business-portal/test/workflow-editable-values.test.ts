import assert from "node:assert/strict";
import test from "node:test";
import { flattenEditableFields } from "../lib/workflow-editable-values.js";

test("flattenEditableFields expands workflow step details", () => {
  const fields = flattenEditableFields({
    report_id: "example-report",
    root_path: "workflows/example/report-writing",
    steps: [
      {
        id: "write-report",
        tool: "report-writing",
        command: "run",
        args: [
          "--analysis-output",
          "{{analysis_output}}",
        ],
      },
    ],
  }, "", {
    analysis_output: "/workspace/workflows/example/intelligence-analysis/outputs/output.json",
  });

  assert.deepEqual(fields, [
    { path: "report_id", value: "example-report" },
    { path: "root_path", value: "workflows/example/report-writing" },
    { path: "steps[1].id", value: "write-report" },
    { path: "steps[1].tool", value: "report-writing" },
    { path: "steps[1].command", value: "run" },
    { path: "steps[1].args[1]", value: "--analysis-output" },
    {
      path: "steps[1].args[2]",
      value: "/workspace/workflows/example/intelligence-analysis/outputs/output.json",
    },
  ]);
});

test("flattenEditableFields keeps non-step arrays compact", () => {
  const fields = flattenEditableFields({
    depends_on: [
      { stage: "data-collection", reference_path: "inputs/input.json" },
    ],
  });

  assert.deepEqual(fields, [
    {
      path: "depends_on",
      value: JSON.stringify([
        { stage: "data-collection", reference_path: "inputs/input.json" },
      ]),
    },
  ]);
});
