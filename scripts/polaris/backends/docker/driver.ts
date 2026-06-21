import { spawnSync } from "node:child_process";
import type { BackendDriver } from "../types.js";
import type { BackendObservation, ReconcilePlan, WorkspaceSpec } from "../../core/workspace.js";
import { renderAndWriteDockerWorkspace } from "./render.js";
import { runCommand } from "../../utils/shell.js";

export class DockerDriver implements BackendDriver {
  readonly kind = "docker" as const;

  async create(workspace: WorkspaceSpec): Promise<void> {
    renderAndWriteDockerWorkspace(workspace);
  }

  async start(workspace: WorkspaceSpec): Promise<void> {
    const outputPath = renderAndWriteDockerWorkspace(workspace);
    runCommand("docker", ["compose", "-f", outputPath, "up", "-d"]);
  }

  async stop(workspace: WorkspaceSpec): Promise<void> {
    const outputPath = renderAndWriteDockerWorkspace(workspace);
    runCommand("docker", ["compose", "-f", outputPath, "stop"]);
  }

  async restart(workspace: WorkspaceSpec): Promise<void> {
    const outputPath = renderAndWriteDockerWorkspace(workspace);
    runCommand("docker", ["compose", "-f", outputPath, "restart"]);
  }

  async rebuild(workspace: WorkspaceSpec): Promise<void> {
    const outputPath = renderAndWriteDockerWorkspace(workspace);
    runCommand("docker", ["compose", "-f", outputPath, "up", "-d", "--force-recreate"]);
  }

  async render(workspace: WorkspaceSpec): Promise<void> {
    renderAndWriteDockerWorkspace(workspace);
  }

  async apply(workspace: WorkspaceSpec): Promise<void> {
    const outputPath = renderAndWriteDockerWorkspace(workspace);
    runCommand("docker", ["compose", "-f", outputPath, "up", "-d"]);
  }

  async logs(workspace: WorkspaceSpec): Promise<void> {
    const outputPath = renderAndWriteDockerWorkspace(workspace);
    runCommand("docker", ["compose", "-f", outputPath, "logs", "--tail", "200", workspace.identity.projectName]);
  }

  async inspect(workspace: WorkspaceSpec): Promise<BackendObservation> {
    const outputPath = renderAndWriteDockerWorkspace(workspace);
    const containerId = spawnSync("docker", ["compose", "-f", outputPath, "ps", "-q", workspace.identity.projectName], { encoding: "utf8" });
    const id = (containerId.stdout || "").trim();
    const exists = Boolean(id);
    const inspect = exists
      ? spawnSync("docker", ["inspect", id], { encoding: "utf8" })
      : { status: 1, stdout: "", stderr: "" };
    const running = exists && /"Running":\s*true/.test(inspect.stdout || "");
    const execCheck = (command: string): boolean => {
      if (!exists) return false;
      const result = spawnSync("docker", ["exec", id, "sh", "-lc", command], { encoding: "utf8" });
      return result.status === 0;
    };
    const daemonObserved =
      workspace.agent.enabled && exists && running
        ? execCheck(`test -f ${workspace.agent.readyFile} && test -f ${workspace.agent.pairingFile}`)
        : workspace.agent.enabled
          ? false
          : true;

    return {
      backend: {
        kind: workspace.backend.kind,
        exists,
        running,
        detail: exists ? id : "docker container missing",
      },
      attachments: exists && running ? {
        workspaceData: { observed: execCheck(`test -d ${workspace.attachments.workspaceData.mountRoot}`), detail: workspace.attachments.workspaceData.mountRoot },
        workspaceRuntimeState: { observed: execCheck(`test -d ${workspace.attachments.workspaceRuntimeState.mountRoot}`), detail: workspace.attachments.workspaceRuntimeState.mountRoot },
        userIdentityState: { observed: execCheck(`test -d ${workspace.attachments.userIdentityState.mountRoot}`), detail: workspace.attachments.userIdentityState.mountRoot },
        userSshState: { observed: execCheck(`test -d ${workspace.attachments.userSshState.mountRoot}`), detail: workspace.attachments.userSshState.mountRoot },
      } : {},
      runtimeAssembly: exists && running ? {
        home: { observed: execCheck(`test -d ${workspace.runtime.home}`), detail: workspace.runtime.home },
        projectRoot: { observed: execCheck(`test -L ${workspace.runtime.home}/workspace || test -L ${workspace.runtime.home}/${workspace.profile.workspaceAlias ?? "workspace"}`), detail: `${workspace.runtime.home}/workspace` },
        paseo: { observed: execCheck(`test -L ${workspace.runtime.home}/.paseo`), detail: `${workspace.runtime.home}/.paseo` },
        codex: { observed: execCheck(`test -L ${workspace.runtime.home}/.codex`), detail: `${workspace.runtime.home}/.codex` },
        claude: { observed: execCheck(`test -L ${workspace.runtime.home}/.claude`), detail: `${workspace.runtime.home}/.claude` },
        ssh: { observed: execCheck(`test -L ${workspace.runtime.home}/.ssh || test -d ${workspace.runtime.home}/.ssh`), detail: `${workspace.runtime.home}/.ssh` },
      } : {},
      daemon: {
        paseo: workspace.health.requiresDaemon && exists && running
          ? { observed: daemonObserved, detail: workspace.agent.pairingFile ?? workspace.agent.readyFile }
          : workspace.health.requiresDaemon
            ? { observed: false, detail: workspace.agent.readyFile }
            : { observed: true, detail: "daemon not required" },
      },
      services: {
        declared: workspace.connectivity.servicePorts.length ? 1 : 0,
        observed: workspace.connectivity.servicePorts.length ? (exists ? 1 : 0) : 0,
        detail: exists ? "docker compose service is present" : "docker compose service is missing",
      },
    };
  }

  async executeReconcilePlan(workspace: WorkspaceSpec, plan: ReconcilePlan): Promise<void> {
    const outputPath = renderAndWriteDockerWorkspace(workspace);
    for (const action of plan.actions) {
      if (action.kind === "render") {
        renderAndWriteDockerWorkspace(workspace);
        continue;
      }
      if (action.kind === "apply") {
        runCommand("docker", ["compose", "-f", outputPath, "up", "-d"]);
        continue;
      }
      if (action.kind === "restart-runtime") {
        runCommand("docker", ["compose", "-f", outputPath, "restart"]);
        continue;
      }
      if (action.kind === "repair-runtime-assembly" || action.kind === "clean-ephemeral-runtime") {
        runCommand("docker", ["compose", "-f", outputPath, "restart"]);
        continue;
      }
      if (action.kind === "report-unrecoverable-drift") {
        throw new Error(action.reason || "docker backend cannot repair workspace drift");
      }
    }
  }
}
