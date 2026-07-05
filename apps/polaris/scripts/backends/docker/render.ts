import fs from "node:fs";
import path from "node:path";
import type { WorkspaceSpec } from "../../core/workspace.js";
import {
  dockerNetfsDevicePath,
  dockerNetfsServer,
  isNetfsSource,
  netfsMountOptions,
  netfsResolvedPath,
  requireNetfsField,
  workspaceDataDockerVolumeName,
} from "../../core/netfs.js";
import {
  workspaceNonPaseoToolPackageSpecs,
  workspacePaseoPackageSpec,
  workspaceToolCatalog,
} from "../../core/harness-catalog.js";
import {
  stateStoragePathForMountPath,
  userIdentityBootstrapDirs,
} from "../../core/identity-layout.js";
import { workspaceRuntimeScopeName } from "../../core/workspace-name.js";
import { resolveConfiguredPaseoAppBaseUrl } from "../../core/pairing-url.js";
import { writeGeneratedManifest } from "../../output/write-generated.js";
import { resolveRepoRoot } from "../../utils/repo-root.js";

function q(value: string): string {
  return JSON.stringify(value);
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
  source: WorkspaceSpec["attachments"]["workspaceData"]["source"];
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

function renderDockerWorkspaceDataVolume(workspace: WorkspaceSpec): {
  mountBlock: string[];
  volumeBlock: string[];
} {
  const source = workspace.attachments.workspaceData.source;
  if (isNetfsSource(source)) {
    if (source.server?.trim() === "netfs.local") {
      return {
        mountBlock: [
          "      - type: bind",
          `        source: ${JSON.stringify(netfsResolvedPath(source))}`,
          "        target: /workspace/project",
        ],
        volumeBlock: [],
      };
    }
    const server = dockerNetfsServer(source);
    const device = dockerNetfsDevicePath(source);
    const options = [`addr=${server}`, ...netfsMountOptions(source)].join(",");
    const volumeName = workspaceDataDockerVolumeName(workspace);
    const volumeToken = volumeKey(volumeName);
    return {
      mountBlock: [
        "      - type: volume",
        `        source: ${volumeToken}`,
        "        target: /workspace/project",
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
  const workspaceDataVolume = resolveDockerVolume({
    fallbackName: `${workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName)}-workspace-data`,
    source,
  });
  return {
    mountBlock: [
      "      - type: volume",
      `        source: ${workspaceDataVolume.key}`,
      "        target: /workspace/project",
    ],
    volumeBlock: [
      `  ${workspaceDataVolume.key}:`,
      `    name: ${workspaceDataVolume.name}`,
    ],
  };
}

const REPO_ROOT = resolveRepoRoot(import.meta.url);

function buildEvolutionBootstrapLines(workspace: WorkspaceSpec): string[] {
  const outputs = [
    [workspace.evolution?.workspaceMemoryFile, workspace.evolution?.workspaceMemoryContent],
    [workspace.evolution?.userMemoryFile, workspace.evolution?.userMemoryContent],
    [workspace.evolution?.sessionSnapshotFile, workspace.evolution?.sessionSnapshotContent],
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

function buildRuntimeObserverLines(workspace: WorkspaceSpec): string[] {
  if (!workspace.agent.enabled) {
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
  const statusObserverPath = path.join(
    REPO_ROOT,
    "apps",
    "polaris",
    "scripts",
    "runtime",
    "status-observer.mjs",
  );
  const memoryScript = fs.readFileSync(memoryObserverPath, "utf8");
  const statusScript = fs.readFileSync(statusObserverPath, "utf8");
  const memoryEncoded = Buffer.from(memoryScript, "utf8").toString("base64");
  const statusEncoded = Buffer.from(statusScript, "utf8").toString("base64");
  const memoryRuntimePath = `${workspace.agent.runtime.evolutionRoot}/runtime-memory-observer.mjs`;
  const statusRuntimePath = `${workspace.agent.runtime.evolutionRoot}/status-observer.mjs`;
  const reportUrl = (
    process.env.POLARIS_RUNTIME_EXECUTOR_BASE_URL?.trim()
    || process.env.POLARIS_EXECUTOR_BASE_URL?.trim()
    || ""
  ).replace(/\/+$/, "");
  const reportSecret = process.env.POLARIS_EXECUTOR_SHARED_SECRET?.trim() || "";
  return [
    `python3 -c ${q(`import base64, pathlib; path = pathlib.Path(${JSON.stringify(memoryRuntimePath)}); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(base64.b64decode(${JSON.stringify(memoryEncoded)}));`)}`,
    `python3 -c ${q(`import base64, pathlib; path = pathlib.Path(${JSON.stringify(statusRuntimePath)}); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(base64.b64decode(${JSON.stringify(statusEncoded)}));`)}`,
    `chmod 755 ${memoryRuntimePath} ${statusRuntimePath}`,
    `POLARIS_PROJECT=${q(workspace.identity.projectName)} POLARIS_USER_PROFILE_ID=${q(workspace.userProfile.id)} POLARIS_MANAGER_ID=${q(workspace.agent.managerId)} PASEO_HOME=${workspace.runtime.home}/.paseo node ${memoryRuntimePath} > ${workspace.agent.runtime.evolutionRoot}/runtime-memory-observer.log 2>&1 &`,
    `POLARIS_PROJECT=${q(workspace.identity.projectName)} POLARIS_USER_PROFILE_ID=${q(workspace.userProfile.id)} POLARIS_MANAGER_ID=${q(workspace.agent.managerId)} POLARIS_RUNTIME_STATUS_REPORT_URL=${q(reportUrl ? `${reportUrl}/workspaces/status/report` : "")} POLARIS_RUNTIME_STATUS_REPORT_SECRET=${q(reportSecret)} PASEO_HOME=${workspace.runtime.home}/.paseo node ${statusRuntimePath} > ${workspace.agent.runtime.evolutionRoot}/status-observer.log 2>&1 &`,
  ];
}

function persistentPolarisToolRoot(workspace: WorkspaceSpec): string {
  return `${workspace.attachments.workspaceRuntimeState.mountRoot}/tooling/polaris`;
}

function codexXdgRoots(workspace: WorkspaceSpec): {
  config: string;
  data: string;
  state: string;
} {
  const base = `${workspace.attachments.userIdentityState.mountRoot}/codex-xdg`;
  return {
    config: `${base}/config`,
    data: `${base}/data`,
    state: `${base}/state`,
  };
}

function buildAgentCliInstallLines(workspace: WorkspaceSpec): string[] {
  const home = workspace.runtime.home;
  const toolRoot = persistentPolarisToolRoot(workspace);
  const xdg = codexXdgRoots(workspace);
  const imageToolRoot = `${home}/.local/polaris`;
  const toolBinaries = workspaceToolCatalog()
    .filter((tool) => !["codex", "claude"].includes(tool.id))
    .map((tool) => tool.binName);
  return [
    `mkdir -p ${toolRoot} /tmp/npm-cache ${home}/.local ${xdg.config} ${xdg.data} ${xdg.state}`,
    `if [ -x ${imageToolRoot}/bin/paseo ] && [ ! -L ${imageToolRoot} ]; then rm -rf ${toolRoot}/bin/paseo ${toolRoot}/lib/node_modules/@getpaseo; cp -a ${imageToolRoot}/. ${toolRoot}/; fi`,
    `npm_config_cache=/tmp/npm-cache npm install -g --prefix ${toolRoot} ${workspaceNonPaseoToolPackageSpecs().join(" ")}`,
    `if [ ! -x ${toolRoot}/bin/paseo ]; then npm_config_cache=/tmp/npm-cache npm install -g --prefix ${toolRoot} ${workspacePaseoPackageSpec()}; fi`,
    ...toolBinaries.map((binary) => `ln -sf ${toolRoot}/bin/${binary} /usr/local/bin/${binary}`),
    `printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'export CODEX_HOME=${home}/.codex' 'export XDG_CONFIG_HOME=${xdg.config}' 'export XDG_DATA_HOME=${xdg.data}' 'export XDG_STATE_HOME=${xdg.state}' 'export NPM_CONFIG_PREFIX=${toolRoot}' 'export npm_config_cache=/tmp/npm-cache' 'mkdir -p ${home}/.codex /tmp/npm-cache ${xdg.config} ${xdg.data} ${xdg.state}' 'exec ${toolRoot}/bin/codex \"$@\"' > /usr/local/bin/codex`,
    "chmod 755 /usr/local/bin/codex",
    `printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'export NPM_CONFIG_PREFIX=${toolRoot}' 'export npm_config_cache=/tmp/npm-cache' 'mkdir -p /tmp/npm-cache' 'exec ${toolRoot}/bin/claude \"$@\"' > /usr/local/bin/claude`,
    "chmod 755 /usr/local/bin/claude",
  ];
}

function buildAgentCliWrapperLines(workspace: WorkspaceSpec): string[] {
  const home = workspace.runtime.home;
  const toolRoot = persistentPolarisToolRoot(workspace);
  const xdg = codexXdgRoots(workspace);
  const toolBinaries = workspaceToolCatalog()
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

function buildPaseoBootstrapLines(workspace: WorkspaceSpec): string[] {
  if (!workspace.agent.enabled) {
    return [];
  }
  const home = workspace.runtime.home;
  const paseoAppBaseUrl = resolveConfiguredPaseoAppBaseUrl();
  const pidFile = `${home}/.paseo/paseo.pid`;
  const daemonLog = `${home}/.paseo/daemon.log`;
  const runtimePidFile = `${workspace.attachments.ephemeralRuntime.mountRoot}/pids/paseo.pid`;
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
    ...buildRuntimeObserverLines(workspace),
  ];
}

export function renderDockerWorkspace(workspace: WorkspaceSpec): string {
  const project = workspace.identity.projectName;
  const runtimeScope = workspaceRuntimeScopeName(workspace.userProfile.id, project);
  const serviceName = runtimeScope;
  const composeProjectName = sanitizeVolumeToken(runtimeScope).replace(/^[.-]+/, "") || "polaris-workspace";
  const containerName = `${runtimeScope}-docker`;
  const workspaceDataVolume = renderDockerWorkspaceDataVolume(workspace);
  const workspaceRuntimeVolume = resolveDockerVolume({
    fallbackName: `${runtimeScope}-workspace-runtime-state`,
    source: workspace.attachments.workspaceRuntimeState.source,
  });
  const userScope = workspace.userProfile.id.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const identityVolume = resolveDockerVolume({
    fallbackName: `polaris-${userScope}-identity`,
    source: workspace.attachments.userIdentityState.source,
  });
  const home = workspace.runtime.home;
  const toolRoot = persistentPolarisToolRoot(workspace);
  const xdg = codexXdgRoots(workspace);
  const imageToolRoot = `${home}/.local/polaris`;
  const sshRoot = `${workspace.attachments.userIdentityState.mountRoot}/ssh`;
  const identityDirs = userIdentityBootstrapDirs(
    workspace.attachments.userIdentityState.mountRoot,
  );
  const authBootstrapLines = workspace.runtime.authFiles.flatMap((file) => {
    const content = file.content ?? "";
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const target = stateStoragePathForMountPath({
      mountPath: file.mountPath,
      runtimeHome: home,
      identityRoot: workspace.attachments.userIdentityState.mountRoot,
    });
    if (!target) {
      return [];
    }
    const guardedWrite =
      target.startsWith(`${sshRoot}/`)
        && workspace.userProfile.ssh.mode === "provided-key"
        ? `python3 -c ${q(`import base64, pathlib; path = pathlib.Path(${JSON.stringify(target)}); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(base64.b64decode(${JSON.stringify(encoded)}));`)}`
        : `if [ ! -f ${target} ]; then python3 -c ${q(`import base64, pathlib; path = pathlib.Path(${JSON.stringify(target)}); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(base64.b64decode(${JSON.stringify(encoded)}));`)}; fi`;
    return [
      guardedWrite,
      ...(workspace.runtime.user === "root" ? [`chown root:root ${target} || true`] : []),
      `chmod 600 ${target} || true`,
    ];
  });
  const bootstrap = [
    "set -eux",
    `mkdir -p ${home}`,
    `chmod 755 ${home}`,
    ...(workspace.runtime.bootstrapProfile === "prebuilt"
      ? []
      : [
          `apt-get update && apt-get install -y openssh-client ca-certificates curl git nodejs npm procps python3 ripgrep ${workspace.runtime.aptPackages.join(" ")} && rm -rf /var/lib/apt/lists/*`,
          ...(workspace.runtime.installRustup
            ? ["curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"]
            : []),
          ...buildAgentCliInstallLines(workspace),
        ]),
    `mkdir -p ${workspace.attachments.workspaceData.mountRoot} ${workspace.attachments.workspaceRuntimeState.mountRoot}/paseo ${workspace.attachments.workspaceRuntimeState.mountRoot}/paseo/evolution ${toolRoot} ${identityDirs.join(" ")} ${workspace.attachments.ephemeralRuntime.mountRoot}/tmp ${workspace.attachments.ephemeralRuntime.mountRoot}/pids ${workspace.attachments.ephemeralRuntime.mountRoot}/sockets ${home}/.config ${home}/.local ${home}/.local/share /tmp/npm-cache`,
    ...(workspace.runtime.user === "root"
      ? [`chown -R root:root ${workspace.attachments.workspaceRuntimeState.mountRoot} ${workspace.attachments.userIdentityState.mountRoot} ${workspace.attachments.ephemeralRuntime.mountRoot}`]
      : []),
    `if [ -x ${imageToolRoot}/bin/paseo ] && [ ! -L ${imageToolRoot} ]; then rm -rf ${toolRoot}/bin/paseo ${toolRoot}/lib/node_modules/@getpaseo; cp -a ${imageToolRoot}/. ${toolRoot}/; fi`,
    `rm -rf ${home}/.codex ${home}/.claude ${home}/.copilot ${home}/.pi ${home}/.config/opencode ${home}/.local/share/opencode ${home}/.paseo ${home}/.ssh ${home}/workspace`,
    `ln -sfn ${workspace.attachments.userIdentityState.mountRoot}/codex ${home}/.codex`,
    `ln -sfn ${workspace.attachments.userIdentityState.mountRoot}/claude ${home}/.claude`,
    `ln -sfn ${workspace.attachments.userIdentityState.mountRoot}/copilot ${home}/.copilot`,
    `ln -sfn ${workspace.attachments.userIdentityState.mountRoot}/pi ${home}/.pi`,
    `ln -sfn ${workspace.attachments.userIdentityState.mountRoot}/opencode/config ${home}/.config/opencode`,
    `ln -sfn ${workspace.attachments.userIdentityState.mountRoot}/opencode/data ${home}/.local/share/opencode`,
    `ln -sfn ${workspace.attachments.workspaceRuntimeState.mountRoot}/paseo ${home}/.paseo`,
    `ln -sfn ${sshRoot} ${home}/.ssh`,
    `ln -sfn ${workspace.attachments.workspaceData.mountRoot} ${home}/workspace`,
    `ln -sfn ${toolRoot} ${home}/.local/polaris`,
    ...buildAgentCliWrapperLines(workspace),
    ...(workspace.profile.workspaceAlias ? [`ln -sfn ${workspace.attachments.workspaceData.mountRoot} ${home}/${workspace.profile.workspaceAlias}`] : []),
    ...authBootstrapLines,
    `mkdir -p ${sshRoot}`,
    ...(workspace.runtime.user === "root" ? [`chown root:root ${sshRoot} || true`] : []),
    `chmod 700 ${sshRoot} || true`,
    ...(workspace.runtime.user === "root"
      ? [`find ${sshRoot} -maxdepth 1 -type f -exec chown root:root {} + 2>/dev/null || true`]
      : []),
    `find ${sshRoot} -maxdepth 1 -type f ! -name '*.pub' ! -name 'authorized_keys' ! -name 'known_hosts' ! -name 'known_hosts.old' -exec chmod ${workspace.runtime.user === "root" ? "400" : "600"} {} + 2>/dev/null || true`,
    `find ${sshRoot} -maxdepth 1 -type f -name '*.pub' -exec chmod 644 {} + 2>/dev/null || true`,
    `for ssh_meta in ${sshRoot}/authorized_keys ${sshRoot}/known_hosts ${sshRoot}/known_hosts.old; do if [ -e "$ssh_meta" ]; then chmod 600 "$ssh_meta" 2>/dev/null || true; fi; done`,
    ...buildGitHubKnownHostsLines(sshRoot),
    ...workspace.runtime.plainEnvVars.map((envVar) => `export ${envVar.name}=${q(envVar.value)}`),
    ...buildEvolutionBootstrapLines(workspace),
    ...buildPaseoBootstrapLines(workspace),
    "touch /tmp/.ready",
    "sleep infinity",
  ]
    .map((line) => composeEscape(line))
    .join("\n");
  const portLines = workspace.connectivity.servicePorts
    .map((port) => `      - "${port.nodePort || port.containerPort}:${port.containerPort}"`)
    .join("\n");

  return `name: ${composeProjectName}

services:
  ${serviceName}:
    image: ${workspace.runtime.baseImage}
    container_name: ${containerName}
    restart: unless-stopped
    command:
      - /bin/sh
      - -lc
      - |
${bootstrap.split("\n").map((line) => `        ${line}`).join("\n")}
    ports:
${portLines || '      - "6767:6767"'}
    environment:
      POLARIS_EVOLUTION_ROOT: ${workspace.agent.runtime.evolutionRoot}
      POLARIS_WORKSPACE_MEMORY_FILE: ${workspace.evolution?.workspaceMemoryFile ?? ""}
      POLARIS_USER_MEMORY_FILE: ${workspace.evolution?.userMemoryFile ?? ""}
      POLARIS_MEMORY_SNAPSHOT_FILE: ${workspace.evolution?.sessionSnapshotFile ?? ""}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
${workspaceDataVolume.mountBlock.join("\n")}
      - type: volume
        source: ${workspaceRuntimeVolume.key}
        target: /workspace/state
      - type: volume
        source: ${identityVolume.key}
        target: /identity
    tmpfs:
      - /run/workspace

volumes:
${workspaceDataVolume.volumeBlock.join("\n")}
  ${workspaceRuntimeVolume.key}:
    name: ${workspaceRuntimeVolume.name}
  ${identityVolume.key}:
    name: ${identityVolume.name}
    external: true
`;
}

export function renderAndWriteDockerWorkspace(workspace: WorkspaceSpec): string {
  return writeGeneratedManifest(workspace, renderDockerWorkspace(workspace));
}
