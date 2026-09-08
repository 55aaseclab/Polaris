export function workflowDisplayPath(
  workflowId: string,
  assetPath: string,
): string {
  const prefix = `workflows/${workflowId}/`;
  if (assetPath.startsWith(prefix)) {
    const trimmed = assetPath.slice(prefix.length);
    return trimmed || assetPath;
  }
  return assetPath;
}

export function workflowIdFromAssetPath(assetPath: string): string | null {
  const parts = assetPath.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "workflows") {
    return null;
  }
  return parts[1] ?? null;
}

export type WorkflowAssetLike = {
  path: string;
};

export type WorkflowLike<TAsset extends WorkflowAssetLike = WorkflowAssetLike> = {
  id: string;
  stages: Array<{
    inputs: TAsset[];
    outputs: TAsset[];
  }>;
};

export function findWorkflowAssetByPath<
  TAsset extends WorkflowAssetLike,
  TWorkflow extends WorkflowLike<TAsset>,
>(
  workflows: TWorkflow[],
  assetPath: string,
): { asset: TAsset; workflow: TWorkflow } | null {
  const targetWorkflowId = workflowIdFromAssetPath(assetPath);
  if (!targetWorkflowId) return null;

  const workflow = workflows.find((item) => item.id === targetWorkflowId) ?? null;
  if (!workflow) return null;

  for (const stage of workflow.stages) {
    for (const asset of [...stage.inputs, ...stage.outputs]) {
      if (asset.path === assetPath) {
        return { asset, workflow };
      }
    }
  }
  return null;
}
