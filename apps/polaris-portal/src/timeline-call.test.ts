import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactPreviewPage,
  pathLabelParts,
  timelineAttempts,
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

test("groups a failed step's receipts into ordered attempts", () => {
  const receipts = [
    { requestId: `${RUN_ID.replace("run-", "ffi-")}-10`, stepId: "fixture", status: "failed", errorCode: "step-attempt-timeout", errorMessage: "boom", errorValues: { timeout: 100 }, createdAt: "2026-10-16T10:00:00.000Z" },
    { requestId: "ffi-other-2", stepId: "other", status: "completed", createdAt: "2026-10-16T10:00:01.000Z" },
    { requestId: "ffi-run-2", stepId: "fixture", status: "failed", createdAt: "2026-10-16T10:00:02.000Z" },
    { requestId: "ffi-run-3", stepId: "fixture", status: "completed", createdAt: "2026-10-16T10:00:03.000Z" },
  ];
  assert.deepEqual(timelineAttempts(receipts, "fixture"), [
    { attempt: 1, attemptCount: 3, requestId: "ffi-run-10", status: "failed", error: "boom", errorCode: "step-attempt-timeout", values: { timeout: 100 } },
    { attempt: 2, attemptCount: 3, requestId: "ffi-run-2", status: "failed" },
    { attempt: 3, attemptCount: 3, requestId: "ffi-run-3", status: "completed" },
  ]);
});

test("attempt grouping tolerates missing receipts and unordered request ids", () => {
  assert.deepEqual(timelineAttempts(undefined, "fixture"), []);
  assert.deepEqual(timelineAttempts([], "fixture"), []);
  const reversed = [
    { requestId: "ffi-run-3", stepId: "fixture", status: "completed", createdAt: "2026-10-16T10:00:00.000Z" },
    { requestId: "ffi-run-1", stepId: "fixture", status: "failed", createdAt: "2026-10-16T10:00:00.000Z" },
  ];
  assert.deepEqual(
    timelineAttempts(reversed, "fixture").map((attempt) => attempt.requestId),
    ["ffi-run-1", "ffi-run-3"],
  );
});
