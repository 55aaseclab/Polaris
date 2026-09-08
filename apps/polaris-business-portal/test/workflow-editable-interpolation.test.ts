import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkflowInterpolationValues } from "../lib/workflow-editable-interpolation.js";

test("buildWorkflowInterpolationValues matches workflow runtime-style keys", () => {
  const values = buildWorkflowInterpolationValues({
    category: "literature-review",
    stages: {
      "data-collection": {
        collection_id: "demo-collection",
        root_path: "workflows/demo-workflow/data-collection",
      },
      "intelligence-analysis": {
        analysis_id: "demo-analysis",
        root_path: "workflows/demo-workflow/intelligence-analysis",
      },
      "report-writing": {
        report_id: "demo-report",
        root_path: "workflows/demo-workflow/report-writing",
        template: "literature-report",
        claim_filter: "inputs/claim-filter.json",
        output_path: "outputs/report.pdf",
      },
    },
    workflowId: "demo-workflow",
    workspaceId: "demo-workspace",
    workspaceRoot: "/workspace/demo-workspace",
  });

  assert.equal(values.workspace_id, "demo-workspace");
  assert.equal(values.workflow_id, "demo-workflow");
  assert.equal(
    values.data_collection_input,
    "/workspace/demo-workspace/workflows/demo-workflow/data-collection/inputs/input.json",
  );
  assert.equal(
    values.analysis_root,
    "/workspace/demo-workspace/workflows/demo-workflow/intelligence-analysis",
  );
  assert.equal(
    values.report_pdf,
    "/workspace/demo-workspace/workflows/demo-workflow/report-writing/outputs/report.pdf",
  );
  assert.equal(
    values.report_claim_filter,
    "/workspace/demo-workspace/workflows/demo-workflow/report-writing/inputs/claim-filter.json",
  );
  assert.equal(values.report_template, "literature-report");
});
