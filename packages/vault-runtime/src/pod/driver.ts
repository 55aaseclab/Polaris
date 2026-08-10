import { spawnSync } from "node:child_process";
import type {
  BackendDriver,
  BackendObservation,
  ReconcilePlan,
  RuntimeDriverDependencies,
  VaultRuntimeSpec,
} from "../types.js";
import { vaultRuntimeScopeName } from "../core/vault-name.js";
import { defaultRuntimeDriverDependencies } from "../runtime-deps.js";
import { renderPodVault } from "./render.js";

function privateSurfaceEnabled(vault: VaultRuntimeSpec): boolean {
  return Boolean(vault.integration.privateSurface);
}

export class PodDriver implements BackendDriver {
  readonly kind = "pod" as const;

  private readonly dependencies: RuntimeDriverDependencies;

  constructor(dependencies: RuntimeDriverDependencies = defaultRuntimeDriverDependencies()) {
    this.dependencies = dependencies;
  }

  async create(vault: VaultRuntimeSpec): Promise<void> {
    this.dependencies.writeManifest(vault, renderPodVault(vault));
  }

  async start(vault: VaultRuntimeSpec): Promise<void> {
    const outputPath = this.dependencies.writeManifest(vault, renderPodVault(vault));
    this.dependencies.runCommand("kubectl", ["apply", "-f", outputPath]);
  }

  async stop(vault: VaultRuntimeSpec): Promise<void> {
    const scope = vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName);
    this.dependencies.runCommand("kubectl", ["-n", scope, "scale", "deployment", scope, "--replicas=0"]);
  }

  async restart(vault: VaultRuntimeSpec): Promise<void> {
    const scope = vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName);
    this.dependencies.runCommand("kubectl", ["-n", scope, "rollout", "restart", "deployment", scope]);
  }

  async rebuild(vault: VaultRuntimeSpec): Promise<void> {
    const outputPath = this.dependencies.writeManifest(vault, renderPodVault(vault));
    this.dependencies.runCommand("kubectl", ["apply", "-f", outputPath]);
  }

  async render(vault: VaultRuntimeSpec): Promise<void> {
    this.dependencies.writeManifest(vault, renderPodVault(vault));
  }

  async apply(vault: VaultRuntimeSpec): Promise<void> {
    const outputPath = this.dependencies.writeManifest(vault, renderPodVault(vault));
    this.dependencies.runCommand("kubectl", ["apply", "-f", outputPath]);
  }

  async logs(vault: VaultRuntimeSpec): Promise<void> {
    const podNameResult = spawnSync(
      "kubectl",
      ["-n", vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName), "get", "pod", "-l", `app=${vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName)}`, "-o", "jsonpath={.items[0].metadata.name}"],
      { encoding: "utf8" },
    );
    const podName = (podNameResult.stdout || "").trim();
    if (podName) {
      this.dependencies.runCommand("kubectl", ["-n", vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName), "logs", podName, "--tail=200"]);
      return;
    }
    this.dependencies.runCommand("kubectl", ["-n", vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName), "logs", "deployment/" + vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName), "--tail=200"]);
  }

  async inspect(vault: VaultRuntimeSpec): Promise<BackendObservation> {
    const deployment = spawnSync(
      "kubectl",
      ["-n", vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName), "get", "deployment", vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName), "-o", "json"],
      { encoding: "utf8" },
    );
    if (deployment.status !== 0 || !deployment.stdout) {
      return {
        backend: {
          kind: vault.backend.kind,
          exists: false,
          running: false,
          detail: "deployment not found",
        },
        attachments: {},
        vaultAssembly: {},
        daemon: {},
        services: {
          declared: vault.connectivity.servicePorts.length,
          observed: 0,
          detail: "no services observed",
        },
      };
    }

    const podNameResult = spawnSync(
      "kubectl",
      ["-n", vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName), "get", "pod", "-l", `app=${vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName)}`, "-o", "jsonpath={.items[0].metadata.name}"],
      { encoding: "utf8" },
    );
    const podName = (podNameResult.stdout || "").trim();
    const readiness = privateSurfaceEnabled(vault) && podName
      ? spawnSync(
          "kubectl",
          [
            "-n",
            vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName),
            "get",
            "pod",
            podName,
            "-o",
            "jsonpath={.status.conditions[?(@.type==\"Ready\")].status}",
          ],
          { encoding: "utf8" },
        )
      : null;
    const surfaceReady = !privateSurfaceEnabled(vault)
      || (readiness?.status === 0 && String(readiness.stdout || "").trim() === "True");
    const running = Boolean(podName) && surfaceReady;

    const execCheck = (command: string): boolean => {
      if (!podName) return false;
      const result = spawnSync(
        "kubectl",
        ["-n", vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName), "exec", podName, "--", "sh", "-lc", command],
        { encoding: "utf8" },
      );
      return result.status === 0;
    };
    const execOutput = (command: string): string => {
      if (!podName) return "";
      const result = spawnSync(
        "kubectl",
        ["-n", vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName), "exec", podName, "--", "sh", "-lc", command],
        { encoding: "utf8" },
      );
      return result.status === 0 ? String(result.stdout || "") : "";
    };

    const observedServices = vault.connectivity.servicePorts.length
      ? spawnSync(
          "kubectl",
          ["-n", vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName), "get", "svc", vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName), "-o", "jsonpath={.metadata.name}"],
          { encoding: "utf8" },
        )
      : { status: 0, stdout: "", stderr: "" };
    const serviceCount = (observedServices.stdout || "").trim() ? 1 : 0;

    const githubAuthObserved =
      running && vault.userProfile.github.account
        ? execCheck(`output=$(ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5 -T git@github.com 2>&1 || true); printf '%s' "$output" | grep -q 'successfully authenticated'`)
        : false;

    return {
      backend: {
        kind: vault.backend.kind,
        exists: true,
        running,
        detail: podName ? `pod/${podName}` : "deployment exists but pod is not running",
      },
      attachments: running ? {
        vaultData: { observed: execCheck(`test -d ${vault.attachments.vaultData.mountRoot}`), detail: vault.attachments.vaultData.mountRoot },
        vaultRuntimeState: { observed: execCheck(`test -d ${vault.attachments.vaultRuntimeState.mountRoot}`), detail: vault.attachments.vaultRuntimeState.mountRoot },
        userIdentityState: { observed: execCheck(`test -d ${vault.attachments.userIdentityState.mountRoot}`), detail: vault.attachments.userIdentityState.mountRoot },
      } : {},
      vaultAssembly: running ? {
        home: { observed: execCheck(`test -d ${vault.runtime.home}`), detail: vault.runtime.home },
        projectRoot: { observed: execCheck(`test -L ${vault.runtime.home}/vault || test -L ${vault.runtime.home}/${vault.profile.vaultAlias ?? "vault"}`), detail: `${vault.runtime.home}/vault` },
        managerState: { observed: execCheck(`test -L ${vault.runtime.home}/.paseo`), detail: vault.agent.runtime.stateRoot },
        evolutionState: { observed: execCheck(`test -d ${vault.agent.runtime.evolutionRoot}`), detail: vault.agent.runtime.evolutionRoot },
        codex: { observed: execCheck(`test -L ${vault.runtime.home}/.codex`), detail: `${vault.runtime.home}/.codex` },
        claude: { observed: execCheck(`test -L ${vault.runtime.home}/.claude`), detail: `${vault.runtime.home}/.claude` },
        ssh: { observed: execCheck(`test -L ${vault.runtime.home}/.ssh || test -d ${vault.runtime.home}/.ssh`), detail: `${vault.runtime.home}/.ssh` },
        githubAuth: vault.userProfile.github.account
          ? { observed: githubAuthObserved, detail: vault.userProfile.github.account }
          : undefined,
      } : {},
      daemon: {},
      services: {
        declared: vault.connectivity.servicePorts.length ? 1 : 0,
        observed: serviceCount,
        detail: `observed ${serviceCount} service objects`,
      },
    };
  }

  async executeReconcilePlan(vault: VaultRuntimeSpec, plan: ReconcilePlan): Promise<void> {
    for (const action of plan.actions) {
      if (action.kind === "render") {
        this.dependencies.writeManifest(vault, renderPodVault(vault));
        continue;
      }
      if (action.kind === "apply") {
        const outputPath = this.dependencies.writeManifest(vault, renderPodVault(vault));
        this.dependencies.runCommand("kubectl", ["apply", "-f", outputPath]);
        continue;
      }
      if (action.kind === "restart-runtime") {
        this.dependencies.runCommand("kubectl", ["-n", vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName), "rollout", "restart", "deployment", vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName)]);
        continue;
      }
      if (action.kind === "repair-runtime-assembly" || action.kind === "clean-ephemeral-runtime") {
        this.dependencies.runCommand("kubectl", ["-n", vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName), "rollout", "restart", "deployment", vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName)]);
        continue;
      }
      if (action.kind === "report-unrecoverable-drift") {
        throw new Error(action.reason || "pod backend cannot repair vault drift");
      }
    }
  }
}
