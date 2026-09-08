type WorkflowAssetLike = {
  path: string;
};

type WorkflowFactLike = {
  label: string;
  value: string;
};

type WorkflowStageLike = {
  inputs: WorkflowAssetLike[];
  outputs: WorkflowAssetLike[];
  status: {
    facts: WorkflowFactLike[];
    ready: boolean;
    status: string | null;
  };
};

type WorkflowLike = {
  last_run: {
    status: string;
  } | null;
  pipeline_status: "current" | "stale" | "incomplete" | "unknown";
  stages: WorkflowStageLike[];
};

type WorkflowOverviewStatusItem = {
  label: string;
  value: string;
};

export function parseFraction(value: string): { left: number; right: number } | null {
  const match = value.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;
  return {
    left: Number(match[1]),
    right: Number(match[2]),
  };
}

export function isManualReviewListPath(assetPath: string): boolean {
  return assetPath.split("/").at(-1) === "manual-review-list.json";
}

export function stageNeedsManualReview(stage: WorkflowStageLike): boolean {
  const reviewFact = stage.status.facts.find((fact) => fact.label === "审核");
  const reviewProgress = reviewFact ? parseFraction(reviewFact.value) : null;
  if (reviewProgress && reviewProgress.left < reviewProgress.right) return true;
  return [...stage.inputs, ...stage.outputs].some((asset) => isManualReviewListPath(asset.path));
}

export function workflowCompletedSuccessfully(workflow: WorkflowLike): boolean {
  const lastRunStatus = workflow.last_run?.status.toLowerCase();
  if (lastRunStatus === "succeeded" || lastRunStatus === "success" || lastRunStatus === "completed") {
    return true;
  }
  return workflow.pipeline_status === "current" || workflow.pipeline_status === "stale";
}

export function workflowCompleted(workflow: WorkflowLike): boolean {
  if (workflowCompletedSuccessfully(workflow)) return true;
  const lastRunStatus = workflow.last_run?.status.toLowerCase();
  return lastRunStatus === "failed"
    || lastRunStatus === "error"
    || lastRunStatus === "cancelled"
    || lastRunStatus === "canceled"
    || lastRunStatus === "aborted";
}

export function workflowNeedsManualReview(workflow: WorkflowLike): boolean {
  if (workflowCompletedSuccessfully(workflow)) return false;
  return workflow.stages.some((stage) => stageNeedsManualReview(stage));
}

export function workflowRunning(workflow: WorkflowLike): boolean {
  if (workflowNeedsManualReview(workflow)) return true;
  if (workflow.last_run?.status.toLowerCase() === "running") return true;
  return workflow.stages.some((stage) => stage.status.status === "running");
}

export function workflowOverviewStatusItems(workflows: WorkflowLike[]): WorkflowOverviewStatusItem[] {
  const needsReviewCount = workflows.filter(workflowNeedsManualReview).length;
  const pausedCount = needsReviewCount;
  const runningCount = workflows.filter(workflowRunning).length;
  const completedCount = workflows.filter(workflowCompleted).length;
  const successfulCount = workflows.filter(workflowCompletedSuccessfully).length;

  return [
    { label: "需要评审", value: String(needsReviewCount) },
    { label: "暂停/运行中", value: `${pausedCount}/${runningCount}` },
    { label: "成功/已完成", value: `${successfulCount}/${completedCount}` },
  ];
}
