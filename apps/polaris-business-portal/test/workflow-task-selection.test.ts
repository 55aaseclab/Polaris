import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkflowTaskSelectionGroups,
  existingTaskSelectionValue,
  selectedExistingWorkflowId,
  selectedTemplateId,
  templateSelectionValue,
} from "../lib/workflow-task-selection.js";

test("buildWorkflowTaskSelectionGroups keeps templates before existing tasks", () => {
  const groups = buildWorkflowTaskSelectionGroups(
    [{ id: "literature-review", title: "literature-review" }],
    [{ id: "lit-review-20260731", title: "lit-review-20260731" }],
  );

  assert.deepEqual(groups, [
    {
      id: "templates",
      items: [{ label: "literature-review", value: "template:literature-review" }],
      label: "模板",
    },
    {
      id: "existing",
      items: [{ label: "lit-review-20260731", value: "workflow:lit-review-20260731" }],
      label: "已有任务",
    },
  ]);
});

test("workflow task selection helpers resolve template and workflow ids", () => {
  assert.equal(templateSelectionValue("literature-review"), "template:literature-review");
  assert.equal(existingTaskSelectionValue("lit-review-20260731"), "workflow:lit-review-20260731");
  assert.equal(selectedTemplateId("template:literature-review"), "literature-review");
  assert.equal(selectedTemplateId("workflow:lit-review-20260731"), null);
  assert.equal(selectedExistingWorkflowId("workflow:lit-review-20260731"), "lit-review-20260731");
  assert.equal(selectedExistingWorkflowId("template:literature-review"), null);
});
