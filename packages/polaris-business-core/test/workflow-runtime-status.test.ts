import assert from "node:assert/strict";
import test from "node:test";
import {
  findRunningWorkflowStages,
  workflowRuntimeStageKey,
} from "../src/workflow-runtime-status.js";

test("workflow runtime status matches only the owning Wanghai stage tool", () => {
  const workflowId = "synthetic-review";
  const collectionKey = workflowRuntimeStageKey(workflowId, "data-collection");
  const analysisKey = workflowRuntimeStageKey(workflowId, "intelligence-analysis");
  const reportKey = workflowRuntimeStageKey(workflowId, "report-writing");
  const root = "/vault/workspaces/demo/workflows/synthetic-review";

  const matches = findRunningWorkflowStages(
    [
      {
        key: collectionKey,
        rootPath: `${root}/data-collection`,
        stageId: "data-collection",
        workflowId,
      },
      {
        key: analysisKey,
        rootPath: `${root}/intelligence-analysis`,
        stageId: "intelligence-analysis",
        workflowId,
      },
      {
        key: reportKey,
        rootPath: `${root}/report-writing`,
        stageId: "report-writing",
        workflowId,
      },
    ],
    [
      {
        cmd: `node tools/data-collection/clue-data-collection run --workspace ${root}/data-collection`,
        pid: 101,
      },
      {
        cmd: `node tools/report-writing/clue-report-writing run --analysis-output ${root}/intelligence-analysis/outputs/output.json --workflow ${workflowId}`,
        pid: 202,
      },
      {
        cmd: `bash -c tail -f ${root}/data-collection/work/progress.json`,
        pid: 303,
      },
    ],
  );

  assert.deepEqual([...matches.keys()], [collectionKey, reportKey]);
  assert.equal(matches.get(collectionKey)?.[0]?.pid, 101);
  assert.equal(matches.get(analysisKey), undefined);
  assert.equal(matches.get(reportKey)?.[0]?.pid, 202);
});
