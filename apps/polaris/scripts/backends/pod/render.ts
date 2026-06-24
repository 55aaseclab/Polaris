import type { AuthFile, PlainEnvVar, ServicePort, WorkspaceSpec } from "../../core/workspace.js";
import {
  isNetfsSource,
  netfsResolvedPath,
  requireNetfsField,
} from "../../core/netfs.js";
import { writeGeneratedManifest } from "../../output/write-generated.js";

function q(value: string): string {
  return JSON.stringify(value);
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function relativeRuntimePath(filePath: string, home: string): string {
  if (filePath.startsWith(`${home}/.codex/`)) {
    return `codex/${filePath.slice(`${home}/.codex/`.length)}`;
  }
  if (filePath.startsWith(`${home}/.claude/`)) {
    return `claude/${filePath.slice(`${home}/.claude/`.length)}`;
  }
  if (filePath.startsWith(`${home}/.ssh/`)) {
    return filePath.slice(`${home}/.ssh/`.length);
  }
  return filePath.replace(/^\/+/, "");
}

function authFileStorageTarget(file: AuthFile, workspace: WorkspaceSpec): string {
  const home = workspace.runtime.home;
  if (file.mountPath.startsWith(`${home}/.codex/`) || file.mountPath.startsWith(`${home}/.claude/`)) {
    return `${workspace.attachments.userIdentityState.mountRoot}/${relativeRuntimePath(file.mountPath, home)}`;
  }
  if (file.mountPath.startsWith(`${home}/.ssh/`)) {
    return `${workspace.attachments.userSshState.mountRoot}/${relativeRuntimePath(file.mountPath, home)}`;
  }
  return file.mountPath;
}

function buildAttachmentAssemblyLines(workspace: WorkspaceSpec): string[] {
  const home = workspace.runtime.home;
  const user = workspace.runtime.user;
  const projectRoot = workspace.attachments.workspaceData.mountRoot;
  const paseoRoot = `${workspace.attachments.workspaceRuntimeState.mountRoot}/paseo`;
  const evolutionRoot = `${paseoRoot}/evolution`;
  const toolRoot = `${workspace.attachments.workspaceRuntimeState.mountRoot}/tooling/polaris`;
  const identityRoot = workspace.attachments.userIdentityState.mountRoot;
  const codexXdgRoot = `${identityRoot}/codex-xdg`;
  const sshRoot = workspace.attachments.userSshState.mountRoot;
  const runtimeRoot = workspace.attachments.ephemeralRuntime.mountRoot;
  return [
    `          mkdir -p ${projectRoot} ${workspace.attachments.workspaceRuntimeState.mountRoot} ${paseoRoot} ${evolutionRoot} ${toolRoot} ${identityRoot}/codex ${identityRoot}/claude ${codexXdgRoot}/config ${codexXdgRoot}/data ${codexXdgRoot}/state ${sshRoot} ${runtimeRoot}/tmp ${runtimeRoot}/pids ${runtimeRoot}/sockets ${home}/.local /tmp/npm-cache && \\`,
    `          chown -R ${user}:${user} ${projectRoot} ${workspace.attachments.workspaceRuntimeState.mountRoot} ${identityRoot} ${sshRoot} ${runtimeRoot} && \\`,
    `          rm -rf ${home}/.codex ${home}/.claude ${home}/.paseo ${home}/.ssh ${home}/workspace && \\`,
    `          ln -sfn ${identityRoot}/codex ${home}/.codex && \\`,
    `          ln -sfn ${identityRoot}/claude ${home}/.claude && \\`,
    `          ln -sfn ${paseoRoot} ${home}/.paseo && \\`,
    `          ln -sfn ${sshRoot} ${home}/.ssh && \\`,
    `          if [ ! -x ${toolRoot}/bin/paseo ] && [ -x ${home}/.local/polaris/bin/paseo ] && [ ! -L ${home}/.local/polaris ]; then cp -a ${home}/.local/polaris/. ${toolRoot}/; fi && \\`,
    `          ln -sfn ${toolRoot} ${home}/.local/polaris && \\`,
    `          ln -sfn ${projectRoot} ${home}/workspace && \\`,
    ...(workspace.profile.workspaceAlias ? [`          ln -sfn ${projectRoot} ${home}/${workspace.profile.workspaceAlias} && \\`] : []),
  ];
}

function buildRootProfileFixLine(workspace: WorkspaceSpec): string[] {
  const home = workspace.runtime.home;
  const toolRoot = `${home}/.local/polaris`;
  const codexXdgRoot = `${workspace.attachments.userIdentityState.mountRoot}/codex-xdg`;
  return [
    "          profile_fix_needed=0 && \\",
    `          [ -f ${home}/.profile ] || profile_fix_needed=1 && \\`,
    `          for rc in ${home}/.profile ${home}/.bashrc ${home}/.zshrc; do [ -f "$rc" ] || continue; grep -Eq "/root/root/\\\\.cargo/env|\\\\$HOME/root/\\\\.cargo/env|^\\. \\"\\\\$HOME/\\\\.cargo/env\\"$|^source \\"\\\\$HOME/\\\\.cargo/env\\"$" "$rc" && profile_fix_needed=1 && break; done && \\`,
    `          if [ "$profile_fix_needed" = 1 ]; then touch ${home}/.profile && for rc in ${home}/.profile ${home}/.bashrc ${home}/.zshrc; do [ -f "$rc" ] || continue; awk 'BEGIN{seen=0} { if ($0 ~ /\\/root\\/root\\/\\.cargo\\/env/ || $0 ~ /\\$HOME\\/root\\/\\.cargo\\/env/) { if (!seen) print "[ -f \\"$HOME/.cargo/env\\" ] && . \\"$HOME/.cargo/env\\""; seen=1; next } if ($0 == ". \\"$HOME/.cargo/env\\"" || $0 == "source \\"$HOME/.cargo/env\\"" || $0 == "[ -f \\"$HOME/.cargo/env\\" ] && . \\"$HOME/.cargo/env\\"") { if (!seen) print "[ -f \\"$HOME/.cargo/env\\" ] && . \\"$HOME/.cargo/env\\""; seen=1; next } print } END{ if (ARGV[1] ~ /\\.profile$/ && !seen) print "[ -f \\"$HOME/.cargo/env\\" ] && . \\"$HOME/.cargo/env\\"" }' "$rc" > "$rc.tmp" && mv "$rc.tmp" "$rc"; done; fi && \\`,
    `          printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'export PATH=${toolRoot}/bin:$PATH' 'export CODEX_HOME=${home}/.codex' 'export XDG_CONFIG_HOME=${codexXdgRoot}/config' 'export XDG_DATA_HOME=${codexXdgRoot}/data' 'export XDG_STATE_HOME=${codexXdgRoot}/state' 'mkdir -p ${home}/.codex ${codexXdgRoot}/config ${codexXdgRoot}/data ${codexXdgRoot}/state /tmp/npm-cache' 'exec ${toolRoot}/bin/codex \"$@\"' > /usr/local/bin/codex && chmod 755 /usr/local/bin/codex && \\`,
    `          printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'export PATH=${toolRoot}/bin:$PATH' 'export NPM_CONFIG_PREFIX=${toolRoot}' 'export npm_config_cache=/tmp/npm-cache' 'mkdir -p /tmp/npm-cache' 'exec ${toolRoot}/bin/claude \"$@\"' > /usr/local/bin/claude && chmod 755 /usr/local/bin/claude && \\`,
    `          if [ ! -L /usr/local/bin/pnpm ] || [ "$(readlink /usr/local/bin/pnpm 2>/dev/null)" != "${toolRoot}/bin/pnpm" ]; then ln -sf ${toolRoot}/bin/pnpm /usr/local/bin/pnpm; fi && \\`,
  ];
}

function buildAgentDirsLine(user: string, home: string): string[] {
  return [
    `          mkdir -p ${home} && \\`,
    `          chown ${user}:${user} ${home} && \\`,
    `          chmod 755 ${home} && \\`,
  ];
}

function buildAuthCopyLines(user: string, authFiles: AuthFile[], workspace: WorkspaceSpec): string[] {
  return authFiles.flatMap((item) => {
    const content = item.content ?? "";
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const target = authFileStorageTarget(item, workspace);
    const parent = target.replace(/\/[^/]+$/, "");
    return [
      `          if [ ! -f ${target} ]; then python3 -c ${q(`import base64, pathlib; path = pathlib.Path(${JSON.stringify(target)}); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(base64.b64decode(${JSON.stringify(encoded)}));`)}; fi && chown ${user}:${user} ${parent} ${target} && chmod 600 ${target} && \\`,
    ];
  });
}

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
      `          python3 -c ${q(`import base64, pathlib; path = pathlib.Path(${JSON.stringify(filePath)}); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(base64.b64decode(${JSON.stringify(encoded)}));`)} && \\`,
    ];
  });
}

function buildSshKeygenLine(user: string, workspace: WorkspaceSpec): string[] {
  const sshDir = workspace.attachments.userSshState.mountRoot;
  const keyPath = `${sshDir}/id_ed25519`;
  if (workspace.userProfile.ssh.mode === "provided-key") {
    if (user === "root") {
      return [
        `          mkdir -p ${sshDir} && chown root:root ${sshDir} && chmod 700 ${sshDir} && \\`,
        `          test -f ${keyPath} && \\`,
        `          chown root:root ${keyPath} 2>/dev/null || true && chmod 400 ${keyPath} 2>/dev/null || true && \\`,
        `          if [ -e ${keyPath}.pub ]; then chown root:root ${keyPath}.pub 2>/dev/null || true; chmod 644 ${keyPath}.pub 2>/dev/null || true; fi && \\`,
      ];
    }
    return [
      `          mkdir -p ${sshDir} && chown ${user}:${user} ${sshDir} && chmod 700 ${sshDir} && \\`,
      `          test -f ${keyPath} && \\`,
      `          chown ${user}:${user} ${keyPath} 2>/dev/null || true && chmod 600 ${keyPath} 2>/dev/null || true && \\`,
      `          if [ -e ${keyPath}.pub ]; then chown ${user}:${user} ${keyPath}.pub 2>/dev/null || true; chmod 644 ${keyPath}.pub 2>/dev/null || true; fi && \\`,
    ];
  }
  if (user === "root") {
    return [
      `          mkdir -p ${sshDir} && chown root:root ${sshDir} && chmod 700 ${sshDir} && \\`,
      `          if [ ! -f ${keyPath} ]; then ssh-keygen -q -t ed25519 -C ${workspace.userProfile.ssh.comment} -N '' -f ${keyPath}; fi && \\`,
      `          if [ -e ${keyPath} ] && { [ "$(stat -c %U:%G ${keyPath} 2>/dev/null || true)" != "root:root" ] || [ "$(stat -c %a ${keyPath} 2>/dev/null || true)" != "400" ]; }; then chown root:root ${keyPath} 2>/dev/null || true; chmod 400 ${keyPath} 2>/dev/null || true; fi && \\`,
      `          if [ -e ${keyPath}.pub ] && { [ "$(stat -c %U:%G ${keyPath}.pub 2>/dev/null || true)" != "root:root" ] || [ "$(stat -c %a ${keyPath}.pub 2>/dev/null || true)" != "644" ]; }; then chown root:root ${keyPath}.pub 2>/dev/null || true; chmod 644 ${keyPath}.pub 2>/dev/null || true; fi && \\`,
      `          for ssh_meta in ${sshDir}/authorized_keys ${sshDir}/known_hosts ${sshDir}/known_hosts.old; do if [ -e "$ssh_meta" ] && { [ "$(stat -c %U:%G "$ssh_meta" 2>/dev/null || true)" != "root:root" ] || [ "$(stat -c %a "$ssh_meta" 2>/dev/null || true)" != "600" ]; }; then chown root:root "$ssh_meta" 2>/dev/null || true; chmod 600 "$ssh_meta" 2>/dev/null || true; fi; done && \\`,
    ];
  }
  return [
    `          mkdir -p ${sshDir} && chown ${user}:${user} ${sshDir} && chmod 700 ${sshDir} && \\`,
    `          if [ ! -f ${keyPath} ]; then su - ${user} -c "mkdir -p ~/.ssh && chmod 700 ~/.ssh && ssh-keygen -q -t ed25519 -C ${workspace.userProfile.ssh.comment} -N '' -f ~/.ssh/id_ed25519"; fi && \\`,
    `          chown ${user}:${user} ${keyPath} ${keyPath}.pub && chmod 600 ${keyPath} && chmod 644 ${keyPath}.pub && \\`,
  ];
}

function buildPaseoBootstrapLine(enabled: boolean, home: string): string[] {
  if (!enabled) {
    return [];
  }
  return [
    `          paseo_status=$$(PASEO_HOME=${home}/.paseo paseo daemon status --json 2>/dev/null || true) && \\`,
    `          if ! printf '%s' "$$paseo_status" | grep -Eq '"localDaemon"[[:space:]]*:[[:space:]]*"running"' || ! printf '%s' "$$paseo_status" | grep -Eq '"connectedDaemon"[[:space:]]*:[[:space:]]*"reachable"'; then \\`,
    `            paseo_pid=$$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' ${home}/.paseo/paseo.pid 2>/dev/null | head -n 1) && \\`,
    `            if [ -z "$$paseo_pid" ]; then paseo_pid=$$(cat ${home}/.paseo/paseo.pid 2>/dev/null | tr -cd '0-9'); fi && \\`,
    `            if [ -n "$$paseo_pid" ] && ps -o args= -p "$$paseo_pid" 2>/dev/null | grep -Fq "daemon-runner"; then kill "$$paseo_pid" 2>/dev/null || true; sleep 1; fi && \\`,
    `            rm -f ${home}/.paseo/paseo.pid && \\`,
    `            rm -f ${home}/.paseo/daemon.log && \\`,
    `            PASEO_HOME=${home}/.paseo paseo daemon start --listen 0.0.0.0:6767 && \\`,
    "            sleep 2 && \\",
    `            paseo_status=$$(PASEO_HOME=${home}/.paseo paseo daemon status --json 2>/dev/null || true) && \\`,
    `            if ! printf '%s' "$$paseo_status" | grep -Eq '"localDaemon"[[:space:]]*:[[:space:]]*"running"' || ! printf '%s' "$$paseo_status" | grep -Eq '"connectedDaemon"[[:space:]]*:[[:space:]]*"reachable"'; then rm -f ${home}/.paseo/paseo.pid ${home}/.paseo/daemon.log && PASEO_HOME=${home}/.paseo paseo daemon start --listen 0.0.0.0:6767; fi; \\`,
    "          fi && \\",
  ];
}

function buildGitConfigLines(workspace: WorkspaceSpec): string[] {
  const lines: string[] = [];
  if (workspace.runtime.gitCoreEditor) {
    lines.push(`          git config --global core.editor ${workspace.runtime.gitCoreEditor} && \\`);
  }
  lines.push("          git config --global pull.rebase true && \\");
  if (workspace.runtime.gitUserName) {
    lines.push(`          git config --global user.name ${q(workspace.runtime.gitUserName)} && \\`);
  }
  if (workspace.runtime.gitUserEmail) {
    lines.push(`          git config --global user.email ${workspace.runtime.gitUserEmail} && \\`);
  }
  return lines;
}

function buildBootstrap(workspace: WorkspaceSpec): string[] {
  const home = workspace.runtime.home;
  const user = workspace.runtime.user;
  if (workspace.runtime.bootstrapProfile === "prebuilt") {
    return [
      "          set -eux && \\",
      ...buildAgentDirsLine(user, home),
      ...buildAttachmentAssemblyLines(workspace),
      ...(user === "root" ? buildRootProfileFixLine(workspace) : []),
      ...buildGitConfigLines(workspace),
      ...buildAuthCopyLines(user, workspace.runtime.authFiles, workspace),
      ...buildEvolutionBootstrapLines(workspace),
      ...buildSshKeygenLine(user, workspace),
      ...buildPaseoBootstrapLine(Boolean(workspace.runtime.agentCmd), home),
      "          touch /tmp/.ready && sleep infinity",
    ];
  }
  return [
    "          set -eux && \\",
    ...buildAgentDirsLine(user, home),
    ...buildAttachmentAssemblyLines(workspace),
    `          apt-get update && apt-get install -y openssh-client ${workspace.runtime.aptPackages.join(" ")} && \\`,
    ...buildAuthCopyLines(user, workspace.runtime.authFiles, workspace),
    ...buildEvolutionBootstrapLines(workspace),
    ...buildSshKeygenLine(user, workspace),
    ...buildPaseoBootstrapLine(Boolean(workspace.runtime.agentCmd), home),
    "          touch /tmp/.ready && sleep infinity",
  ];
}

function buildReadinessProbe(workspace: WorkspaceSpec): string[] {
  if (workspace.health.readinessMode === "daemon-port") {
    return [
      "        readinessProbe:",
      "          tcpSocket:",
      "            port: 6767",
      "          initialDelaySeconds: 5",
      "          timeoutSeconds: 5",
      "          periodSeconds: 5",
      "          failureThreshold: 60",
    ];
  }
  return [
    "        readinessProbe:",
    "          exec:",
    '            command: ["sh", "-ec", "test -f /tmp/.ready"]',
    "          initialDelaySeconds: 5",
    "          timeoutSeconds: 5",
    "          periodSeconds: 5",
    "          failureThreshold: 60",
  ];
}

function buildEnvLines(workspace: WorkspaceSpec): string[] {
  const envLines: string[] = [];
  for (const item of workspace.runtime.plainEnvVars as PlainEnvVar[]) {
    envLines.push(`        - name: ${item.name}`);
    envLines.push(`          value: ${q(item.value)}`);
  }
  if (workspace.runtime.agentCmd) {
    envLines.push("        - name: PASEO_HOME");
    envLines.push(`          value: ${q(`${workspace.runtime.home}/.paseo`)}`);
  }
  envLines.push("        - name: POLARIS_WORKSPACE_DATA_ROOT");
  envLines.push(`          value: ${q(workspace.attachments.workspaceData.mountRoot)}`);
  envLines.push("        - name: POLARIS_WORKSPACE_RUNTIME_ROOT");
  envLines.push(`          value: ${q(workspace.attachments.workspaceRuntimeState.mountRoot)}`);
  envLines.push("        - name: POLARIS_USER_IDENTITY_ROOT");
  envLines.push(`          value: ${q(workspace.attachments.userIdentityState.mountRoot)}`);
  envLines.push("        - name: POLARIS_USER_SSH_ROOT");
  envLines.push(`          value: ${q(workspace.attachments.userSshState.mountRoot)}`);
  envLines.push("        - name: POLARIS_EVOLUTION_ROOT");
  envLines.push(`          value: ${q(workspace.agent.runtime.evolutionRoot)}`);
  envLines.push("        - name: POLARIS_WORKSPACE_MEMORY_FILE");
  envLines.push(`          value: ${q(workspace.evolution?.workspaceMemoryFile ?? "")}`);
  envLines.push("        - name: POLARIS_USER_MEMORY_FILE");
  envLines.push(`          value: ${q(workspace.evolution?.userMemoryFile ?? "")}`);
  envLines.push("        - name: POLARIS_MEMORY_SNAPSHOT_FILE");
  envLines.push(`          value: ${q(workspace.evolution?.sessionSnapshotFile ?? "")}`);
  return envLines;
}

function serviceName(port: ServicePort, index: number): string {
  return port.name || (index === 0 ? "http" : `http-${index + 1}`);
}

function persistentVolumeClaims(workspace: WorkspaceSpec): Array<{
  name: string;
  size: string;
}> {
  const claims: Array<{ name: string; size: string }> = [];
  for (const attachment of [
    workspace.attachments.workspaceData,
    workspace.attachments.workspaceRuntimeState,
    workspace.attachments.userIdentityState,
    workspace.attachments.userSshState,
  ]) {
    if (attachment.source.kind !== "persistent-volume" || !attachment.source.volumeRef) {
      continue;
    }
    claims.push({
      name: attachment.source.volumeRef,
      size: attachment.source.volumeSize ?? workspace.resources.ephemeralStorage,
    });
  }
  return Array.from(new Map(claims.map((claim) => [claim.name, claim])).values());
}

export function renderPodWorkspace(workspace: WorkspaceSpec): string {
  const docs: string[] = [];
  docs.push(
    [
      `# Agent deployment: ${workspace.identity.projectName}`,
      `# Generated by polaris.ts on ${timestamp()}`,
      "",
      "apiVersion: v1",
      "kind: Namespace",
      "metadata:",
      `  name: ${workspace.identity.projectName}`,
    ].join("\n"),
  );

  for (const claim of persistentVolumeClaims(workspace)) {
    docs.push(
      [
        "apiVersion: v1",
        "kind: PersistentVolumeClaim",
        "metadata:",
        `  name: ${claim.name}`,
        `  namespace: ${workspace.identity.projectName}`,
        "spec:",
        "  accessModes:",
        "  - ReadWriteOnce",
        "  resources:",
        "    requests:",
        `      storage: ${q(claim.size)}`,
      ].join("\n"),
    );
  }

  const deploymentLines = [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    `  name: ${workspace.identity.projectName}`,
    `  namespace: ${workspace.identity.projectName}`,
    "spec:",
    "  progressDeadlineSeconds: 900",
    "  replicas: 1",
    "  strategy:",
    "    type: Recreate",
    "  selector:",
    "    matchLabels:",
    `      app: ${workspace.identity.projectName}`,
    "  template:",
    "    metadata:",
    "      labels:",
    `        app: ${workspace.identity.projectName}`,
    "    spec:",
    `      runtimeClassName: ${workspace.backend.profile}`,
    "      containers:",
    "      - name: agent",
    `        image: ${workspace.runtime.baseImage}`,
    '        command: ["/bin/sh", "-c"]',
    "        args:",
    "        - |",
    ...buildBootstrap(workspace),
    ...buildReadinessProbe(workspace),
  ];
  if (!workspace.resources.unbounded) {
    deploymentLines.push("        resources:");
    deploymentLines.push("          limits:");
    deploymentLines.push(`            memory: ${q(workspace.resources.memory)}`);
    deploymentLines.push(`            cpu: ${q(workspace.resources.cpu)}`);
    deploymentLines.push(`            ephemeral-storage: ${q(workspace.resources.ephemeralStorage)}`);
    if (workspace.resources.cpuRequest || workspace.resources.memoryRequest || workspace.resources.storageRequest) {
      deploymentLines.push("          requests:");
      if (workspace.resources.memoryRequest) deploymentLines.push(`            memory: ${q(workspace.resources.memoryRequest)}`);
      if (workspace.resources.cpuRequest) deploymentLines.push(`            cpu: ${q(workspace.resources.cpuRequest)}`);
      if (workspace.resources.storageRequest) deploymentLines.push(`            ephemeral-storage: ${q(workspace.resources.storageRequest)}`);
    }
  }
  deploymentLines.push("        volumeMounts:");
  deploymentLines.push("        - name: workspace-data");
  deploymentLines.push(`          mountPath: ${workspace.attachments.workspaceData.mountRoot}`);
  deploymentLines.push("        - name: workspace-runtime-state");
  deploymentLines.push(`          mountPath: ${workspace.attachments.workspaceRuntimeState.mountRoot}`);
  deploymentLines.push("        - name: user-identity-state");
  deploymentLines.push(`          mountPath: ${workspace.attachments.userIdentityState.mountRoot}`);
  deploymentLines.push("        - name: user-ssh-state");
  deploymentLines.push(`          mountPath: ${workspace.attachments.userSshState.mountRoot}`);
  deploymentLines.push("        - name: ephemeral-runtime");
  deploymentLines.push(`          mountPath: ${workspace.attachments.ephemeralRuntime.mountRoot}`);
  const envLines = buildEnvLines(workspace);
  if (envLines.length) {
    deploymentLines.push("        env:");
    deploymentLines.push(...envLines);
  }
  deploymentLines.push("      volumes:");
  deploymentLines.push("      - name: workspace-data");
  if (isNetfsSource(workspace.attachments.workspaceData.source)) {
    deploymentLines.push("        nfs:");
    deploymentLines.push(
      `          server: ${requireNetfsField(
        workspace.attachments.workspaceData.source.server,
        "server",
        "workspace-data",
      )}`,
    );
    deploymentLines.push(
      `          path: ${netfsResolvedPath(
        workspace.attachments.workspaceData.source,
      )}`,
    );
  } else if (workspace.attachments.workspaceData.source.kind === "persistent-volume") {
    deploymentLines.push("        persistentVolumeClaim:");
    deploymentLines.push(`          claimName: ${workspace.attachments.workspaceData.source.volumeRef ?? workspace.storage.claimName}`);
  } else {
    deploymentLines.push("        emptyDir: {}");
  }
  deploymentLines.push("      - name: workspace-runtime-state");
  if (workspace.attachments.workspaceRuntimeState.source.kind === "persistent-volume") {
    deploymentLines.push("        persistentVolumeClaim:");
    deploymentLines.push(`          claimName: ${workspace.attachments.workspaceRuntimeState.source.volumeRef ?? workspace.storage.claimName}`);
  } else {
    deploymentLines.push("        emptyDir: {}");
  }
  deploymentLines.push("      - name: user-identity-state");
  if (workspace.attachments.userIdentityState.source.kind === "persistent-volume") {
    deploymentLines.push("        persistentVolumeClaim:");
    deploymentLines.push(`          claimName: ${workspace.attachments.userIdentityState.source.volumeRef}`);
  } else {
    deploymentLines.push("        emptyDir: {}");
  }
  deploymentLines.push("      - name: user-ssh-state");
  if (workspace.attachments.userSshState.source.kind === "persistent-volume") {
    deploymentLines.push("        persistentVolumeClaim:");
    deploymentLines.push(`          claimName: ${workspace.attachments.userSshState.source.volumeRef}`);
  } else {
    deploymentLines.push("        emptyDir: {}");
  }
  deploymentLines.push("      - name: ephemeral-runtime");
  deploymentLines.push("        emptyDir: {}");
  docs.push(deploymentLines.join("\n"));

  if (workspace.connectivity.exposeService && workspace.connectivity.servicePorts.length) {
    const serviceLines = [
      "apiVersion: v1",
      "kind: Service",
      "metadata:",
      `  name: ${workspace.identity.projectName}`,
      `  namespace: ${workspace.identity.projectName}`,
      "spec:",
      `  type: ${workspace.connectivity.serviceMode === "nodeport" ? "NodePort" : "ClusterIP"}`,
      "  selector:",
      `    app: ${workspace.identity.projectName}`,
      "  ports:",
    ];
    workspace.connectivity.servicePorts.forEach((port, index) => {
      serviceLines.push(`  - name: ${serviceName(port, index)}`);
      serviceLines.push("    protocol: TCP");
      serviceLines.push(`    port: ${port.containerPort}`);
      serviceLines.push(`    targetPort: ${port.containerPort}`);
      serviceLines.push("    appProtocol: http");
      if (workspace.connectivity.serviceMode === "nodeport" && port.nodePort) {
        serviceLines.push(`    nodePort: ${port.nodePort}`);
      }
    });
    docs.push(serviceLines.join("\n"));
  }

  return `${docs.join("\n---\n")}\n`;
}

export function renderAndWritePodWorkspace(workspace: WorkspaceSpec): string {
  return writeGeneratedManifest(workspace, renderPodWorkspace(workspace));
}
