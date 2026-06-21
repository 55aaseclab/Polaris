import type { WorkspaceSpec } from "../../core/workspace.js";
import { writeGeneratedManifest } from "../../output/write-generated.js";

function q(value: string): string {
  return JSON.stringify(value);
}

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

export function renderDockerWorkspace(workspace: WorkspaceSpec): string {
  const project = workspace.identity.projectName;
  const serviceName = project;
  const containerName = `${project}-docker`;
  const workspaceDataVolume = `${project}-workspace-data`;
  const workspaceRuntimeVolume = `${project}-workspace-runtime-state`;
  const userScope = workspace.userProfile.id.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const identityVolume = `polaris-${userScope}-identity`;
  const sshVolume = `polaris-${userScope}-ssh`;
  const home = workspace.runtime.home;
  const bootstrapSecretsRoot = workspace.agent.bootstrapSecretsRoot;
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
      - ${workspaceDataVolume}:/workspace/project
      - ${workspaceRuntimeVolume}:/workspace/state
      - ${identityVolume}:/identity
      - ${sshVolume}:/ssh
      - \${POLARIS_SECRETS_DIR:-./${workspace.userProfile.secretsRoot}}:${bootstrapSecretsRoot}:ro
    tmpfs:
      - /run/workspace

volumes:
  ${workspaceDataVolume}: {}
  ${workspaceRuntimeVolume}: {}
  ${identityVolume}: {}
  ${sshVolume}: {}
`;
}

export function renderAndWriteDockerWorkspace(workspace: WorkspaceSpec): string {
  return writeGeneratedManifest(workspace, renderDockerWorkspace(workspace));
}
