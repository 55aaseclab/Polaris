export type BrainWorkflowMode = "dtc" | "research" | null;
export type WorkspaceType = "unclassified" | "ecommerce" | "research";

export function selectBrainWorkflowMode(
  workspaceType: WorkspaceType | null,
  workspacesReady: boolean,
): BrainWorkflowMode {
  if (!workspacesReady || workspaceType === null) {
    return null;
  }
  return workspaceType === "research" ? "research" : "dtc";
}
