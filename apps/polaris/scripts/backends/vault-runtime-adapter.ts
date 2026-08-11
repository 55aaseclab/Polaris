import fs from "node:fs";
import path from "node:path";
import {
  createBackendDriver,
  kubevirtProbePassword as runtimeKubevirtProbePassword,
  readKubevirtPersistedPaseoState as readRuntimeKubevirtPersistedPaseoState,
  renderDockerVault as renderRuntimeDockerVault,
  renderKubevirtVault as renderRuntimeKubevirtVault,
  renderPodVault as renderRuntimePodVault,
  vaultHarnessIds,
  vaultNonPaseoToolPackageSpecs,
  vaultPaseoPackageSpec,
  vaultToolCatalog,
  vaultToolPackageSpecs,
  VAULT_DATA_PRIMARY_RUNTIME_ROOT,
  VAULT_DATA_RUNTIME_LAYOUT,
  VAULT_DATA_RUNTIME_ROOTS,
  type BackendDriver as RuntimeBackendDriver,
  type BackendKind as RuntimeBackendKind,
  type HarnessToolDefinition,
  type RuntimeDriverDependencies,
  type VaultRuntimeSpec,
} from "@polaris/vault-runtime";
import type {
  BackendObservation,
  ReconcilePlan,
  VaultSpec,
} from "../core/vault.js";
import type { BackendDriver } from "./types.js";
import { resolveConfiguredPaseoAppBaseUrl } from "../core/pairing-url.js";
import { writeGeneratedManifest } from "../output/write-generated.js";
import { withDockerActiveVaultCapacity } from "../control-plane/capacity.js";
import {
  deriveWanghaiVaultAssertionSecret,
  requireWanghaiGatewayMasterSecret,
} from "../security/wanghai-assertions.js";
import {
  filterIntegratedWanghaiPlainEnvVars,
  isWanghaiProfileEnvFile,
  sanitizeIntegratedWanghaiAuthFiles,
} from "../security/wanghai-runtime-env.js";
import { configuredWanghaiFrameAncestors } from "../portal/wanghai-gateway.js";
import { logInfo } from "../utils/log.js";
import { runCommand } from "../utils/shell.js";
import { resolveRepoRoot } from "../utils/repo-root.js";

// This is the only Polaris production module allowed to import the reusable
// vault-runtime package. Backend-specific wrappers and control-plane callers
// must use the VaultSpec-facing functions exported below.
export type { HarnessToolDefinition };
export {
  vaultHarnessIds,
  vaultNonPaseoToolPackageSpecs,
  vaultPaseoPackageSpec,
  vaultToolCatalog,
  vaultToolPackageSpecs,
  VAULT_DATA_PRIMARY_RUNTIME_ROOT,
  VAULT_DATA_RUNTIME_LAYOUT,
  VAULT_DATA_RUNTIME_ROOTS,
};

const WANGHAI_RESOURCE_LIMITS = {
  cpuRequest: "100m",
  memoryRequest: "128Mi",
  ephemeralStorageRequest: "128Mi",
  cpuLimit: "500m",
  memoryLimit: "512Mi",
  ephemeralStorageLimit: "512Mi",
  pidLimit: 128,
} as const;

function isWanghaiServicePort(
  port: VaultSpec["connectivity"]["servicePorts"][number],
): boolean {
  return port.name?.trim().toLowerCase() === "wanghai"
    || String(port.containerPort) === "9090";
}

function wanghaiPort(vault: VaultSpec): VaultSpec["connectivity"]["servicePorts"][number] | undefined {
  return vault.connectivity.servicePorts.find(isWanghaiServicePort);
}

function runtimeObserverScript(vault: VaultSpec): string | undefined {
  if (!vault.agent.enabled) {
    return undefined;
  }
  const observerPath = path.join(
    resolveRepoRoot(import.meta.url),
    "apps",
    "polaris",
    "scripts",
    "evolution",
    "runtime-memory-observer.mjs",
  );
  return fs.readFileSync(observerPath, "utf8");
}

function kubevirtTemplatePaths(): VaultRuntimeSpec["integration"]["kubevirtTemplates"] {
  const root = resolveRepoRoot(import.meta.url);
  return {
    generatedDir: path.join(root, "config", "generated", "kubevirt"),
    fallbackDir: path.join(root, "config", "kubevirt", "templates"),
  };
}

function privateSurface(
  vault: VaultSpec,
  requirePrivateSurfaceSecret: boolean,
): VaultRuntimeSpec["integration"]["privateSurface"] {
  const port = wanghaiPort(vault);
  if (!port) {
    return undefined;
  }

  const sanitizedAuthFiles = sanitizeIntegratedWanghaiAuthFiles(vault.runtime.authFiles);
  const envFile = sanitizedAuthFiles.find(isWanghaiProfileEnvFile);
  const assertionSecret = requirePrivateSurfaceSecret
    ? deriveWanghaiVaultAssertionSecret(
        requireWanghaiGatewayMasterSecret(),
        vault.userProfile.id,
        vault.identity.projectName,
      )
    : undefined;
  const frameAncestors = requirePrivateSurfaceSecret
    ? configuredWanghaiFrameAncestors()
    : undefined;
  const command = [
    'if [ ! -x /usr/local/bin/wanghai-entrypoint ] || [ ! -d /opt/wanghai/apps/admin-portal ]; then echo "Wanghai portal runtime is missing" >&2; exit 1; fi',
    "mkdir -p /tmp/wanghai-home",
    "printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'if [ \"$$1\" = \"--dir\" ] && [ \"$$2\" = \"apps/admin-portal\" ] && [ \"$$3\" = \"exec\" ] && [ \"$$4\" = \"env\" ] && [ \"$$5\" = \"NODE_OPTIONS=--max-old-space-size=256\" ] && [ \"$$6\" = \"node\" ]; then shift 6; cd /opt/wanghai; exec env NODE_OPTIONS=--max-old-space-size=256 node \"$$@\"; fi' 'exec /vault/state/tooling/polaris/bin/pnpm \"$$@\"' > /tmp/polaris-pnpm",
    "chmod 755 /tmp/polaris-pnpm",
    `exec env WANGHAI_SUPERVISE_PORTAL=1 NODE_OPTIONS=--max-old-space-size=64 PATH=/tmp:/vault/state/tooling/polaris/bin:$$PATH /usr/local/bin/wanghai-entrypoint pnpm --dir apps/admin-portal exec env NODE_OPTIONS=--max-old-space-size=256 node node_modules/next/dist/bin/next start --hostname 0.0.0.0 --port ${port.containerPort}`,
  ].join(" && ");

  return {
    id: "wanghai",
    command,
    image: vault.runtime.baseImage,
    port: { ...port },
    readyPath: "/wanghai/readyz",
    healthPath: "/wanghai/healthz",
    env: [
      { name: "WANGHAI_REPO_ROOT", value: "/opt/wanghai" },
      { name: "WANGHAI_RUNTIME_MODE", value: "polaris" },
      { name: "POLARIS_VAULT_WORKSPACES_ROOT", value: VAULT_DATA_RUNTIME_ROOTS[0] },
      { name: "POLARIS_VAULT_BACKUPS_ROOT", value: VAULT_DATA_RUNTIME_ROOTS[1] },
      { name: "POLARIS_VAULT_CACHE_ROOT", value: VAULT_DATA_RUNTIME_ROOTS[2] },
      { name: "WANGHAI_GATEWAY_TENANT_ID", value: vault.userProfile.id },
      { name: "WANGHAI_GATEWAY_VAULT_ID", value: vault.identity.projectName },
      ...(frameAncestors
        ? [{ name: "WANGHAI_GATEWAY_FRAME_ANCESTORS", value: frameAncestors }]
        : []),
      { name: "WANGHAI_SUPERVISE_PORTAL", value: "1" },
      { name: "HOME", value: "/tmp/wanghai-home" },
      { name: "TMPDIR", value: "/tmp" },
      { name: "NEXT_TELEMETRY_DISABLED", value: "1" },
    ],
    ...(envFile
      ? {
          envFile: {
            key: envFile.key,
            mountPath: envFile.mountPath,
            content: envFile.content,
            sourcePath: envFile.sourcePath,
          },
        }
      : {}),
    ...(assertionSecret
      ? {
          secretEnv: {
            name: "WANGHAI_GATEWAY_ASSERTION_SECRET",
            value: assertionSecret,
            resourceSuffix: "wanghai-gateway",
            key: "assertion-secret",
          },
        }
      : {}),
    resources: WANGHAI_RESOURCE_LIMITS,
    networkPolicy: {
      dns: true,
      web: true,
    },
  };
}

/**
 * Project the control-plane VaultSpec into the small contract consumed by the
 * standalone runtime package. Polaris-owned identity and policy fields are
 * deliberately omitted here.
 */
export interface VaultRuntimeProjectionOptions {
  /** Lifecycle/read operations may inspect a surface without rendering its secret. */
  requirePrivateSurfaceSecret?: boolean;
}

export function toVaultRuntimeSpec(
  vault: VaultSpec,
  options: VaultRuntimeProjectionOptions = {},
): VaultRuntimeSpec {
  const requirePrivateSurfaceSecret = options.requirePrivateSurfaceSecret ?? true;
  const hasPrivateSurface = Boolean(wanghaiPort(vault));
  const runtimeAuthFiles = hasPrivateSurface
    ? sanitizeIntegratedWanghaiAuthFiles(vault.runtime.authFiles)
    : vault.runtime.authFiles.map((file) => ({ ...file }));
  const plainEnvVars = hasPrivateSurface
    ? filterIntegratedWanghaiPlainEnvVars(vault.runtime.plainEnvVars)
    : vault.runtime.plainEnvVars.map((item) => ({ ...item }));

  const runtimeSpec: VaultRuntimeSpec = {
    identity: {
      projectName: vault.identity.projectName,
    },
    userProfile: {
      id: vault.userProfile.id,
      name: vault.userProfile.name,
      email: vault.userProfile.email,
      github: { ...vault.userProfile.github },
      ssh: { mode: vault.userProfile.ssh.mode },
    },
    profile: {
      name: vault.profile.name,
      assetBaseName: vault.profile.assetBaseName,
      vaultAlias: vault.profile.vaultAlias,
    },
    backend: {
      kind: vault.backend.kind,
      profile: vault.backend.profile,
      dockerRuntimeMode: vault.backend.dockerRuntimeMode,
    },
    storage: {
      persistState: vault.storage.persistState,
      claimName: vault.storage.claimName,
    },
    attachments: {
      vaultData: {
        ...vault.attachments.vaultData,
        durablePaths: [...vault.attachments.vaultData.durablePaths],
        source: { ...vault.attachments.vaultData.source },
      },
      vaultRuntimeState: {
        ...vault.attachments.vaultRuntimeState,
        durablePaths: [...vault.attachments.vaultRuntimeState.durablePaths],
        source: { ...vault.attachments.vaultRuntimeState.source },
      },
      userIdentityState: {
        ...vault.attachments.userIdentityState,
        durablePaths: [...vault.attachments.userIdentityState.durablePaths],
        source: { ...vault.attachments.userIdentityState.source },
      },
      ephemeralRuntime: {
        ...vault.attachments.ephemeralRuntime,
        paths: [...vault.attachments.ephemeralRuntime.paths],
        staleArtifacts: [...vault.attachments.ephemeralRuntime.staleArtifacts],
      },
    },
    resources: {
      ...vault.resources,
    },
    runtime: {
      ...vault.runtime,
      plainEnvVars,
      authFiles: runtimeAuthFiles,
      aptPackages: [...vault.runtime.aptPackages],
      agentArgs: [...vault.runtime.agentArgs],
    },
    tooling: {
      nonPaseoPackageSpecs: vaultNonPaseoToolPackageSpecs(),
      paseoPackageSpec: vaultPaseoPackageSpec(),
      binaries: vaultToolCatalog().map((tool) => tool.binName),
    },
    agent: {
      enabled: vault.agent.enabled,
      managerId: vault.agent.managerId,
      capabilities: {
        requiresDaemon: vault.agent.capabilities.requiresDaemon,
      },
      runtime: {
        ...vault.agent.runtime,
        staleRuntimeArtifacts: [...vault.agent.runtime.staleRuntimeArtifacts],
      },
    },
    connectivity: {
      ...vault.connectivity,
      servicePorts: vault.connectivity.servicePorts.map((port) => ({ ...port })),
    },
    health: {
      ...vault.health,
    },
    integration: {
      paseoAppBaseUrl: resolveConfiguredPaseoAppBaseUrl() ?? undefined,
      runtimeObserverScript: runtimeObserverScript(vault),
      kubevirtProbePassword: "",
      kubevirtTemplates: kubevirtTemplatePaths(),
      privateSurface: privateSurface(vault, requirePrivateSurfaceSecret),
    },
    evolution: vault.evolution
      ? {
          vaultMemoryFile: vault.evolution.vaultMemoryFile,
          vaultMemoryContent: vault.evolution.vaultMemoryContent,
          userMemoryFile: vault.evolution.userMemoryFile,
          userMemoryContent: vault.evolution.userMemoryContent,
          sessionSnapshotFile: vault.evolution.sessionSnapshotFile,
          sessionSnapshotContent: vault.evolution.sessionSnapshotContent,
        }
      : undefined,
  };
  runtimeSpec.integration.kubevirtProbePassword = runtimeKubevirtProbePassword(runtimeSpec);
  return runtimeSpec;
}

export function renderDockerVault(vault: VaultSpec): string {
  return renderRuntimeDockerVault(toVaultRuntimeSpec(vault));
}

export function renderPodVault(vault: VaultSpec): string {
  return renderRuntimePodVault(toVaultRuntimeSpec(vault));
}

export function renderKubevirtVault(vault: VaultSpec): string {
  return renderRuntimeKubevirtVault(toVaultRuntimeSpec(vault));
}

export function kubevirtProbePassword(vault: VaultSpec): string {
  return runtimeKubevirtProbePassword(
    toVaultRuntimeSpec(vault, { requirePrivateSurfaceSecret: false }),
  );
}

export async function readKubevirtPersistedPaseoState(vault: VaultSpec): Promise<{
  serverId: string;
  pairing: Record<string, unknown> & { url: string };
} | null> {
  return readRuntimeKubevirtPersistedPaseoState(
    toVaultRuntimeSpec(vault, { requirePrivateSurfaceSecret: false }),
  );
}

function runtimeDependencies(vault: VaultSpec): RuntimeDriverDependencies {
  return {
    writeManifest: (_spec, yamlText) => writeGeneratedManifest(vault, yamlText),
    runCommand,
    logInfo,
    withDockerCapacity: (_spec, operation) => {
      if (vault.backend.kind !== "docker") {
        return operation();
      }
      return withDockerActiveVaultCapacity(
        import.meta.url,
        {
          userId: vault.userProfile.id,
          vault: vault.identity.projectName,
        },
        operation,
      );
    },
  };
}

export function runtimeDriverFor(vault: VaultSpec): RuntimeBackendDriver {
  return createBackendDriver(
    vault.backend.kind as RuntimeBackendKind,
    runtimeDependencies(vault),
  );
}

export class PolarisBackendDriver implements BackendDriver {
  readonly kind: VaultSpec["backend"]["kind"];

  constructor(kind: VaultSpec["backend"]["kind"]) {
    this.kind = kind;
  }

  private runtime(
    vault: VaultSpec,
    options: VaultRuntimeProjectionOptions = {},
  ): {
    spec: VaultRuntimeSpec;
    driver: RuntimeBackendDriver;
  } {
    if (vault.backend.kind !== this.kind) {
      throw new Error(
        `Backend driver '${this.kind}' cannot execute vault backend '${vault.backend.kind}'`,
      );
    }
    const spec = toVaultRuntimeSpec(vault, options);
    return {
      spec,
      driver: runtimeDriverFor(vault),
    };
  }

  async create(vault: VaultSpec): Promise<void> {
    const runtime = this.runtime(vault);
    await runtime.driver.create(runtime.spec);
  }

  async start(vault: VaultSpec): Promise<void> {
    const runtime = this.runtime(vault);
    await runtime.driver.start(runtime.spec);
  }

  async stop(vault: VaultSpec): Promise<void> {
    const runtime = this.runtime(vault, { requirePrivateSurfaceSecret: false });
    await runtime.driver.stop(runtime.spec);
  }

  async restart(vault: VaultSpec): Promise<void> {
    const runtime = this.runtime(vault, { requirePrivateSurfaceSecret: false });
    await runtime.driver.restart(runtime.spec);
  }

  async rebuild(vault: VaultSpec): Promise<void> {
    const runtime = this.runtime(vault);
    await runtime.driver.rebuild(runtime.spec);
  }

  async render(vault: VaultSpec): Promise<void> {
    const runtime = this.runtime(vault);
    await runtime.driver.render(runtime.spec);
  }

  async apply(vault: VaultSpec): Promise<void> {
    const runtime = this.runtime(vault);
    await runtime.driver.apply(runtime.spec);
  }

  async logs(vault: VaultSpec): Promise<void> {
    const runtime = this.runtime(vault, { requirePrivateSurfaceSecret: false });
    await runtime.driver.logs(runtime.spec);
  }

  async inspect(vault: VaultSpec): Promise<BackendObservation> {
    const runtime = this.runtime(vault, { requirePrivateSurfaceSecret: false });
    return (await runtime.driver.inspect(runtime.spec)) as BackendObservation;
  }

  async executeReconcilePlan(vault: VaultSpec, plan: ReconcilePlan): Promise<void> {
    const runtime = this.runtime(vault, {
      requirePrivateSurfaceSecret: vault.backend.kind === "docker"
        || plan.actions.some((action) => action.kind === "render" || action.kind === "apply"),
    });
    await runtime.driver.executeReconcilePlan(runtime.spec, plan);
  }
}

export function getPolarisBackendDriver(kind: string): BackendDriver {
  if (kind !== "docker" && kind !== "pod" && kind !== "kubevirt-vm") {
    throw new Error(`Vault backend '${kind}' is not supported`);
  }
  return new PolarisBackendDriver(kind);
}
