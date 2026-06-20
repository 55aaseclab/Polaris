import type { BackendDriver } from "../types.js";
import type { WorkspaceSpec, WorkspaceStatus } from "../../core/workspace.js";
import { runCommand } from "../../utils/shell.js";
import { renderAndWritePodWorkspace } from "./render.js";

export class PodDriver implements BackendDriver {
  readonly kind = "pod" as const;

  async create(workspace: WorkspaceSpec): Promise<void> {
    renderAndWritePodWorkspace(workspace);
  }

  async start(workspace: WorkspaceSpec): Promise<void> {
    const outputPath = renderAndWritePodWorkspace(workspace);
    runCommand("kubectl", ["apply", "-f", outputPath]);
  }

  async stop(workspace: WorkspaceSpec): Promise<void> {
    runCommand("kubectl", ["-n", workspace.identity.projectName, "scale", "deployment", workspace.identity.projectName, "--replicas=0"]);
  }

  async restart(workspace: WorkspaceSpec): Promise<void> {
    runCommand("kubectl", ["-n", workspace.identity.projectName, "rollout", "restart", "deployment", workspace.identity.projectName]);
  }

  async rebuild(workspace: WorkspaceSpec): Promise<void> {
    const outputPath = renderAndWritePodWorkspace(workspace);
    runCommand("kubectl", ["apply", "-f", outputPath]);
  }

  async render(workspace: WorkspaceSpec): Promise<void> {
    renderAndWritePodWorkspace(workspace);
  }

  async apply(workspace: WorkspaceSpec): Promise<void> {
    const outputPath = renderAndWritePodWorkspace(workspace);
    runCommand("kubectl", ["apply", "-f", outputPath]);
  }

  async status(workspace: WorkspaceSpec): Promise<WorkspaceStatus> {
    return {
      project: workspace.identity.projectName,
      backend: { kind: workspace.backend.kind, profile: workspace.backend.profile },
      lifecycleAction: "status",
      state: "saved",
      health: {
        backendLiveness: "unknown",
        workspaceReadiness: "unknown",
        daemonReadiness: workspace.health.requiresDaemon ? "expected" : "not-applicable"
      },
      details: {
        driver: "pod",
        readinessMode: workspace.health.readinessMode
      }
    };
  }

  async reconcile(workspace: WorkspaceSpec): Promise<WorkspaceStatus> {
    return {
      ...(await this.status(workspace)),
      lifecycleAction: "reconcile",
      details: {
        driver: "pod",
        reconcileScope: "stale-artifacts + structural-invariants"
      }
    };
  }
}
