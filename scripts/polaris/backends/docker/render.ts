import type { WorkspaceSpec } from "../../core/workspace.js";
import { writeGeneratedManifest } from "../../output/write-generated.js";

function q(value: string): string {
  return JSON.stringify(value);
}

export function renderDockerWorkspace(workspace: WorkspaceSpec): string {
  const project = workspace.identity.projectName;
  const serviceName = project;
  const containerName = `${project}-docker`;
  const workspaceDataVolume = `${project}-workspace-data`;
  const workspaceRuntimeVolume = `${project}-workspace-runtime-state`;
  const identityVolume = "polaris-user-identity";
  const sshVolume = "polaris-user-ssh";
  const bootstrap = [
    "set -eux",
    "mkdir -p /root",
    "chmod 755 /root",
    "mkdir -p /workspace/project /workspace/state/paseo /identity/codex /identity/claude /ssh /run/workspace/tmp /run/workspace/pids /run/workspace/sockets",
    "rm -rf /root/.codex /root/.claude /root/.paseo /root/.ssh /root/workspace",
    "ln -sfn /identity/codex /root/.codex",
    "ln -sfn /identity/claude /root/.claude",
    "ln -sfn /workspace/state/paseo /root/.paseo",
    "ln -sfn /ssh /root/.ssh",
    "ln -sfn /workspace/project /root/workspace",
    "if [ -f /bootstrap-secrets/codex/auth.json ]; then install -m 600 /bootstrap-secrets/codex/auth.json /identity/codex/auth.json; fi",
    "if [ -f /bootstrap-secrets/codex/config.toml ]; then install -m 600 /bootstrap-secrets/codex/config.toml /identity/codex/config.toml; fi",
    "if [ -f /bootstrap-secrets/claude/settings.json ]; then install -m 600 /bootstrap-secrets/claude/settings.json /identity/claude/settings.json; fi",
    `if [ ! -f /ssh/id_ed25519 ]; then ssh-keygen -q -t ed25519 -C ${workspace.profile.sshKeyComment} -N '' -f /ssh/id_ed25519; fi`,
    "chmod 400 /ssh/id_ed25519 || true",
    "chmod 644 /ssh/id_ed25519.pub || true",
    "rm -f /root/.paseo/paseo.pid",
    "PASEO_HOME=/root/.paseo paseo daemon start --listen 0.0.0.0:6767",
    "paired=0; for i in $(seq 1 30); do PASEO_HOME=/root/.paseo paseo daemon pair --json > /root/.paseo/pairing.json.tmp 2>/dev/null && mv /root/.paseo/pairing.json.tmp /root/.paseo/pairing.json && paired=1 && break; sleep 2; done; test \"$$paired\" = 1",
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
    volumes:
      - ${workspaceDataVolume}:/workspace/project
      - ${workspaceRuntimeVolume}:/workspace/state
      - ${identityVolume}:/identity
      - ${sshVolume}:/ssh
      - \${MORPHEUS_SECRETS_DIR:-./secrets/polaris}:/bootstrap-secrets:ro
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
