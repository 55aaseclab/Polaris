import fs from "node:fs";
import { spawnSync } from "node:child_process";
import type { BackendDriver } from "../types.js";
import type { BackendObservation, ReconcilePlan, WorkspaceSpec } from "../../core/workspace.js";
import {
  dockerNetfsDevicePath,
  dockerNetfsServer,
  isNetfsSource,
  netfsMountOptions,
  netfsResolvedPath,
  workspaceDataDockerVolumeName,
} from "../../core/netfs.js";
import { workspaceRuntimeScopeName } from "../../core/workspace-name.js";
import { renderAndWriteDockerWorkspace } from "./render.js";
import { logInfo } from "../../utils/log.js";
import { runCommand } from "../../utils/shell.js";

function sanitizeDockerVolumeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function resolveDockerVolumeName(args: {
  fallbackName: string;
  source: WorkspaceSpec["attachments"]["workspaceData"]["source"];
}): string {
  const baseName = args.source.volumeRef?.trim() || args.fallbackName;
  const suffix = args.source.subPath?.trim()
    ? `-${args.source.subPath.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-")}`
    : "";
  return `${baseName}${suffix}`;
}

function ensureDockerWorkspaceDataVolumeConfig(workspace: WorkspaceSpec): void {
  const source = workspace.attachments.workspaceData.source;
  if (!isNetfsSource(source)) {
    return;
  }
  if (source.server?.trim() === "netfs.local") {
    const exportPath = netfsResolvedPath(source);
    fs.mkdirSync(exportPath, { recursive: true });
    logInfo("docker-driver", "workspace-netfs-export-ready", {
      project: workspace.identity.projectName,
      exportPath,
    });
  }
  const volumeName = workspaceDataDockerVolumeName(workspace);
  const expectedOptions = {
    device: dockerNetfsDevicePath(source),
    o: [`addr=${dockerNetfsServer(source)}`, ...netfsMountOptions(source)].join(","),
    type: "nfs",
  };
  const inspect = spawnSync("docker", ["volume", "inspect", volumeName], { encoding: "utf8" });
  if (inspect.status !== 0 || !inspect.stdout.trim()) {
    return;
  }
  try {
    const parsed = JSON.parse(inspect.stdout) as Array<{ Options?: Record<string, string> }>;
    const options = parsed[0]?.Options ?? {};
    const matches = options.device === expectedOptions.device
      && options.o === expectedOptions.o
      && options.type === expectedOptions.type;
    if (matches) {
      return;
    }
  } catch {
    // Fall through and recreate the volume with the rendered config.
  }
  const existingContainer = `${workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName)}-docker`;
  const removeVolume = (): void => {
    runCommand("docker", ["volume", "rm", "-f", volumeName]);
  };
  try {
    removeVolume();
  } catch (error) {
    const inspectContainer = spawnSync("docker", ["inspect", existingContainer], { encoding: "utf8" });
    if (inspectContainer.status === 0) {
      runCommand("docker", ["rm", "-f", existingContainer]);
      removeVolume();
      return;
    }
    throw error;
  }
}

function ensureDockerUserIdentityVolume(workspace: WorkspaceSpec): void {
  const userScope = sanitizeDockerVolumeToken(workspace.userProfile.id);
  const volumeName = resolveDockerVolumeName({
    fallbackName: `polaris-${userScope}-identity`,
    source: workspace.attachments.userIdentityState.source,
  });
  const inspect = spawnSync("docker", ["volume", "inspect", volumeName], {
    encoding: "utf8",
  });
  if (inspect.status === 0 && inspect.stdout.trim()) {
    return;
  }
  runCommand("docker", ["volume", "create", volumeName]);
  logInfo("docker-driver", "user-identity-volume-created", {
    userProfileId: workspace.userProfile.id,
    volumeName,
  });
}

function ensureDockerWorkspacePrerequisites(workspace: WorkspaceSpec): void {
  ensureDockerWorkspaceDataVolumeConfig(workspace);
  ensureDockerUserIdentityVolume(workspace);
}

function runDockerComposeTimed(
  workspace: WorkspaceSpec,
  outputPath: string,
  args: string[],
): void {
  const startedAt = Date.now();
  runCommand("docker", ["compose", "-f", outputPath, ...args]);
  logInfo("docker-driver", "compose-command-completed", {
    project: workspace.identity.projectName,
    userProfileId: workspace.userProfile.id,
    args,
    elapsedMs: Date.now() - startedAt,
  });
}

export class DockerDriver implements BackendDriver {
  readonly kind = "docker" as const;

  async create(workspace: WorkspaceSpec): Promise<void> {
    renderAndWriteDockerWorkspace(workspace);
  }

  async start(workspace: WorkspaceSpec): Promise<void> {
    ensureDockerWorkspacePrerequisites(workspace);
    const outputPath = renderAndWriteDockerWorkspace(workspace);
    runDockerComposeTimed(workspace, outputPath, ["up", "-d"]);
  }

  async stop(workspace: WorkspaceSpec): Promise<void> {
    const outputPath = renderAndWriteDockerWorkspace(workspace);
    runDockerComposeTimed(workspace, outputPath, ["stop"]);
  }

  async restart(workspace: WorkspaceSpec): Promise<void> {
    const outputPath = renderAndWriteDockerWorkspace(workspace);
    runDockerComposeTimed(workspace, outputPath, ["restart"]);
  }

  async rebuild(workspace: WorkspaceSpec): Promise<void> {
    ensureDockerWorkspacePrerequisites(workspace);
    const outputPath = renderAndWriteDockerWorkspace(workspace);
    runDockerComposeTimed(workspace, outputPath, ["up", "-d", "--force-recreate"]);
  }

  async render(workspace: WorkspaceSpec): Promise<void> {
    renderAndWriteDockerWorkspace(workspace);
  }

  async apply(workspace: WorkspaceSpec): Promise<void> {
    ensureDockerWorkspacePrerequisites(workspace);
    const outputPath = renderAndWriteDockerWorkspace(workspace);
    runDockerComposeTimed(workspace, outputPath, ["up", "-d"]);
  }

  async logs(workspace: WorkspaceSpec): Promise<void> {
    const outputPath = renderAndWriteDockerWorkspace(workspace);
    runCommand("docker", ["compose", "-f", outputPath, "logs", "--tail", "200", workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName)]);
  }

  async inspect(workspace: WorkspaceSpec): Promise<BackendObservation> {
    const outputPath = renderAndWriteDockerWorkspace(workspace);
    const containerId = spawnSync("docker", ["compose", "-f", outputPath, "ps", "-q", workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName)], { encoding: "utf8" });
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
    const execOutput = (command: string): string => {
      if (!exists) return "";
      const result = spawnSync("docker", ["exec", id, "sh", "-lc", command], { encoding: "utf8" });
      return result.status === 0 ? String(result.stdout || "") : "";
    };
    const githubAuthObserved =
      exists && running && workspace.userProfile.github.account
        ? execCheck(`output=$(ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5 -T git@github.com 2>&1 || true); printf '%s' "$output" | grep -q 'successfully authenticated'`)
        : false;

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
      } : {},
      runtimeAssembly: exists && running ? {
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
        ensureDockerWorkspacePrerequisites(workspace);
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
