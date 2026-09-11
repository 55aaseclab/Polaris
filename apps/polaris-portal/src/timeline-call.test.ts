import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactPreviewPage,
  pathLabelParts,
  timelineCallBlock,
  timelineValue,
  workspaceFilePage,
  workspaceFileUrl,
  workspaceRelativePath,
} from "./timeline-call.js";

const RUN_ID = "run-c05db415-8151-402b-a938-3a575825081d";
const FULL = `/home/debian/jianxiaoyi/polaris/.polaris/workflow-workspaces/${RUN_ID}/collection/inputs/input.json`;

test("shortens workspace paths after the run id", () => {
  assert.equal(workspaceRelativePath(RUN_ID, FULL), "collection/inputs/input.json");
  assert.equal(workspaceRelativePath(RUN_ID, "not a path"), null);
  assert.deepEqual(timelineValue(RUN_ID, FULL), {
    kind: "file",
    label: "collection/inputs/input.json",
    path: "collection/inputs/input.json",
  });
  const booleanValue = timelineValue(RUN_ID, true);
  assert.equal(booleanValue.kind, "scalar");
  if (booleanValue.kind === "scalar") assert.equal(booleanValue.tone, "boolean");
  assert.deepEqual(
    pathLabelParts("data-collections/collection-run-c05db415-8151-402b-a938-3a575825081d/outputs/output.json"),
    [
      "data-collections",
      "collection-run-c05db415-8151-402b-a938-3a575825081d",
      "outputs",
      "output.json",
    ],
  );
});

test("formats a tool call without repeating the raw dump", () => {
  const block = timelineCallBlock({
    runId: RUN_ID,
    call: "literature.collection@1.0.0",
    input: { question: "研究 cybermodel", keywordPlanRef: FULL },
    output: { collectionInputRef: FULL, inputValid: true },
    outputFields: ["collectionInputRef", "inputValid"],
    detail: "call literature.collection@1.0.0 · resumed prepareCollection",
  });
  assert.deepEqual(block, {
    call: "literature.collection@1.0.0",
    uses: [
      { key: "question", value: { kind: "scalar", text: "研究 cybermodel", tone: "string" } },
      { key: "keywordPlanRef", value: { kind: "file", label: "collection/inputs/input.json", path: "collection/inputs/input.json" } },
    ],
    outputs: [
      { key: "collectionInputRef", value: { kind: "file", label: "collection/inputs/input.json", path: "collection/inputs/input.json" } },
      { key: "inputValid", value: { kind: "scalar", text: "true", tone: "boolean" } },
    ],
    note: "resumed prepareCollection",
  });
});

test("builds dedicated preview pages for artifacts and workspace files", () => {
  assert.equal(
    artifactPreviewPage("run/example", "artifact/report.pdf"),
    "/work/runs/run%2Fexample/artifacts/artifact%2Freport.pdf",
  );
  assert.equal(
    workspaceFilePage(RUN_ID, "collection/inputs/input.json"),
    `/work/runs/${RUN_ID}/files/collection/inputs/input.json`,
  );
  assert.equal(
    workspaceFileUrl(RUN_ID, "collection/inputs/input.json"),
    `/api/workflow-runs/${RUN_ID}/files?path=collection%2Finputs%2Finput.json`,
  );
});
