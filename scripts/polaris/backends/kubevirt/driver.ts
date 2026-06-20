import type { BackendDriver } from "../types.js";
import type { WorkspaceSpec, WorkspaceStatus } from "../../core/workspace.js";
import { renderAndWriteKubevirtWorkspace } from "./render.js";

export class KubevirtDriver implements BackendDriver {
  readonly kind = "kubevirt-vm" as const;

  async create(workspace: WorkspaceSpec): Promise<void> {
    renderAndWriteKubevirtWorkspace(workspace);
  }

  async start(_workspace: WorkspaceSpec): Promise<void> {
    throw new Error("Workspace backend 'kubevirt-vm' start is not implemented in the TypeScript control plane yet");
  }

  async stop(_workspace: WorkspaceSpec): Promise<void> {
    throw new Error("Workspace backend 'kubevirt-vm' stop is not implemented in the TypeScript control plane yet");
  }

  async restart(_workspace: WorkspaceSpec): Promise<void> {
    throw new Error("Workspace backend 'kubevirt-vm' restart is not implemented in the TypeScript control plane yet");
  }

  async rebuild(workspace: WorkspaceSpec): Promise<void> {
    renderAndWriteKubevirtWorkspace(workspace);
  }

  async render(workspace: WorkspaceSpec): Promise<void> {
    renderAndWriteKubevirtWorkspace(workspace);
  }

  async apply(_workspace: WorkspaceSpec): Promise<void> {
    throw new Error("Workspace backend 'kubevirt-vm' does not support live apply in the TypeScript control plane yet");
  }

  async status(workspace: WorkspaceSpec): Promise<WorkspaceStatus> {
    return {
      project: workspace.identity.projectName,
      backend: { kind: workspace.backend.kind, profile: workspace.backend.profile },
      lifecycleAction: "status",
      state: "saved",
      health: {
        backendLiveness: "spec-only",
        workspaceReadiness: "saved",
        daemonReadiness: "unknown"
      },
      details: {
        driver: "kubevirt",
        mode: "spec-only"
      }
    };
  }

  async reconcile(workspace: WorkspaceSpec): Promise<WorkspaceStatus> {
    return {
      ...(await this.status(workspace)),
      lifecycleAction: "reconcile"
    };
  }
}
