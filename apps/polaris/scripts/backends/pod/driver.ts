import { spawnSync } from "node:child_process";
import type { BackendDriver } from "../types.js";
import type { BackendObservation, ReconcilePlan, WorkspaceSpec } from "../../core/workspace.js";
import {
  evaluateDaemonStatusObservation,
  evaluatePairingObservation,
  parseConnectionOfferServerId,
  parsePaseoDaemonStatus,
} from "../../core/paseo.js";
import { runCommand } from "../../utils/shell.js";
import { renderAndWritePodWorkspace } from "./render.js";

function extractPairingUrl(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { url?: unknown };
    return typeof parsed.url === "string" && parsed.url.trim() ? parsed.url.trim() : undefined;
  } catch {
    return undefined;
  }
}

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

  async logs(workspace: WorkspaceSpec): Promise<void> {
    const podNameResult = spawnSync(
      "kubectl",
      ["-n", workspace.identity.projectName, "get", "pod", "-l", `app=${workspace.identity.projectName}`, "-o", "jsonpath={.items[0].metadata.name}"],
      { encoding: "utf8" },
    );
    const podName = (podNameResult.stdout || "").trim();
    if (podName) {
      runCommand("kubectl", ["-n", workspace.identity.projectName, "logs", podName, "--tail=200"]);
      return;
    }
    runCommand("kubectl", ["-n", workspace.identity.projectName, "logs", "deployment/" + workspace.identity.projectName, "--tail=200"]);
  }

  async inspect(workspace: WorkspaceSpec): Promise<BackendObservation> {
    const deployment = spawnSync(
      "kubectl",
      ["-n", workspace.identity.projectName, "get", "deployment", workspace.identity.projectName, "-o", "json"],
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
      ["-n", workspace.identity.projectName, "get", "pod", "-l", `app=${workspace.identity.projectName}`, "-o", "jsonpath={.items[0].metadata.name}"],
      { encoding: "utf8" },
    );
    const podName = (podNameResult.stdout || "").trim();
    const running = Boolean(podName);

    const execCheck = (command: string): boolean => {
      if (!podName) return false;
      const result = spawnSync(
        "kubectl",
        ["-n", workspace.identity.projectName, "exec", podName, "--", "sh", "-lc", command],
        { encoding: "utf8" },
      );
      return result.status === 0;
    };
    const execOutput = (command: string): string => {
      if (!podName) return "";
      const result = spawnSync(
        "kubectl",
        ["-n", workspace.identity.projectName, "exec", podName, "--", "sh", "-lc", command],
        { encoding: "utf8" },
      );
      return result.status === 0 ? String(result.stdout || "") : "";
    };

    const observedServices = workspace.connectivity.servicePorts.length
      ? spawnSync(
          "kubectl",
          ["-n", workspace.identity.projectName, "get", "svc", workspace.identity.projectName, "-o", "jsonpath={.metadata.name}"],
          { encoding: "utf8" },
        )
      : { status: 0, stdout: "", stderr: "" };
    const serviceCount = (observedServices.stdout || "").trim() ? 1 : 0;

    const daemonStatusRaw =
      workspace.agent.enabled && podName
        ? execOutput(`timeout 5s env PASEO_HOME=${workspace.agent.runtime.stateRoot} paseo daemon status --json 2>/dev/null || true`)
        : "";
    const daemonStatus = parsePaseoDaemonStatus(daemonStatusRaw);
    const persistedServerId =
      workspace.agent.enabled && podName
        ? execOutput(`cat ${workspace.agent.runtime.stateRoot}/server-id 2>/dev/null`).trim() || null
        : null;
    const daemonObserved =
      workspace.agent.enabled &&
      podName
        ? evaluateDaemonStatusObservation({
            status: daemonStatus,
            persistedServerId,
            readyFileDetail: workspace.agent.runtime.readyFile ?? "/tmp/.ready",
          })
        : workspace.agent.enabled
          ? { observed: false, detail: workspace.agent.runtime.readyFile ?? "/tmp/.ready" }
          : { observed: true, detail: "daemon not required" };
    const githubAuthObserved =
      running && workspace.userProfile.github.account
        ? execCheck(`output=$(ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5 -T git@github.com 2>&1 || true); printf '%s' "$output" | grep -q 'successfully authenticated'`)
        : false;
    const pairingUrl =
      workspace.agent.enabled && podName
        ? extractPairingUrl(execOutput(`timeout 5s env PASEO_HOME=${workspace.agent.runtime.stateRoot} paseo daemon pair --json 2>/dev/null || true`))
        : undefined;
    const pairingServerId = pairingUrl ? parseConnectionOfferServerId(pairingUrl) ?? null : null;
    const pairingObserved = workspace.agent.enabled && podName
      ? evaluatePairingObservation({
          expectedServerId: daemonStatus?.serverId ?? persistedServerId,
          cachedServerId: pairingServerId,
          pairingUrl,
          pairingFileDetail: "paseo daemon pair",
        })
      : workspace.agent.enabled
        ? { observed: false, detail: "paseo daemon pair" }
        : { observed: true, detail: "daemon not required" };

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
        userSshState: { observed: execCheck(`test -d ${workspace.attachments.userSshState.mountRoot}`), detail: workspace.attachments.userSshState.mountRoot },
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
      daemon: {
        manager: workspace.health.requiresDaemon && running
          ? daemonObserved
          : workspace.health.requiresDaemon
            ? { observed: false, detail: workspace.agent.runtime.readyFile }
            : { observed: true, detail: "daemon not required" },
        pairing: workspace.health.requiresDaemon && running
          ? pairingObserved
          : workspace.health.requiresDaemon
            ? { observed: false, detail: "paseo daemon pair" }
            : { observed: true, detail: "daemon not required" },
      },
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
        runCommand("kubectl", ["-n", workspace.identity.projectName, "rollout", "restart", "deployment", workspace.identity.projectName]);
        continue;
      }
      if (action.kind === "repair-runtime-assembly" || action.kind === "clean-ephemeral-runtime") {
        runCommand("kubectl", ["-n", workspace.identity.projectName, "rollout", "restart", "deployment", workspace.identity.projectName]);
        continue;
      }
      if (action.kind === "report-unrecoverable-drift") {
        throw new Error(action.reason || "pod backend cannot repair workspace drift");
      }
    }
  }
}
