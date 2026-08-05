import fs from "node:fs";
import path from "node:path";
import type { VaultSpec } from "../../core/vault.js";
import {
  dockerNetfsDevicePath,
  dockerNetfsServer,
  isNetfsSource,
  netfsMountOptions,
  netfsResolvedPath,
  requireNetfsField,
  vaultDataDockerVolumeName,
} from "../../core/netfs.js";
import {
  vaultNonPaseoToolPackageSpecs,
  vaultPaseoPackageSpec,
  vaultToolCatalog,
} from "../../core/harness-catalog.js";
import {
  stateStoragePathForMountPath,
  userIdentityBootstrapDirs,
} from "../../core/identity-layout.js";
import { vaultRuntimeScopeName } from "../../core/vault-name.js";
import { resolveConfiguredPaseoAppBaseUrl } from "../../core/pairing-url.js";
import { writeGeneratedManifest } from "../../output/write-generated.js";
import { resolveRepoRoot } from "../../utils/repo-root.js";
import {
  deriveWanghaiVaultAssertionSecret,
  requireWanghaiGatewayMasterSecret,
} from "../../security/wanghai-assertions.js";
import {
  filterIntegratedWanghaiPlainEnvVars,
  sanitizeIntegratedWanghaiAuthFiles,
} from "../../security/wanghai-runtime-env.js";
import { configuredWanghaiFrameAncestors } from "../../portal/wanghai-gateway.js";

function q(value: string): string {
  return JSON.stringify(value);
}

const DOCKER_VAULT_PID_LIMIT = 128;
const DOCKER_RUNTIME_TMPFS_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_DOCKER_VAULT_RESOURCES = {
  cpu: "1",
  memory: "512Mi",
  ephemeralStorage: "512Mi",
} as const;
const BYTE_UNITS = [
  { suffix: "e", bytes: 1024 ** 6 },
  { suffix: "p", bytes: 1024 ** 5 },
  { suffix: "t", bytes: 1024 ** 4 },
  { suffix: "g", bytes: 1024 ** 3 },
  { suffix: "m", bytes: 1024 ** 2 },
  { suffix: "k", bytes: 1024 },
] as const;

function quantityNumber(value: string, label: string): { amount: number; suffix: string } {
  const raw = value.trim();
  const match = raw.match(/^(\d+(?:\.\d*)?|\.\d+)([A-Za-z]*)$/u);
  if (!match) {
    throw new Error(`Docker resource ${label} has an invalid quantity '${value}'`);
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Docker resource ${label} must be positive`);
  }
  return { amount, suffix: match[2] };
}

function dockerCpuQuantity(value: string, label: string): string {
  const { amount, suffix } = quantityNumber(value, label);
  const multiplier = suffix === "" ? 1 : suffix === "m" ? 1e-3 : suffix === "u" ? 1e-6 : suffix === "n" ? 1e-9 : null;
  if (multiplier === null) {
    throw new Error(`Docker resource ${label} has an unsupported CPU suffix '${suffix}'`);
  }
  const cores = amount * multiplier;
  if (!Number.isFinite(cores) || cores <= 0) {
    throw new Error(`Docker resource ${label} must be positive`);
  }
  const normalized = cores.toFixed(9).replace(/0+$/u, "").replace(/\.$/u, "");
  return normalized || "0.000000001";
}

function quantityBytes(value: string, label: string): number {
  const { amount, suffix } = quantityNumber(value, label);
  const multipliers: Record<string, number> = {
    "": 1,
    b: 1,
    k: 1_000,
    M: 1_000_000,
    G: 1_000_000_000,
    T: 1_000_000_000_000,
    P: 1_000_000_000_000_000,
    E: 1_000_000_000_000_000_000,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
  };
  const multiplier = multipliers[suffix];
  if (multiplier === undefined) {
    throw new Error(`Docker resource ${label} has an unsupported size suffix '${suffix}'`);
  }
  const bytes = amount * multiplier;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`Docker resource ${label} must resolve to a positive whole byte count`);
  }
  return bytes;
}

function dockerByteQuantity(bytes: number): string {
  for (const unit of BYTE_UNITS) {
    if (bytes % unit.bytes === 0) {
      return `${bytes / unit.bytes}${unit.suffix}`;
    }
  }
  return `${bytes}b`;
}

function dockerVaultResourceLimits(vault: VaultSpec): {
  cpu: string;
  memory: string;
  ephemeralStorage: string;
  runtimeTmpfs: string;
  pidLimit: number;
} {
  const resources = vault.resources.unbounded
    ? DEFAULT_DOCKER_VAULT_RESOURCES
    : vault.resources;
  const memoryBytes = quantityBytes(resources.memory, "memory");
  const ephemeralStorageBytes = quantityBytes(
    resources.ephemeralStorage,
    "ephemeral storage",
  );
  return {
    cpu: dockerCpuQuantity(resources.cpu, "CPU"),
    memory: dockerByteQuantity(memoryBytes),
    ephemeralStorage: dockerByteQuantity(ephemeralStorageBytes),
    runtimeTmpfs: dockerByteQuantity(
      Math.min(ephemeralStorageBytes, DOCKER_RUNTIME_TMPFS_MAX_BYTES),
    ),
    pidLimit: DOCKER_VAULT_PID_LIMIT,
  };
}

function composeEscape(value: string): string {
  return value.replace(/\$/g, "$$$$");
}

function sanitizeVolumeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function volumeKey(name: string): string {
  return sanitizeVolumeToken(name).replace(/^[.-]+/, "") || "volume";
}

function resolveDockerVolume(args: {
  fallbackName: string;
  source: VaultSpec["attachments"]["vaultData"]["source"];
}): { key: string; name: string } {
  const baseName = args.source.volumeRef?.trim() || args.fallbackName;
  const suffix = args.source.subPath?.trim()
    ? `-${args.source.subPath.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-")}`
    : "";
  const name = `${baseName}${suffix}`;
  return {
    key: volumeKey(name),
    name,
  };
}

function renderDockerVaultDataVolume(vault: VaultSpec): {
  mountBlock: string[];
  volumeBlock: string[];
} {
  const source = vault.attachments.vaultData.source;
  if (isNetfsSource(source)) {
    if (source.server?.trim() === "netfs.local") {
      return {
        mountBlock: [
          "      - type: bind",
          `        source: ${JSON.stringify(netfsResolvedPath(source))}`,
          "        target: /vault/project",
        ],
        volumeBlock: [],
      };
    }
    const server = dockerNetfsServer(source);
    const device = dockerNetfsDevicePath(source);
    const options = [`addr=${server}`, ...netfsMountOptions(source)].join(",");
    const volumeName = vaultDataDockerVolumeName(vault);
    const volumeToken = volumeKey(volumeName);
    return {
      mountBlock: [
        "      - type: volume",
        `        source: ${volumeToken}`,
        "        target: /vault/project",
      ],
      volumeBlock: [
        `  ${volumeToken}:`,
        `    name: ${volumeName}`,
        "    driver: local",
        "    driver_opts:",
        '      type: "nfs"',
        `      o: ${JSON.stringify(options)}`,
        `      device: ${JSON.stringify(device)}`,
      ],
    };
  }
  const vaultDataVolume = resolveDockerVolume({
    fallbackName: `${vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName)}-vault-data`,
    source,
  });
  return {
    mountBlock: [
      "      - type: volume",
      `        source: ${vaultDataVolume.key}`,
      "        target: /vault/project",
    ],
    volumeBlock: [
      `  ${vaultDataVolume.key}:`,
      `    name: ${vaultDataVolume.name}`,
    ],
  };
}

const REPO_ROOT = resolveRepoRoot(import.meta.url);

function buildEvolutionBootstrapLines(vault: VaultSpec): string[] {
  const outputs = [
    [vault.evolution?.vaultMemoryFile, vault.evolution?.vaultMemoryContent],
    [vault.evolution?.userMemoryFile, vault.evolution?.userMemoryContent],
    [vault.evolution?.sessionSnapshotFile, vault.evolution?.sessionSnapshotContent],
  ] as Array<[string | undefined, string | undefined]>;
  return outputs.flatMap(([filePath, content]) => {
    if (!filePath || !content) {
      return [];
    }
    const encoded = Buffer.from(content, "utf8").toString("base64");
    return [
      `if [ ! -f ${filePath} ]; then python3 -c ${q(`import base64, pathlib; path = pathlib.Path(${JSON.stringify(filePath)}); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(base64.b64decode(${JSON.stringify(encoded)}));`)}; fi`,
    ];
  });
}

function buildGitHubKnownHostsLines(sshRoot: string): string[] {
  return [
    "if command -v ssh-keyscan >/dev/null 2>&1; then",
    `  mkdir -p ${sshRoot}`,
    `  chmod 700 ${sshRoot} || true`,
    `  touch ${sshRoot}/known_hosts`,
    `  chmod 600 ${sshRoot}/known_hosts || true`,
    `  if ! ssh-keygen -F github.com -f ${sshRoot}/known_hosts >/dev/null 2>&1; then`,
    `    ssh-keyscan -H github.com >> ${sshRoot}/known_hosts 2>/dev/null || true`,
    "  fi",
    "fi",
  ];
}

function buildRuntimeObserverLines(vault: VaultSpec): string[] {
  if (!vault.agent.enabled) {
    return [];
  }
  const memoryObserverPath = path.join(
    REPO_ROOT,
    "apps",
    "polaris",
    "scripts",
    "evolution",
    "runtime-memory-observer.mjs",
  );
  const memoryScript = fs.readFileSync(memoryObserverPath, "utf8");
  const memoryEncoded = Buffer.from(memoryScript, "utf8").toString("base64");
  const memoryRuntimePath = `${vault.agent.runtime.evolutionRoot}/runtime-memory-observer.mjs`;
  return [
    `python3 -c ${q(`import base64, pathlib; path = pathlib.Path(${JSON.stringify(memoryRuntimePath)}); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(base64.b64decode(${JSON.stringify(memoryEncoded)}));`)}`,
    `chmod 755 ${memoryRuntimePath}`,
    `POLARIS_PROJECT=${q(vault.identity.projectName)} POLARIS_USER_PROFILE_ID=${q(vault.userProfile.id)} POLARIS_MANAGER_ID=${q(vault.agent.managerId)} PASEO_HOME=${vault.runtime.home}/.paseo node ${memoryRuntimePath} > ${vault.agent.runtime.evolutionRoot}/runtime-memory-observer.log 2>&1 &`,
  ];
}

function persistentPolarisToolRoot(vault: VaultSpec): string {
  return `${vault.attachments.vaultRuntimeState.mountRoot}/tooling/polaris`;
}

function codexXdgRoots(vault: VaultSpec): {
  config: string;
  data: string;
  state: string;
} {
  const base = `${vault.attachments.userIdentityState.mountRoot}/codex-xdg`;
  return {
    config: `${base}/config`,
    data: `${base}/data`,
    state: `${base}/state`,
  };
}

function buildAgentCliInstallLines(vault: VaultSpec): string[] {
  const home = vault.runtime.home;
  const toolRoot = persistentPolarisToolRoot(vault);
  const xdg = codexXdgRoots(vault);
  const imageToolRoot = `${home}/.local/polaris`;
  const toolBinaries = vaultToolCatalog()
    .filter((tool) => !["codex", "claude"].includes(tool.id))
    .map((tool) => tool.binName);
  return [
    `mkdir -p ${toolRoot} /tmp/npm-cache ${home}/.local ${xdg.config} ${xdg.data} ${xdg.state}`,
    `if [ -x ${imageToolRoot}/bin/paseo ] && [ ! -L ${imageToolRoot} ]; then rm -rf ${toolRoot}/bin/paseo ${toolRoot}/lib/node_modules/@getpaseo; cp -a ${imageToolRoot}/. ${toolRoot}/; fi`,
    `npm_config_cache=/tmp/npm-cache npm install -g --prefix ${toolRoot} ${vaultNonPaseoToolPackageSpecs().join(" ")}`,
    `if [ ! -x ${toolRoot}/bin/paseo ]; then npm_config_cache=/tmp/npm-cache npm install -g --prefix ${toolRoot} ${vaultPaseoPackageSpec()}; fi`,
    ...toolBinaries.map((binary) => `ln -sf ${toolRoot}/bin/${binary} /usr/local/bin/${binary}`),
    `printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'export CODEX_HOME=${home}/.codex' 'export XDG_CONFIG_HOME=${xdg.config}' 'export XDG_DATA_HOME=${xdg.data}' 'export XDG_STATE_HOME=${xdg.state}' 'export NPM_CONFIG_PREFIX=${toolRoot}' 'export npm_config_cache=/tmp/npm-cache' 'mkdir -p ${home}/.codex /tmp/npm-cache ${xdg.config} ${xdg.data} ${xdg.state}' 'exec ${toolRoot}/bin/codex \"$@\"' > /usr/local/bin/codex`,
    "chmod 755 /usr/local/bin/codex",
    `printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'export NPM_CONFIG_PREFIX=${toolRoot}' 'export npm_config_cache=/tmp/npm-cache' 'mkdir -p /tmp/npm-cache' 'exec ${toolRoot}/bin/claude \"$@\"' > /usr/local/bin/claude`,
    "chmod 755 /usr/local/bin/claude",
  ];
}

function buildAgentCliWrapperLines(vault: VaultSpec): string[] {
  const home = vault.runtime.home;
  const toolRoot = persistentPolarisToolRoot(vault);
  const xdg = codexXdgRoots(vault);
  const toolBinaries = vaultToolCatalog()
    .filter((tool) => !["codex", "claude"].includes(tool.id))
    .map((tool) => tool.binName);
  return [
    ...toolBinaries.map((binary) => `ln -sf ${toolRoot}/bin/${binary} /usr/local/bin/${binary}`),
    `printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'export PATH=${toolRoot}/bin:$PATH' 'export CODEX_HOME=${home}/.codex' 'export XDG_CONFIG_HOME=${xdg.config}' 'export XDG_DATA_HOME=${xdg.data}' 'export XDG_STATE_HOME=${xdg.state}' 'export NPM_CONFIG_PREFIX=${toolRoot}' 'export npm_config_cache=/tmp/npm-cache' 'mkdir -p ${home}/.codex /tmp/npm-cache ${xdg.config} ${xdg.data} ${xdg.state}' 'exec ${toolRoot}/bin/codex \"$@\"' > /usr/local/bin/codex`,
    "chmod 755 /usr/local/bin/codex",
    `printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'export PATH=${toolRoot}/bin:$PATH' 'export NPM_CONFIG_PREFIX=${toolRoot}' 'export npm_config_cache=/tmp/npm-cache' 'mkdir -p /tmp/npm-cache' 'exec ${toolRoot}/bin/claude \"$@\"' > /usr/local/bin/claude`,
    "chmod 755 /usr/local/bin/claude",
  ];
}

function vaultEnablesWanghaiPortal(vault: VaultSpec): boolean {
  return vault.connectivity.servicePorts.some((port) => {
    const name = (port.name ?? "").toLowerCase();
    return name === "wanghai" || String(port.containerPort) === "9090";
  });
}

function isWanghaiServicePort(port: VaultSpec["connectivity"]["servicePorts"][number]): boolean {
  const name = (port.name ?? "").toLowerCase();
  return name === "wanghai" || String(port.containerPort) === "9090";
}

function wanghaiGatewayEnvironment(vault: VaultSpec): Record<string, string> | null {
  if (!vaultEnablesWanghaiPortal(vault)) return null;
  return {
    WANGHAI_RUNTIME_MODE: "polaris",
    WANGHAI_GATEWAY_ASSERTION_SECRET: deriveWanghaiVaultAssertionSecret(
      requireWanghaiGatewayMasterSecret(),
      vault.userProfile.id,
      vault.identity.projectName,
    ),
    WANGHAI_GATEWAY_TENANT_ID: vault.userProfile.id,
    WANGHAI_GATEWAY_VAULT_ID: vault.identity.projectName,
    WANGHAI_GATEWAY_FRAME_ANCESTORS: configuredWanghaiFrameAncestors(),
  };
}

/** Wanghai runs as the foreground process for a vertical vault. */
function buildWanghaiPortalRuntimeLines(vault: VaultSpec): string[] {
  if (!vaultEnablesWanghaiPortal(vault)) {
    return [
      "touch /tmp/.ready",
      "sleep infinity",
    ];
  }
  return [
    `if [ ! -x /usr/local/bin/wanghai-entrypoint ] || [ ! -d /opt/wanghai/apps/admin-portal ]; then echo "Wanghai portal runtime is missing" >&2; exit 1; fi`,
    `exec env WANGHAI_SUPERVISE_PORTAL=1 /usr/local/bin/wanghai-entrypoint pnpm --dir /opt/wanghai/apps/admin-portal run start --hostname 0.0.0.0 --port 9090`,
  ];
}

function buildPaseoBootstrapLines(vault: VaultSpec): string[] {
  if (!vault.agent.enabled) {
    return [];
  }
  const home = vault.runtime.home;
  const paseoAppBaseUrl = resolveConfiguredPaseoAppBaseUrl();
  const pidFile = `${home}/.paseo/paseo.pid`;
  const daemonLog = `${home}/.paseo/daemon.log`;
  const runtimePidFile = `${vault.attachments.ephemeralRuntime.mountRoot}/pids/paseo.pid`;
  const configScript = [
    "import json, pathlib",
    `path = pathlib.Path(${JSON.stringify(`${home}/.paseo/config.json`)})`,
    "data = json.loads(path.read_text()) if path.exists() else {}",
    'data.setdefault("daemon", {})["listen"] = "0.0.0.0:6767"',
    'data.setdefault("features", {}).setdefault("dictation", {})["enabled"] = False',
    'data.setdefault("features", {}).setdefault("voiceMode", {})["enabled"] = False',
    ...(paseoAppBaseUrl
      ? [`data.setdefault("app", {})["baseUrl"] = ${JSON.stringify(paseoAppBaseUrl)}`]
      : []),
    "path.parent.mkdir(parents=True, exist_ok=True)",
    'path.write_text(json.dumps(data, indent=2) + "\\n")',
  ].join("; ");
  return [
    `python3 -c ${q(configScript)}`,
    `paseo_sync_pairing() { tmp_pairing=$(mktemp); if PASEO_HOME=${home}/.paseo paseo daemon pair --json > "$tmp_pairing"; then mv "$tmp_pairing" ${home}/.paseo/pairing.json; else rm -f "$tmp_pairing"; return 1; fi; }`,
    `paseo_daemon_healthy() { daemon_status=$(PASEO_HOME=${home}/.paseo paseo daemon status --json 2>/dev/null || true); printf '%s' "$daemon_status" | grep -q '"localDaemon"[[:space:]]*:[[:space:]]*"running"' && printf '%s' "$daemon_status" | grep -q '"connectedDaemon"[[:space:]]*:[[:space:]]*"reachable"'; }`,
    `paseo_ready() { test -s ${home}/.paseo/server-id && test -f ${home}/.paseo/pairing.json && grep -q '"url"[[:space:]]*:' ${home}/.paseo/pairing.json && paseo_daemon_healthy; }`,
    `paseo_wait_ready() { for _ in $(seq 1 15); do if paseo_ready; then return 0; fi; sleep 1; done; return 1; }`,
    `paseo_stop_runner() { paseo_pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' ${pidFile} 2>/dev/null | head -n 1); if [ -z "$paseo_pid" ]; then paseo_pid=$(cat ${pidFile} 2>/dev/null | tr -cd '0-9'); fi; if [ -n "$paseo_pid" ]; then paseo_args=$(ps -o args= -p "$paseo_pid" 2>/dev/null || true); if printf '%s' "$paseo_args" | grep -Eq 'daemon-runner|Paseo Supervisor|paseo daemon start'; then pkill -TERM -P "$paseo_pid" 2>/dev/null || true; kill "$paseo_pid" 2>/dev/null || true; sleep 1; pkill -KILL -P "$paseo_pid" 2>/dev/null || true; kill -KILL "$paseo_pid" 2>/dev/null || true; fi; fi; rm -f ${pidFile} ${runtimePidFile} ${daemonLog}; }`,
    `if ! paseo_wait_ready; then`,
    `  paseo_stop_runner`,
    `  PASEO_HOME=${home}/.paseo paseo daemon start --listen 0.0.0.0:6767`,
    `  paseo_sync_pairing || true`,
    `  if ! paseo_wait_ready; then`,
    `    paseo_stop_runner`,
    `    PASEO_HOME=${home}/.paseo paseo daemon start --listen 0.0.0.0:6767`,
    `    paseo_sync_pairing || true`,
    `    paseo_wait_ready`,
    `  fi`,
    `else`,
    `  paseo_sync_pairing || true`,
    `fi`,
    ...buildRuntimeObserverLines(vault),
  ];
}

export function renderDockerVault(vault: VaultSpec): string {
  const project = vault.identity.projectName;
  const runtimeScope = vaultRuntimeScopeName(vault.userProfile.id, project);
  const serviceName = runtimeScope;
  const composeProjectName = sanitizeVolumeToken(runtimeScope).replace(/^[.-]+/, "") || "polaris-vault";
  const containerName = `${runtimeScope}-docker`;
  const resourceLimits = dockerVaultResourceLimits(vault);
  const vaultDataVolume = renderDockerVaultDataVolume(vault);
  const vaultRuntimeVolume = resolveDockerVolume({
    fallbackName: `${runtimeScope}-vault-runtime-state`,
    source: vault.attachments.vaultRuntimeState.source,
  });
  const userScope = vault.userProfile.id.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const identityVolume = resolveDockerVolume({
    fallbackName: `polaris-${userScope}-identity`,
    source: vault.attachments.userIdentityState.source,
  });
  const home = vault.runtime.home;
  const toolRoot = persistentPolarisToolRoot(vault);
  const xdg = codexXdgRoots(vault);
  const imageToolRoot = `${home}/.local/polaris`;
  const sshRoot = `${vault.attachments.userIdentityState.mountRoot}/ssh`;
  const identityDirs = userIdentityBootstrapDirs(
    vault.attachments.userIdentityState.mountRoot,
  );
  const authFiles = vaultEnablesWanghaiPortal(vault)
    ? sanitizeIntegratedWanghaiAuthFiles(vault.runtime.authFiles)
    : vault.runtime.authFiles;
  const plainEnvVars = vaultEnablesWanghaiPortal(vault)
    ? filterIntegratedWanghaiPlainEnvVars(vault.runtime.plainEnvVars)
    : vault.runtime.plainEnvVars;
  const wanghaiGateway = wanghaiGatewayEnvironment(vault);
  const authBootstrapFiles = authFiles.map((file, index) => ({
    environmentName: `POLARIS_BOOTSTRAP_AUTH_FILE_${index}_B64`,
    file,
    value: Buffer.from(file.content ?? "", "utf8").toString("base64"),
  }));
  const authBootstrapLines = authBootstrapFiles.flatMap(({ environmentName, file }) => {
    const storageTarget = stateStoragePathForMountPath({
      mountPath: file.mountPath,
      runtimeHome: home,
      identityRoot: vault.attachments.userIdentityState.mountRoot,
    });
    const target = storageTarget ?? file.mountPath;
    const parent = path.dirname(target);
    const decode = `mkdir -p ${q(parent)}; printf '%s' "\${${environmentName}}" | base64 -d > ${q(target)}`;
    const guardedWrite =
      storageTarget?.startsWith(`${sshRoot}/`)
        && vault.userProfile.ssh.mode === "provided-key"
        ? decode
        : `if [ ! -f ${q(target)} ]; then ${decode}; fi`;
    return [
      guardedWrite,
      ...(vault.runtime.user === "root" ? [`chown root:root ${target} || true`] : []),
      `chmod 600 ${target} || true`,
      `unset ${environmentName}`,
    ];
  });
  const agentBootstrapLines = vault.agent.enabled
    ? [
        `mkdir -p ${vault.attachments.vaultData.mountRoot} ${vault.attachments.vaultRuntimeState.mountRoot}/paseo ${vault.attachments.vaultRuntimeState.mountRoot}/paseo/evolution ${toolRoot} ${identityDirs.join(" ")} ${vault.attachments.ephemeralRuntime.mountRoot}/tmp ${vault.attachments.ephemeralRuntime.mountRoot}/pids ${vault.attachments.ephemeralRuntime.mountRoot}/sockets ${home}/.config ${home}/.local ${home}/.local/share /tmp/npm-cache`,
        ...(vault.runtime.user === "root"
          ? [`chown -R root:root ${vault.attachments.vaultRuntimeState.mountRoot} ${vault.attachments.userIdentityState.mountRoot} ${vault.attachments.ephemeralRuntime.mountRoot}`]
          : []),
        `if [ -x ${imageToolRoot}/bin/paseo ] && [ ! -L ${imageToolRoot} ]; then rm -rf ${toolRoot}/bin/paseo ${toolRoot}/lib/node_modules/@getpaseo; cp -a ${imageToolRoot}/. ${toolRoot}/; fi`,
        `rm -rf ${home}/.codex ${home}/.claude ${home}/.copilot ${home}/.pi ${home}/.config/opencode ${home}/.local/share/opencode ${home}/.paseo ${home}/.ssh ${home}/vault`,
        `ln -sfn ${vault.attachments.userIdentityState.mountRoot}/codex ${home}/.codex`,
        `ln -sfn ${vault.attachments.userIdentityState.mountRoot}/claude ${home}/.claude`,
        `ln -sfn ${vault.attachments.userIdentityState.mountRoot}/copilot ${home}/.copilot`,
        `ln -sfn ${vault.attachments.userIdentityState.mountRoot}/pi ${home}/.pi`,
        `ln -sfn ${vault.attachments.userIdentityState.mountRoot}/opencode/config ${home}/.config/opencode`,
        `ln -sfn ${vault.attachments.userIdentityState.mountRoot}/opencode/data ${home}/.local/share/opencode`,
        `ln -sfn ${vault.attachments.vaultRuntimeState.mountRoot}/paseo ${home}/.paseo`,
        `ln -sfn ${sshRoot} ${home}/.ssh`,
        `ln -sfn ${vault.attachments.vaultData.mountRoot} ${home}/vault`,
        `ln -sfn ${toolRoot} ${home}/.local/polaris`,
        ...buildAgentCliWrapperLines(vault),
        ...(vault.profile.vaultAlias ? [`ln -sfn ${vault.attachments.vaultData.mountRoot} ${home}/${vault.profile.vaultAlias}`] : []),
      ]
    : [
        `mkdir -p ${vault.attachments.vaultData.mountRoot} ${vault.attachments.vaultRuntimeState.mountRoot} ${vault.attachments.ephemeralRuntime.mountRoot}/tmp ${vault.attachments.ephemeralRuntime.mountRoot}/pids ${vault.attachments.ephemeralRuntime.mountRoot}/sockets`,
      ];
  const agentIdentityBootstrapLines = vault.agent.enabled
    ? [
        `mkdir -p ${sshRoot}`,
        ...(vault.runtime.user === "root" ? [`chown root:root ${sshRoot} || true`] : []),
        `chmod 700 ${sshRoot} || true`,
        ...(vault.runtime.user === "root"
          ? [`find ${sshRoot} -maxdepth 1 -type f -exec chown root:root {} + 2>/dev/null || true`]
          : []),
        `find ${sshRoot} -maxdepth 1 -type f ! -name '*.pub' ! -name 'authorized_keys' ! -name 'known_hosts' ! -name 'known_hosts.old' -exec chmod ${vault.runtime.user === "root" ? "400" : "600"} {} + 2>/dev/null || true`,
        `find ${sshRoot} -maxdepth 1 -type f -name '*.pub' -exec chmod 644 {} + 2>/dev/null || true`,
        `for ssh_meta in ${sshRoot}/authorized_keys ${sshRoot}/known_hosts ${sshRoot}/known_hosts.old; do if [ -e "$ssh_meta" ]; then chmod 600 "$ssh_meta" 2>/dev/null || true; fi; done`,
        ...buildGitHubKnownHostsLines(sshRoot),
      ]
    : [];
  const bootstrap = [
    "set -eu",
    `mkdir -p ${home}`,
    `chmod 755 ${home}`,
    ...(vault.runtime.bootstrapProfile === "prebuilt"
      ? []
      : [
          `apt-get update && apt-get install -y openssh-client ca-certificates curl git nodejs npm procps python3 ripgrep ${vault.runtime.aptPackages.join(" ")} && rm -rf /var/lib/apt/lists/*`,
          ...(vault.runtime.installRustup
            ? ["curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"]
            : []),
          ...(vault.agent.enabled ? buildAgentCliInstallLines(vault) : []),
        ]),
    ...agentBootstrapLines,
    ...authBootstrapLines,
    ...agentIdentityBootstrapLines,
    ...(vault.agent.enabled ? buildEvolutionBootstrapLines(vault) : []),
    ...buildPaseoBootstrapLines(vault),
    ...buildWanghaiPortalRuntimeLines(vault),
  ]
    .map((line) => composeEscape(line))
    .join("\n");
  const portLines = vault.connectivity.servicePorts
    .filter((port) => {
      if (!vault.agent.enabled && !isWanghaiServicePort(port)) {
        return false;
      }
      return !isWanghaiServicePort(port) || Boolean(port.nodePort);
    })
    .map((port) => isWanghaiServicePort(port)
      ? `      - "127.0.0.1:${port.nodePort}:${port.containerPort}"`
      : `      - "${port.nodePort || port.containerPort}:${port.containerPort}"`)
    .join("\n");
  const ports = portLines
    ? `ports:\n${portLines}`
    : vault.agent.enabled
      ? 'ports:\n      - "6767:6767"'
      : "ports: []";
  const environment = {
    ...Object.fromEntries(plainEnvVars.map((envVar) => [envVar.name, envVar.value])),
    POLARIS_EVOLUTION_ROOT: vault.agent.runtime.evolutionRoot,
    POLARIS_VAULT_MEMORY_FILE: vault.evolution?.vaultMemoryFile ?? "",
    POLARIS_USER_MEMORY_FILE: vault.evolution?.userMemoryFile ?? "",
    POLARIS_MEMORY_SNAPSHOT_FILE: vault.evolution?.sessionSnapshotFile ?? "",
    ...(wanghaiGateway ?? {}),
    ...Object.fromEntries(authBootstrapFiles.map((file) => [file.environmentName, file.value])),
  };
  const environmentLines = Object.entries(environment)
    .map(([name, value]) => `      ${name}: ${q(value)}`)
    .join("\n");

  return `name: ${composeProjectName}

services:
  ${serviceName}:
    image: ${vault.runtime.baseImage}
    container_name: ${containerName}
    restart: unless-stopped
    command:
      - /bin/sh
      - -lc
      - |
${bootstrap.split("\n").map((line) => `        ${line}`).join("\n")}
    ${ports}
    cpus: ${q(resourceLimits.cpu)}
    mem_limit: ${q(resourceLimits.memory)}
    memswap_limit: ${q(resourceLimits.memory)}
    pids_limit: ${resourceLimits.pidLimit}
    storage_opt:
      size: ${q(resourceLimits.ephemeralStorage)}
    environment:
${environmentLines}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
${vaultDataVolume.mountBlock.join("\n")}
      - type: volume
        source: ${vaultRuntimeVolume.key}
        target: /vault/state
      - type: volume
        source: ${identityVolume.key}
        target: /identity
    tmpfs:
      - /run/vault:rw,nosuid,nodev,noexec,size=${resourceLimits.runtimeTmpfs}

volumes:
${vaultDataVolume.volumeBlock.join("\n")}
  ${vaultRuntimeVolume.key}:
    name: ${vaultRuntimeVolume.name}
  ${identityVolume.key}:
    name: ${identityVolume.name}
    external: true
`;
}

export function renderAndWriteDockerVault(vault: VaultSpec): string {
  return writeGeneratedManifest(vault, renderDockerVault(vault));
}
