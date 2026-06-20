import type { WorkspaceSpec, WorkspaceStatus } from "../core/workspace.js";

export interface BackendDriver {
  readonly kind: WorkspaceSpec["backend"]["kind"];
  create(workspace: WorkspaceSpec): Promise<void>;
  start(workspace: WorkspaceSpec): Promise<void>;
  stop(workspace: WorkspaceSpec): Promise<void>;
  restart(workspace: WorkspaceSpec): Promise<void>;
  rebuild(workspace: WorkspaceSpec): Promise<void>;
  render(workspace: WorkspaceSpec): Promise<void>;
  apply(workspace: WorkspaceSpec): Promise<void>;
  status(workspace: WorkspaceSpec): Promise<WorkspaceStatus>;
  reconcile(workspace: WorkspaceSpec): Promise<WorkspaceStatus>;
}
