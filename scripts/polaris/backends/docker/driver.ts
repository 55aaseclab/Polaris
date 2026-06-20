import type { BackendDriver } from "../types.js";
import type { BackendObservation, ReconcilePlan, WorkspaceSpec } from "../../core/workspace.js";

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

  async inspect(workspace: WorkspaceSpec): Promise<BackendObservation> {
    return {
      backend: {
        kind: workspace.backend.kind,
        exists: false,
        running: false,
        detail: "docker backend remains legacy-only during migration",
      },
      attachments: {
        workspaceData: { observed: false, detail: "legacy docker backend does not expose attachment observations yet" },
        workspaceRuntimeState: { observed: false, detail: "legacy docker backend does not expose attachment observations yet" },
        userIdentityState: { observed: false, detail: "legacy docker backend does not expose attachment observations yet" },
        userSshState: { observed: false, detail: "legacy docker backend does not expose attachment observations yet" },
      },
      runtimeAssembly: {},
      daemon: {},
      services: {
        declared: workspace.connectivity.servicePorts.length ? 1 : 0,
        observed: 0,
        detail: "legacy docker backend not inspected",
      },
    };
  }

  async executeReconcilePlan(_workspace: WorkspaceSpec, _plan: ReconcilePlan): Promise<void> {
    throw new Error("Workspace backend 'docker' cannot execute reconcile plans yet");
  }
}
