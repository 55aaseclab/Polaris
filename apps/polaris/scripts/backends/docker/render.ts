import fs from "node:fs";
import path from "node:path";
import type { WorkspaceSpec } from "../../core/workspace.js";
import { writeGeneratedManifest } from "../../output/write-generated.js";

function q(value: string): string {
  return JSON.stringify(value);
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

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../../");

function secretMountSource(sourcePath: string | undefined, workspace: WorkspaceSpec): string | null {
  if (!sourcePath) {
    return null;
  }
  const relativeSource = sourcePath.startsWith(workspace.userProfile.secretsRoot)
    ? sourcePath.slice(workspace.userProfile.secretsRoot.length).replace(/^\/+/, "")
    : null;
  if (relativeSource) {
    return `${workspace.agent.bootstrapSecretsRoot}/${relativeSource}`;
  }
  const usersMarker = "/config/users/";
  const markerIndex = sourcePath.indexOf(usersMarker);
  if (markerIndex === -1) {
    return null;
  }
  const tail = sourcePath.slice(markerIndex + usersMarker.length).split("/").slice(1).join("/");
  return tail ? `${workspace.agent.bootstrapSecretsRoot}/${tail}` : null;
}

function buildEvolutionBootstrapLines(workspace: WorkspaceSpec): string[] {
  const filePath = workspace.evolution?.bootstrapContextFile;
  const content = workspace.evolution?.bootstrapContextContent;
  if (!filePath || !content) {
    return [];
  }
  const encoded = Buffer.from(content, "utf8").toString("base64");
  return [
    `python3 -c ${q(`import base64, pathlib; path = pathlib.Path(${JSON.stringify(filePath)}); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(base64.b64decode(${JSON.stringify(encoded)}));`)}`,
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
  const toolRoot = `${workspace.runtime.home}/.local/polaris`;
  return [
    `python3 -c ${q(`import base64, pathlib; path = pathlib.Path(${JSON.stringify(runtimePath)}); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(base64.b64decode(${JSON.stringify(encoded)}));`)}`,
    `chmod 755 ${runtimePath}`,
    `POLARIS_PROJECT=${q(workspace.identity.projectName)} POLARIS_USER_PROFILE_ID=${q(workspace.userProfile.id)} POLARIS_MANAGER_ID=${q(workspace.agent.managerId)} POLARIS_TOOL_ROOT=${q(toolRoot)} POLARIS_PASEO_DAEMON_URL=${q("ws://127.0.0.1:6767/ws")} PASEO_HOME=${workspace.runtime.home}/.paseo node ${runtimePath} > ${workspace.agent.runtime.evolutionRoot}/runtime-observer.log 2>&1 &`,
  ];
}

function bootstrapSecretsVolumeSource(workspace: WorkspaceSpec): string {
  const sourceRoot = workspace.userProfile.secretsRoot.replace(/^\.?\//, "");
  const relative = path.posix.relative("config/generated/docker", sourceRoot);
  if (!relative || relative === ".") {
    return ".";
  }
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function buildAgentCliInstallLines(home: string): string[] {
  const toolRoot = `${home}/.local/polaris`;
  return [
    `mkdir -p ${toolRoot} /tmp/npm-cache ${home}/.npm`,
    `npm_config_cache=/tmp/npm-cache npm install -g --prefix ${toolRoot} @getpaseo/cli@latest @openai/codex @anthropic-ai/claude-code @fission-ai/openspec@latest pnpm`,
    `ln -sf ${toolRoot}/bin/paseo /usr/local/bin/paseo`,
    `ln -sf ${toolRoot}/bin/pnpm /usr/local/bin/pnpm`,
    `printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'export CODEX_HOME=${home}/.codex' 'export NPM_CONFIG_PREFIX=${toolRoot}' 'export npm_config_cache=${home}/.npm' 'mkdir -p ${home}/.codex' 'exec ${toolRoot}/bin/codex \"$@\"' > /usr/local/bin/codex`,
    "chmod 755 /usr/local/bin/codex",
    `printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'export NPM_CONFIG_PREFIX=${toolRoot}' 'export npm_config_cache=${home}/.npm' 'exec ${toolRoot}/bin/claude \"$@\"' > /usr/local/bin/claude`,
    "chmod 755 /usr/local/bin/claude",
  ];
}

export function renderDockerWorkspace(workspace: WorkspaceSpec): string {
  const project = workspace.identity.projectName;
  const serviceName = project;
  const containerName = `${project}-docker`;
  const workspaceDataVolume = resolveDockerVolume({
    fallbackName: `${project}-workspace-data`,
    source: workspace.attachments.workspaceData.source,
  });
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
  const bootstrapSecretsRoot = workspace.agent.bootstrapSecretsRoot;
  const bootstrapSecretsSource = bootstrapSecretsVolumeSource(workspace);
  const authBootstrapLines = workspace.runtime.authFiles
    .map((file) => {
      const source = secretMountSource(file.sourcePath, workspace);
      if (!source) {
        return null;
      }
      if (file.mountPath.includes("/.codex/")) {
        return `if [ -f ${source} ]; then install -m 600 ${source} /identity/codex/${file.mountPath.split("/").pop()}; fi`;
      }
      if (file.mountPath.includes("/.claude/")) {
        return `if [ -f ${source} ]; then install -m 600 ${source} /identity/claude/${file.mountPath.split("/").pop()}; fi`;
      }
      if (file.mountPath.includes("/.ssh/")) {
        return `if [ -f ${source} ]; then install -m 600 ${source} /ssh/${file.mountPath.split("/").pop()}; fi`;
      }
      return null;
    })
    .filter((line): line is string => Boolean(line));
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
          ...buildAgentCliInstallLines(home),
        ]),
    `mkdir -p ${workspace.attachments.workspaceData.mountRoot} ${workspace.attachments.workspaceRuntimeState.mountRoot}/paseo ${workspace.attachments.workspaceRuntimeState.mountRoot}/paseo/evolution ${workspace.attachments.userIdentityState.mountRoot}/codex ${workspace.attachments.userIdentityState.mountRoot}/claude ${workspace.attachments.userSshState.mountRoot} ${workspace.attachments.ephemeralRuntime.mountRoot}/tmp ${workspace.attachments.ephemeralRuntime.mountRoot}/pids ${workspace.attachments.ephemeralRuntime.mountRoot}/sockets`,
    `rm -rf ${home}/.codex ${home}/.claude ${home}/.paseo ${home}/.ssh ${home}/workspace`,
    `ln -sfn ${workspace.attachments.userIdentityState.mountRoot}/codex ${home}/.codex`,
    `ln -sfn ${workspace.attachments.userIdentityState.mountRoot}/claude ${home}/.claude`,
    `ln -sfn ${workspace.attachments.workspaceRuntimeState.mountRoot}/paseo ${home}/.paseo`,
    `ln -sfn ${workspace.attachments.userSshState.mountRoot} ${home}/.ssh`,
    `ln -sfn ${workspace.attachments.workspaceData.mountRoot} ${home}/workspace`,
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
    ...workspace.runtime.plainEnvVars.map((envVar) => `export ${envVar.name}=${q(envVar.value)}`),
    ...buildEvolutionBootstrapLines(workspace),
    ...(workspace.agent.enabled
      ? [
          `rm -f ${home}/.paseo/paseo.pid ${workspace.attachments.ephemeralRuntime.mountRoot}/pids/paseo.pid`,
          `PASEO_HOME=${home}/.paseo paseo daemon start --listen 0.0.0.0:6767`,
          `paired=0; for i in $(seq 1 30); do PASEO_HOME=${home}/.paseo paseo daemon pair --json > ${home}/.paseo/pairing.json.tmp 2>/dev/null && mv ${home}/.paseo/pairing.json.tmp ${home}/.paseo/pairing.json && paired=1 && break; sleep 2; done; test "$$paired" = 1`,
          ...buildRuntimeObserverLines(workspace),
        ]
      : []),
    "touch /tmp/.ready",
    "sleep infinity",
  ].join("\n");
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
      POLARIS_EVOLUTION_CONTEXT_FILE: ${workspace.evolution?.bootstrapContextFile ?? ""}
    volumes:
      - type: volume
        source: ${workspaceDataVolume.key}
        target: /workspace/project
      - type: volume
        source: ${workspaceRuntimeVolume.key}
        target: /workspace/state
      - type: volume
        source: ${identityVolume.key}
        target: /identity
      - type: volume
        source: ${sshVolume.key}
        target: /ssh
      - \${POLARIS_SECRETS_DIR:-${bootstrapSecretsSource}}:${bootstrapSecretsRoot}:ro
    tmpfs:
      - /run/workspace

volumes:
  ${workspaceDataVolume.key}:
    name: ${workspaceDataVolume.name}
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
