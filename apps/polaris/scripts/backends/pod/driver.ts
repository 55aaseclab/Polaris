import { spawnSync } from "node:child_process";
import type { BackendDriver } from "../types.js";
import type { BackendObservation, ReconcilePlan, WorkspaceSpec } from "../../core/workspace.js";
import { workspaceRuntimeScopeName } from "../../core/workspace-name.js";
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
    const scope = workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName);
    runCommand("kubectl", ["-n", scope, "scale", "deployment", scope, "--replicas=0"]);
  }

  async restart(workspace: WorkspaceSpec): Promise<void> {
    const scope = workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName);
    runCommand("kubectl", ["-n", scope, "rollout", "restart", "deployment", scope]);
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

  async logs(workspace: WorkspaceSpec): Promise<void> {
    const podNameResult = spawnSync(
      "kubectl",
      ["-n", workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName), "get", "pod", "-l", `app=${workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName)}`, "-o", "jsonpath={.items[0].metadata.name}"],
      { encoding: "utf8" },
    );
    const podName = (podNameResult.stdout || "").trim();
    if (podName) {
      runCommand("kubectl", ["-n", workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName), "logs", podName, "--tail=200"]);
      return;
    }
    runCommand("kubectl", ["-n", workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName), "logs", "deployment/" + workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName), "--tail=200"]);
  }

  async inspect(workspace: WorkspaceSpec): Promise<BackendObservation> {
    const deployment = spawnSync(
      "kubectl",
      ["-n", workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName), "get", "deployment", workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName), "-o", "json"],
      { encoding: "utf8" },
    );
    if (deployment.status !== 0 || !deployment.stdout) {
      return {
        backend: {
          kind: workspace.backend.kind,
          exists: false,
          running: false,
          detail: "deployment not found",
        },
        attachments: {},
        runtimeAssembly: {},
        daemon: {},
        services: {
          declared: workspace.connectivity.servicePorts.length,
          observed: 0,
          detail: "no services observed",
        },
      };
    }

    const podNameResult = spawnSync(
      "kubectl",
      ["-n", workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName), "get", "pod", "-l", `app=${workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName)}`, "-o", "jsonpath={.items[0].metadata.name}"],
      { encoding: "utf8" },
    );
    const podName = (podNameResult.stdout || "").trim();
    const running = Boolean(podName);

    const execCheck = (command: string): boolean => {
      if (!podName) return false;
      const result = spawnSync(
        "kubectl",
        ["-n", workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName), "exec", podName, "--", "sh", "-lc", command],
        { encoding: "utf8" },
      );
      return result.status === 0;
    };
    const execOutput = (command: string): string => {
      if (!podName) return "";
      const result = spawnSync(
        "kubectl",
        ["-n", workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName), "exec", podName, "--", "sh", "-lc", command],
        { encoding: "utf8" },
      );
      return result.status === 0 ? String(result.stdout || "") : "";
    };

    const observedServices = workspace.connectivity.servicePorts.length
      ? spawnSync(
          "kubectl",
          ["-n", workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName), "get", "svc", workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName), "-o", "jsonpath={.metadata.name}"],
          { encoding: "utf8" },
        )
      : { status: 0, stdout: "", stderr: "" };
    const serviceCount = (observedServices.stdout || "").trim() ? 1 : 0;

    const githubAuthObserved =
      running && workspace.userProfile.github.account
        ? execCheck(`output=$(ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5 -T git@github.com 2>&1 || true); printf '%s' "$output" | grep -q 'successfully authenticated'`)
        : false;

    return {
      backend: {
        kind: workspace.backend.kind,
        exists: true,
        running,
        detail: podName ? `pod/${podName}` : "deployment exists but pod is not running",
      },
      attachments: running ? {
        workspaceData: { observed: execCheck(`test -d ${workspace.attachments.workspaceData.mountRoot}`), detail: workspace.attachments.workspaceData.mountRoot },
        workspaceRuntimeState: { observed: execCheck(`test -d ${workspace.attachments.workspaceRuntimeState.mountRoot}`), detail: workspace.attachments.workspaceRuntimeState.mountRoot },
        userIdentityState: { observed: execCheck(`test -d ${workspace.attachments.userIdentityState.mountRoot}`), detail: workspace.attachments.userIdentityState.mountRoot },
      } : {},
      runtimeAssembly: running ? {
        home: { observed: execCheck(`test -d ${workspace.runtime.home}`), detail: workspace.runtime.home },
        projectRoot: { observed: execCheck(`test -L ${workspace.runtime.home}/workspace || test -L ${workspace.runtime.home}/${workspace.profile.workspaceAlias ?? "workspace"}`), detail: `${workspace.runtime.home}/workspace` },
        managerState: { observed: execCheck(`test -L ${workspace.runtime.home}/.paseo`), detail: workspace.agent.runtime.stateRoot },
        evolutionState: { observed: execCheck(`test -d ${workspace.agent.runtime.evolutionRoot}`), detail: workspace.agent.runtime.evolutionRoot },
        codex: { observed: execCheck(`test -L ${workspace.runtime.home}/.codex`), detail: `${workspace.runtime.home}/.codex` },
        claude: { observed: execCheck(`test -L ${workspace.runtime.home}/.claude`), detail: `${workspace.runtime.home}/.claude` },
        ssh: { observed: execCheck(`test -L ${workspace.runtime.home}/.ssh || test -d ${workspace.runtime.home}/.ssh`), detail: `${workspace.runtime.home}/.ssh` },
        githubAuth: workspace.userProfile.github.account
          ? { observed: githubAuthObserved, detail: workspace.userProfile.github.account }
          : undefined,
      } : {},
      daemon: {},
      services: {
        declared: workspace.connectivity.servicePorts.length ? 1 : 0,
        observed: serviceCount,
        detail: `observed ${serviceCount} service objects`,
      },
    };
  }

  async executeReconcilePlan(workspace: WorkspaceSpec, plan: ReconcilePlan): Promise<void> {
    for (const action of plan.actions) {
      if (action.kind === "render") {
        renderAndWritePodWorkspace(workspace);
        continue;
      }
      if (action.kind === "apply") {
        const outputPath = renderAndWritePodWorkspace(workspace);
        runCommand("kubectl", ["apply", "-f", outputPath]);
        continue;
      }
      if (action.kind === "restart-runtime") {
        runCommand("kubectl", ["-n", workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName), "rollout", "restart", "deployment", workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName)]);
        continue;
      }
      if (action.kind === "repair-runtime-assembly" || action.kind === "clean-ephemeral-runtime") {
        runCommand("kubectl", ["-n", workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName), "rollout", "restart", "deployment", workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName)]);
        continue;
      }
      if (action.kind === "report-unrecoverable-drift") {
        throw new Error(action.reason || "pod backend cannot repair workspace drift");
      }
    }
  }
}
