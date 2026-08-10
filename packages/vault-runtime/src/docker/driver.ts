import fs from "node:fs";
import { spawnSync } from "node:child_process";
import type {
  BackendDriver,
  BackendObservation,
  ReconcilePlan,
  RuntimeDriverDependencies,
  VaultRuntimeSpec,
} from "../types.js";
import {
  dockerNetfsDevicePath,
  dockerNetfsServer,
  isNetfsSource,
  netfsMountOptions,
  netfsResolvedPath,
  vaultDataDockerVolumeName,
} from "../core/netfs.js";
import { vaultRuntimeScopeName } from "../core/vault-name.js";
import { defaultRuntimeDriverDependencies } from "../runtime-deps.js";
import { renderDockerVault } from "./render.js";

function sanitizeDockerVolumeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function resolveDockerVolumeName(args: {
  fallbackName: string;
  source: VaultRuntimeSpec["attachments"]["vaultData"]["source"];
}): string {
  const baseName = args.source.volumeRef?.trim() || args.fallbackName;
  const suffix = args.source.subPath?.trim()
    ? `-${args.source.subPath.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-")}`
    : "";
  return `${baseName}${suffix}`;
}

function ensureDockerVaultDataVolumeConfig(
  vault: VaultRuntimeSpec,
  dependencies: RuntimeDriverDependencies,
): void {
  const source = vault.attachments.vaultData.source;
  if (!isNetfsSource(source)) {
    return;
  }
  if (source.server?.trim() === "netfs.local") {
    const exportPath = netfsResolvedPath(source);
    fs.mkdirSync(exportPath, { recursive: true });
    dependencies.logInfo("docker-driver", "vault-netfs-export-ready", {
      project: vault.identity.projectName,
      exportPath,
    });
  }
  const volumeName = vaultDataDockerVolumeName(vault);
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
  const existingContainer = `${vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName)}-docker`;
  const removeVolume = (): void => {
    dependencies.runCommand("docker", ["volume", "rm", "-f", volumeName]);
  };
  try {
    removeVolume();
  } catch (error) {
    const inspectContainer = spawnSync("docker", ["inspect", existingContainer], { encoding: "utf8" });
    if (inspectContainer.status === 0) {
      dependencies.runCommand("docker", ["rm", "-f", existingContainer]);
      removeVolume();
      return;
    }
    throw error;
  }
}

function ensureDockerUserIdentityVolume(
  vault: VaultRuntimeSpec,
  dependencies: RuntimeDriverDependencies,
): void {
  const userScope = sanitizeDockerVolumeToken(vault.userProfile.id);
  const volumeName = resolveDockerVolumeName({
    fallbackName: `polaris-${userScope}-identity`,
    source: vault.attachments.userIdentityState.source,
  });
  const inspect = spawnSync("docker", ["volume", "inspect", volumeName], {
    encoding: "utf8",
  });
  if (inspect.status === 0 && inspect.stdout.trim()) {
    return;
  }
  dependencies.runCommand("docker", ["volume", "create", volumeName]);
  dependencies.logInfo("docker-driver", "user-identity-volume-created", {
    userProfileId: vault.userProfile.id,
    volumeName,
  });
}

function ensureDockerVaultPrerequisites(
  vault: VaultRuntimeSpec,
  dependencies: RuntimeDriverDependencies,
): void {
  ensureDockerVaultDataVolumeConfig(vault, dependencies);
  ensureDockerUserIdentityVolume(vault, dependencies);
}

function vaultEnablesPrivateSurface(vault: VaultRuntimeSpec): boolean {
  return Boolean(vault.integration.privateSurface);
}

function runDockerComposeTimed(
  vault: VaultRuntimeSpec,
  outputPath: string,
  args: string[],
  dependencies: RuntimeDriverDependencies,
): void {
  const startedAt = Date.now();
  dependencies.runCommand("docker", ["compose", "-f", outputPath, ...args]);
  dependencies.logInfo("docker-driver", "compose-command-completed", {
    project: vault.identity.projectName,
    userProfileId: vault.userProfile.id,
    args,
    elapsedMs: Date.now() - startedAt,
  });
}

export class DockerDriver implements BackendDriver {
  readonly kind = "docker" as const;

  private readonly dependencies: RuntimeDriverDependencies;

  constructor(dependencies: RuntimeDriverDependencies = defaultRuntimeDriverDependencies()) {
    this.dependencies = dependencies;
  }

  async create(vault: VaultRuntimeSpec): Promise<void> {
    this.dependencies.writeManifest(vault, renderDockerVault(vault));
  }

  async start(vault: VaultRuntimeSpec): Promise<void> {
    await this.dependencies.withDockerCapacity(vault, async () => {
      ensureDockerVaultPrerequisites(vault, this.dependencies);
      const outputPath = this.dependencies.writeManifest(vault, renderDockerVault(vault));
      runDockerComposeTimed(vault, outputPath, ["up", "-d"], this.dependencies);
    });
  }

  async stop(vault: VaultRuntimeSpec): Promise<void> {
    const outputPath = this.dependencies.writeManifest(vault, renderDockerVault(vault));
    runDockerComposeTimed(vault, outputPath, ["stop"], this.dependencies);
  }

  async restart(vault: VaultRuntimeSpec): Promise<void> {
    const outputPath = this.dependencies.writeManifest(vault, renderDockerVault(vault));
    runDockerComposeTimed(vault, outputPath, ["restart"], this.dependencies);
  }

  async rebuild(vault: VaultRuntimeSpec): Promise<void> {
    await this.dependencies.withDockerCapacity(vault, async () => {
      ensureDockerVaultPrerequisites(vault, this.dependencies);
      const outputPath = this.dependencies.writeManifest(vault, renderDockerVault(vault));
      runDockerComposeTimed(vault, outputPath, ["up", "-d", "--force-recreate"], this.dependencies);
    });
  }

  async render(vault: VaultRuntimeSpec): Promise<void> {
    this.dependencies.writeManifest(vault, renderDockerVault(vault));
  }

  async apply(vault: VaultRuntimeSpec): Promise<void> {
    await this.dependencies.withDockerCapacity(vault, async () => {
      ensureDockerVaultPrerequisites(vault, this.dependencies);
      const outputPath = this.dependencies.writeManifest(vault, renderDockerVault(vault));
      runDockerComposeTimed(vault, outputPath, ["up", "-d"], this.dependencies);
    });
  }

  async logs(vault: VaultRuntimeSpec): Promise<void> {
    const outputPath = this.dependencies.writeManifest(vault, renderDockerVault(vault));
    this.dependencies.runCommand("docker", ["compose", "-f", outputPath, "logs", "--tail", "200", vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName)]);
  }

  async inspect(vault: VaultRuntimeSpec): Promise<BackendObservation> {
    const outputPath = this.dependencies.writeManifest(vault, renderDockerVault(vault));
    const containerId = spawnSync("docker", ["compose", "-f", outputPath, "ps", "-q", vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName)], { encoding: "utf8" });
    const id = (containerId.stdout || "").trim();
    const exists = Boolean(id);
    const inspect = exists
      ? spawnSync("docker", ["inspect", id], { encoding: "utf8" })
      : { status: 1, stdout: "", stderr: "" };
    const processRunning = exists && /"Running":\s*true/.test(inspect.stdout || "");
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
    const privateSurface = vault.integration.privateSurface;
    const surfaceReady = !privateSurface
      || (processRunning && execCheck(`curl -fsS http://127.0.0.1:${privateSurface.port.containerPort}${privateSurface.readyPath} >/dev/null`));
    const running = processRunning && surfaceReady;
    const githubAuthObserved =
      vault.agent.enabled && exists && running && vault.userProfile.github.account
        ? execCheck(`output=$(ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5 -T git@github.com 2>&1 || true); printf '%s' "$output" | grep -q 'successfully authenticated'`)
        : false;

    return {
      backend: {
        kind: vault.backend.kind,
        exists,
        running,
        detail: exists ? id : "docker container missing",
      },
      attachments: exists && running ? {
        vaultData: { observed: execCheck(`test -d ${vault.attachments.vaultData.mountRoot}`), detail: vault.attachments.vaultData.mountRoot },
        vaultRuntimeState: { observed: execCheck(`test -d ${vault.attachments.vaultRuntimeState.mountRoot}`), detail: vault.attachments.vaultRuntimeState.mountRoot },
        userIdentityState: { observed: execCheck(`test -d ${vault.attachments.userIdentityState.mountRoot}`), detail: vault.attachments.userIdentityState.mountRoot },
      } : {},
      vaultAssembly: exists && running ? {
        home: { observed: execCheck(`test -d ${vault.runtime.home}`), detail: vault.runtime.home },
        projectRoot: { observed: execCheck(`test -L ${vault.runtime.home}/vault || test -L ${vault.runtime.home}/${vault.profile.vaultAlias ?? "vault"}`), detail: `${vault.runtime.home}/vault` },
        ...(vault.agent.enabled
          ? {
              managerState: { observed: execCheck(`test -L ${vault.runtime.home}/.paseo`), detail: vault.agent.runtime.stateRoot },
              evolutionState: { observed: execCheck(`test -d ${vault.agent.runtime.evolutionRoot}`), detail: vault.agent.runtime.evolutionRoot },
              ssh: { observed: execCheck(`test -L ${vault.runtime.home}/.ssh || test -d ${vault.runtime.home}/.ssh`), detail: `${vault.runtime.home}/.ssh` },
            }
          : {}),
        codex: { observed: execCheck(`test -L ${vault.runtime.home}/.codex`), detail: `${vault.runtime.home}/.codex` },
        claude: { observed: execCheck(`test -L ${vault.runtime.home}/.claude`), detail: `${vault.runtime.home}/.claude` },
        githubAuth: vault.agent.enabled && vault.userProfile.github.account
          ? { observed: githubAuthObserved, detail: vault.userProfile.github.account }
          : undefined,
      } : {},
      daemon: {},
      services: {
        declared: vault.connectivity.servicePorts.length ? 1 : 0,
        observed: vault.connectivity.servicePorts.length ? (exists ? 1 : 0) : 0,
        detail: exists ? "docker compose service is present" : "docker compose service is missing",
      },
    };
  }

  async executeReconcilePlan(vault: VaultRuntimeSpec, plan: ReconcilePlan): Promise<void> {
    const outputPath = this.dependencies.writeManifest(vault, renderDockerVault(vault));
    for (const action of plan.actions) {
      if (action.kind === "render") {
        this.dependencies.writeManifest(vault, renderDockerVault(vault));
        continue;
      }
      if (action.kind === "apply") {
        await this.apply(vault);
        continue;
      }
      if (action.kind === "restart-runtime") {
        this.dependencies.runCommand("docker", ["compose", "-f", outputPath, "restart"]);
        continue;
      }
      if (action.kind === "repair-runtime-assembly" || action.kind === "clean-ephemeral-runtime") {
        this.dependencies.runCommand("docker", ["compose", "-f", outputPath, "restart"]);
        continue;
      }
      if (action.kind === "report-unrecoverable-drift") {
        throw new Error(action.reason || "docker backend cannot repair vault drift");
      }
    }
  }
}
