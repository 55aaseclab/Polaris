import type { BackendDriver } from "../types.js";
import type { WorkspaceSpec, WorkspaceStatus } from "../../core/workspace.js";

export class DockerDriver implements BackendDriver {
  readonly kind = "docker" as const;

  async create(_workspace: WorkspaceSpec): Promise<void> {
    throw new Error("Workspace backend 'docker' remains legacy-only during the TypeScript migration");
  }

  async start(_workspace: WorkspaceSpec): Promise<void> {
    throw new Error("Workspace backend 'docker' remains legacy-only during the TypeScript migration");
  }

  async stop(_workspace: WorkspaceSpec): Promise<void> {
    throw new Error("Workspace backend 'docker' remains legacy-only during the TypeScript migration");
  }

  async restart(_workspace: WorkspaceSpec): Promise<void> {
    throw new Error("Workspace backend 'docker' remains legacy-only during the TypeScript migration");
  }

  async rebuild(_workspace: WorkspaceSpec): Promise<void> {
    throw new Error("Workspace backend 'docker' remains legacy-only during the TypeScript migration");
  }

  async render(_workspace: WorkspaceSpec): Promise<void> {
    throw new Error("Workspace backend 'docker' is preserved as legacy material and is not rendered by the TypeScript control plane yet");
  }

  async apply(_workspace: WorkspaceSpec): Promise<void> {
    throw new Error("Workspace backend 'docker' is preserved as legacy material and is not applied by the TypeScript control plane yet");
  }

  async status(workspace: WorkspaceSpec): Promise<WorkspaceStatus> {
    return {
      project: workspace.identity.projectName,
      backend: { kind: workspace.backend.kind, profile: workspace.backend.profile },
      lifecycleAction: "status",
      state: "unsupported",
      health: {
        backendLiveness: "legacy",
        workspaceReadiness: "unsupported",
        daemonReadiness: "unknown",
        reason: "docker backend remains packaged as legacy material during migration"
      },
      details: {
        driver: "docker",
        mode: "legacy"
      }
    };
  }

  async reconcile(workspace: WorkspaceSpec): Promise<WorkspaceStatus> {
    return this.status(workspace);
  }
}
