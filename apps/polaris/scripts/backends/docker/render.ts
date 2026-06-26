import fs from "node:fs";
import path from "node:path";
import type { WorkspaceSpec } from "../../core/workspace.js";
import {
  dockerNetfsDevicePath,
  dockerNetfsServer,
  isNetfsSource,
  netfsMountOptions,
  requireNetfsField,
  workspaceDataDockerVolumeName,
} from "../../core/netfs.js";
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
    fallbackName: `${workspace.identity.projectName}-workspace-data`,
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

function buildGitHubKnownHostsLines(): string[] {
  return [
    "if command -v ssh-keyscan >/dev/null 2>&1; then",
    "  touch /ssh/known_hosts",
    "  chmod 600 /ssh/known_hosts || true",
    "  if ! ssh-keygen -F github.com -f /ssh/known_hosts >/dev/null 2>&1; then",
    "    ssh-keyscan -H github.com >> /ssh/known_hosts 2>/dev/null || true",
    "  fi",
    "fi",
  ];
}

function buildRuntimeObserverLines(workspace: WorkspaceSpec): string[] {
  if (!workspace.agent.enabled) {
    return [];
  }
  const observerPath = path.join(REPO_ROOT, "apps", "polaris", "scripts", "evolution", "runtime-observer.mjs");
  const script = fs.readFileSync(observerPath, "utf8");
  const encoded = Buffer.from(script, "utf8").toString("base64");
  const runtimePath = `${workspace.agent.runtime.evolutionRoot}/runtime-observer.mjs`;
  return [
    `python3 -c ${q(`import base64, pathlib; path = pathlib.Path(${JSON.stringify(runtimePath)}); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(base64.b64decode(${JSON.stringify(encoded)}));`)}`,
    `chmod 755 ${runtimePath}`,
    `POLARIS_PROJECT=${q(workspace.identity.projectName)} POLARIS_USER_PROFILE_ID=${q(workspace.userProfile.id)} POLARIS_MANAGER_ID=${q(workspace.agent.managerId)} PASEO_HOME=${workspace.runtime.home}/.paseo node ${runtimePath} > ${workspace.agent.runtime.evolutionRoot}/runtime-observer.log 2>&1 &`,
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
  return [
    `mkdir -p ${toolRoot} /tmp/npm-cache ${home}/.local ${xdg.config} ${xdg.data} ${xdg.state}`,
    `npm_config_cache=/tmp/npm-cache npm install -g --prefix ${toolRoot} @getpaseo/cli@latest @openai/codex @anthropic-ai/claude-code @fission-ai/openspec@latest pnpm`,
    `ln -sf ${toolRoot}/bin/paseo /usr/local/bin/paseo`,
    `ln -sf ${toolRoot}/bin/pnpm /usr/local/bin/pnpm`,
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
  return [
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
    ...(paseoAppBaseUrl
      ? [`data.setdefault("app", {})["baseUrl"] = ${JSON.stringify(paseoAppBaseUrl)}`]
      : []),
    "path.parent.mkdir(parents=True, exist_ok=True)",
    'path.write_text(json.dumps(data, indent=2) + "\\n")',
  ].join("; ");
  return [
    `python3 -c ${q(configScript)}`,
    `paseo_ready() { printf '%s' "$1" | grep -Eq '"localDaemon"[[:space:]]*:[[:space:]]*"running"' && printf '%s' "$1" | grep -Eq '"connectedDaemon"[[:space:]]*:[[:space:]]*"reachable"'; }`,
    `paseo_wait_ready() { for _ in $(seq 1 15); do paseo_status=$(timeout 5s env PASEO_HOME=${home}/.paseo paseo daemon status --json 2>/dev/null || true); if paseo_ready "$paseo_status"; then return 0; fi; sleep 1; done; return 1; }`,
    `paseo_stop_runner() { paseo_pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' ${pidFile} 2>/dev/null | head -n 1); if [ -z "$paseo_pid" ]; then paseo_pid=$(cat ${pidFile} 2>/dev/null | tr -cd '0-9'); fi; if [ -n "$paseo_pid" ]; then paseo_args=$(ps -o args= -p "$paseo_pid" 2>/dev/null || true); if printf '%s' "$paseo_args" | grep -Eq 'daemon-runner|Paseo Supervisor|paseo daemon start'; then pkill -TERM -P "$paseo_pid" 2>/dev/null || true; kill "$paseo_pid" 2>/dev/null || true; sleep 1; pkill -KILL -P "$paseo_pid" 2>/dev/null || true; kill -KILL "$paseo_pid" 2>/dev/null || true; fi; fi; rm -f ${pidFile} ${runtimePidFile} ${daemonLog}; }`,
    `if ! paseo_wait_ready; then`,
    `  paseo_stop_runner`,
    `  PASEO_HOME=${home}/.paseo paseo daemon start --listen 0.0.0.0:6767`,
    `  if ! paseo_wait_ready; then`,
    `    paseo_stop_runner`,
    `    PASEO_HOME=${home}/.paseo paseo daemon start --listen 0.0.0.0:6767`,
    `    paseo_wait_ready`,
    `  fi`,
    `fi`,
    ...buildRuntimeObserverLines(workspace),
  ];
}

export function renderDockerWorkspace(workspace: WorkspaceSpec): string {
  const project = workspace.identity.projectName;
  const serviceName = project;
  const containerName = `${project}-docker`;
  const workspaceDataVolume = renderDockerWorkspaceDataVolume(workspace);
  const workspaceRuntimeVolume = resolveDockerVolume({
    fallbackName: `${project}-workspace-runtime-state`,
    source: workspace.attachments.workspaceRuntimeState.source,
  });
  const userScope = workspace.userProfile.id.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const identityVolume = resolveDockerVolume({
    fallbackName: `polaris-${userScope}-identity`,
    source: workspace.attachments.userIdentityState.source,
  });
  const sshVolume = resolveDockerVolume({
    fallbackName: `polaris-${userScope}-ssh`,
    source: workspace.attachments.userSshState.source,
  });
  const home = workspace.runtime.home;
  const toolRoot = persistentPolarisToolRoot(workspace);
  const xdg = codexXdgRoots(workspace);
  const imageToolRoot = `${home}/.local/polaris`;
  const authBootstrapLines = workspace.runtime.authFiles.flatMap((file) => {
    const content = file.content ?? "";
    const encoded = Buffer.from(content, "utf8").toString("base64");
    if (file.mountPath.includes("/.codex/")) {
      const name = file.mountPath.split("/").pop();
      return name
        ? [
            `if [ ! -f /identity/codex/${name} ]; then python3 -c ${q(`import base64, pathlib; path = pathlib.Path("/identity/codex/${name}"); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(base64.b64decode(${JSON.stringify(encoded)}));`)}; fi`,
            ...(workspace.runtime.user === "root" ? [`chown root:root /identity/codex/${name} || true`] : []),
            `chmod 600 /identity/codex/${name}`,
          ]
        : [];
    }
    if (file.mountPath.includes("/.claude/")) {
      const name = file.mountPath.split("/").pop();
      return name
        ? [
            `if [ ! -f /identity/claude/${name} ]; then python3 -c ${q(`import base64, pathlib; path = pathlib.Path("/identity/claude/${name}"); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(base64.b64decode(${JSON.stringify(encoded)}));`)}; fi`,
            ...(workspace.runtime.user === "root" ? [`chown root:root /identity/claude/${name} || true`] : []),
            `chmod 600 /identity/claude/${name}`,
          ]
        : [];
    }
    if (file.mountPath.includes("/.ssh/")) {
      const name = file.mountPath.split("/").pop();
      return name
        ? [
            `${workspace.userProfile.ssh.mode === "provided-key" ? "" : `if [ ! -f /ssh/${name} ]; then `}python3 -c ${q(`import base64, pathlib; path = pathlib.Path("/ssh/${name}"); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(base64.b64decode(${JSON.stringify(encoded)}));`)};${workspace.userProfile.ssh.mode === "provided-key" ? "" : " fi"}`,
            ...(workspace.runtime.user === "root" ? [`chown root:root /ssh/${name} || true`] : []),
            `chmod 600 /ssh/${name} || true`,
          ]
        : [];
    }
    return [];
  });
  const bootstrap = [
    "set -eux",
    `mkdir -p ${home}`,
    `chmod 755 ${home}`,
    ...(workspace.runtime.bootstrapProfile === "prebuilt"
      ? []
      : [
          `apt-get update && apt-get install -y openssh-client ca-certificates curl git nodejs npm procps python3 ${workspace.runtime.aptPackages.join(" ")} && rm -rf /var/lib/apt/lists/*`,
          ...(workspace.runtime.installRustup
            ? ["curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"]
            : []),
          ...buildAgentCliInstallLines(workspace),
        ]),
    `mkdir -p ${workspace.attachments.workspaceData.mountRoot} ${workspace.attachments.workspaceRuntimeState.mountRoot}/paseo ${workspace.attachments.workspaceRuntimeState.mountRoot}/paseo/evolution ${toolRoot} ${workspace.attachments.userIdentityState.mountRoot}/codex ${workspace.attachments.userIdentityState.mountRoot}/claude ${xdg.config} ${xdg.data} ${xdg.state} ${workspace.attachments.userSshState.mountRoot} ${workspace.attachments.ephemeralRuntime.mountRoot}/tmp ${workspace.attachments.ephemeralRuntime.mountRoot}/pids ${workspace.attachments.ephemeralRuntime.mountRoot}/sockets ${home}/.local /tmp/npm-cache`,
    ...(workspace.runtime.user === "root"
      ? [`chown -R root:root ${workspace.attachments.workspaceData.mountRoot} ${workspace.attachments.workspaceRuntimeState.mountRoot} ${workspace.attachments.userIdentityState.mountRoot} ${workspace.attachments.userSshState.mountRoot} ${workspace.attachments.ephemeralRuntime.mountRoot}`]
      : []),
    `if [ ! -x ${toolRoot}/bin/paseo ] && [ -x ${imageToolRoot}/bin/paseo ] && [ ! -L ${imageToolRoot} ]; then cp -a ${imageToolRoot}/. ${toolRoot}/; fi`,
    `rm -rf ${home}/.codex ${home}/.claude ${home}/.paseo ${home}/.ssh ${home}/workspace`,
    `ln -sfn ${workspace.attachments.userIdentityState.mountRoot}/codex ${home}/.codex`,
    `ln -sfn ${workspace.attachments.userIdentityState.mountRoot}/claude ${home}/.claude`,
    `ln -sfn ${workspace.attachments.workspaceRuntimeState.mountRoot}/paseo ${home}/.paseo`,
    `ln -sfn ${workspace.attachments.userSshState.mountRoot} ${home}/.ssh`,
    `ln -sfn ${workspace.attachments.workspaceData.mountRoot} ${home}/workspace`,
    `ln -sfn ${toolRoot} ${home}/.local/polaris`,
    ...buildAgentCliWrapperLines(workspace),
    ...(workspace.profile.workspaceAlias ? [`ln -sfn ${workspace.attachments.workspaceData.mountRoot} ${home}/${workspace.profile.workspaceAlias}`] : []),
    ...authBootstrapLines,
    ...(workspace.userProfile.ssh.mode === "managed-key"
      ? [
          `if [ ! -f /ssh/id_ed25519 ]; then ssh-keygen -q -t ed25519 -C ${workspace.userProfile.ssh.comment} -N '' -f /ssh/id_ed25519; fi`,
          "chmod 400 /ssh/id_ed25519 || true",
          "chmod 644 /ssh/id_ed25519.pub || true",
        ]
      : [
          "test -f /ssh/id_ed25519",
          "chmod 400 /ssh/id_ed25519 || true",
          "if [ -f /ssh/id_ed25519.pub ]; then chmod 644 /ssh/id_ed25519.pub || true; fi",
        ]),
    ...buildGitHubKnownHostsLines(),
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

  return `services:
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
    volumes:
${workspaceDataVolume.mountBlock.join("\n")}
      - type: volume
        source: ${workspaceRuntimeVolume.key}
        target: /workspace/state
      - type: volume
        source: ${identityVolume.key}
        target: /identity
      - type: volume
        source: ${sshVolume.key}
        target: /ssh
    tmpfs:
      - /run/workspace

volumes:
${workspaceDataVolume.volumeBlock.join("\n")}
  ${workspaceRuntimeVolume.key}:
    name: ${workspaceRuntimeVolume.name}
  ${identityVolume.key}:
    name: ${identityVolume.name}
  ${sshVolume.key}:
    name: ${sshVolume.name}
`;
}

export function renderAndWriteDockerWorkspace(workspace: WorkspaceSpec): string {
  return writeGeneratedManifest(workspace, renderDockerWorkspace(workspace));
}
