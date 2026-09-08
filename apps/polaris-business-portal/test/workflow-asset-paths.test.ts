import assert from "node:assert/strict";
import test from "node:test";
import {
  findWorkflowAssetByPath,
  workflowDisplayPath,
  workflowIdFromAssetPath,
} from "../lib/workflow-asset-paths.js";

test("workflowDisplayPath trims the workflow root prefix", () => {
  assert.equal(
    workflowDisplayPath(
      "demo-workflow",
      "workflows/demo-workflow/data-collection/outputs/output.json",
    ),
    "data-collection/outputs/output.json",
  );
});

test("workflowDisplayPath leaves unrelated paths unchanged", () => {
  assert.equal(
    workflowDisplayPath(
      "demo-workflow",
      "assets/产品管理/交付归档/catalogs/demo/outputs/catalog.pdf",
    ),
    "assets/产品管理/交付归档/catalogs/demo/outputs/catalog.pdf",
  );
});

test("workflowIdFromAssetPath extracts workflow ids from workflow assets", () => {
  assert.equal(
    workflowIdFromAssetPath(
      "workflows/demo-workflow/report-writing/outputs/report.pdf",
    ),
    "demo-workflow",
  );
});

test("workflowIdFromAssetPath ignores non-workflow assets", () => {
  assert.equal(
    workflowIdFromAssetPath(
      "assets/产品管理/交付归档/catalogs/demo/outputs/catalog.pdf",
    ),
    null,
  );
});

test("findWorkflowAssetByPath resolves deep-linked workflow assets", () => {
  const match = findWorkflowAssetByPath(
    [
      {
        id: "demo-workflow",
        stages: [
          {
            inputs: [],
            outputs: [
              {
                path: "workflows/demo-workflow/report-writing/outputs/report.pdf",
              },
            ],
          },
        ],
      },
    ],
    "workflows/demo-workflow/report-writing/outputs/report.pdf",
  );

  assert.equal(match?.workflow.id, "demo-workflow");
  assert.equal(
    match?.asset.path,
    "workflows/demo-workflow/report-writing/outputs/report.pdf",
  );
});
