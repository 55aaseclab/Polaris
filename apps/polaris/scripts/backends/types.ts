import type { BackendObservation, ReconcilePlan, WorkspaceSpec } from "../core/workspace.js";

export interface BackendDriver {
  readonly kind: WorkspaceSpec["backend"]["kind"];
  create(workspace: WorkspaceSpec): Promise<void>;
  start(workspace: WorkspaceSpec): Promise<void>;
  stop(workspace: WorkspaceSpec): Promise<void>;
  restart(workspace: WorkspaceSpec): Promise<void>;
  rebuild(workspace: WorkspaceSpec): Promise<void>;
  render(workspace: WorkspaceSpec): Promise<void>;
  apply(workspace: WorkspaceSpec): Promise<void>;
  logs(workspace: WorkspaceSpec): Promise<void>;
  inspect(workspace: WorkspaceSpec): Promise<BackendObservation>;
  executeReconcilePlan(workspace: WorkspaceSpec, plan: ReconcilePlan): Promise<void>;
}
