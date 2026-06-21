import type { AuthFile, PlainEnvVar, ServicePort, WorkspaceSpec } from "../../core/workspace.js";
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
  const identityRoot = workspace.attachments.userIdentityState.mountRoot;
  const sshRoot = workspace.attachments.userSshState.mountRoot;
  const runtimeRoot = workspace.attachments.ephemeralRuntime.mountRoot;
  return [
    `          mkdir -p ${projectRoot} ${workspace.attachments.workspaceRuntimeState.mountRoot} ${paseoRoot} ${evolutionRoot} ${identityRoot}/codex ${identityRoot}/claude ${sshRoot} ${runtimeRoot}/tmp ${runtimeRoot}/pids ${runtimeRoot}/sockets && \\`,
    `          chown -R ${user}:${user} ${projectRoot} ${workspace.attachments.workspaceRuntimeState.mountRoot} ${identityRoot} ${sshRoot} ${runtimeRoot} && \\`,
    `          rm -rf ${home}/.codex ${home}/.claude ${home}/.paseo ${home}/.ssh && \\`,
    `          ln -sfn ${identityRoot}/codex ${home}/.codex && \\`,
    `          ln -sfn ${identityRoot}/claude ${home}/.claude && \\`,
    `          ln -sfn ${paseoRoot} ${home}/.paseo && \\`,
    `          ln -sfn ${sshRoot} ${home}/.ssh && \\`,
    `          ln -sfn ${projectRoot} ${home}/workspace && \\`,
    ...(workspace.profile.workspaceAlias ? [`          ln -sfn ${projectRoot} ${home}/${workspace.profile.workspaceAlias} && \\`] : []),
  ];
}

function buildRootProfileFixLine(home: string): string[] {
  return [
    "          profile_fix_needed=0 && \\",
    `          [ -f ${home}/.profile ] || profile_fix_needed=1 && \\`,
    `          for rc in ${home}/.profile ${home}/.bashrc ${home}/.zshrc; do [ -f "$rc" ] || continue; grep -Eq "/root/root/\\\\.cargo/env|\\\\$HOME/root/\\\\.cargo/env|^\\. \\"\\\\$HOME/\\\\.cargo/env\\"$|^source \\"\\\\$HOME/\\\\.cargo/env\\"$" "$rc" && profile_fix_needed=1 && break; done && \\`,
    `          if [ "$profile_fix_needed" = 1 ]; then touch ${home}/.profile && for rc in ${home}/.profile ${home}/.bashrc ${home}/.zshrc; do [ -f "$rc" ] || continue; awk 'BEGIN{seen=0} { if ($0 ~ /\\/root\\/root\\/\\.cargo\\/env/ || $0 ~ /\\$HOME\\/root\\/\\.cargo\\/env/) { if (!seen) print "[ -f \\"$HOME/.cargo/env\\" ] && . \\"$HOME/.cargo/env\\""; seen=1; next } if ($0 == ". \\"$HOME/.cargo/env\\"" || $0 == "source \\"$HOME/.cargo/env\\"" || $0 == "[ -f \\"$HOME/.cargo/env\\" ] && . \\"$HOME/.cargo/env\\"") { if (!seen) print "[ -f \\"$HOME/.cargo/env\\" ] && . \\"$HOME/.cargo/env\\""; seen=1; next } print } END{ if (ARGV[1] ~ /\\.profile$/ && !seen) print "[ -f \\"$HOME/.cargo/env\\" ] && . \\"$HOME/.cargo/env\\"" }' "$rc" > "$rc.tmp" && mv "$rc.tmp" "$rc"; done; fi && \\`,
    `          if [ ! -L /usr/local/bin/pnpm ] || [ "$(readlink /usr/local/bin/pnpm 2>/dev/null)" != "/opt/agent-cli/bin/pnpm" ]; then ln -sf /opt/agent-cli/bin/pnpm /usr/local/bin/pnpm; fi && \\`,
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
      `          python3 -c ${q(`import base64, pathlib; path = pathlib.Path(${JSON.stringify(target)}); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(base64.b64decode(${JSON.stringify(encoded)}));`)} && chown ${user}:${user} ${parent} ${target} && chmod 600 ${target} && \\`,
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
    `          rm -f ${home}/.paseo/paseo.pid && \\`,
    "          echo 'starting paseo daemon' && \\",
    `          PASEO_HOME=${home}/.paseo paseo daemon start --listen 0.0.0.0:6767 && \\`,
    "          echo 'pairing paseo daemon' && \\",
    `          paired=0; for i in $(seq 1 30); do PASEO_HOME=${home}/.paseo paseo daemon pair --json > ${home}/.paseo/pairing.json.tmp 2>/dev/null && mv ${home}/.paseo/pairing.json.tmp ${home}/.paseo/pairing.json && paired=1 && break; sleep 2; done; test "$paired" = 1 && \\`,
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
      ...(user === "root" ? buildRootProfileFixLine(home) : []),
      ...buildGitConfigLines(workspace),
      ...buildAuthCopyLines(user, workspace.runtime.authFiles, workspace),
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
  return envLines;
}

function serviceName(port: ServicePort, index: number): string {
  return port.name || (index === 0 ? "http" : `http-${index + 1}`);
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

  if (workspace.attachments.workspaceData.source.kind === "persistent-volume") {
    docs.push(
      [
        "apiVersion: v1",
        "kind: PersistentVolumeClaim",
        "metadata:",
        `  name: ${workspace.attachments.workspaceData.source.volumeRef ?? workspace.storage.claimName}`,
        `  namespace: ${workspace.identity.projectName}`,
        "spec:",
        "  accessModes:",
        "  - ReadWriteOnce",
        "  resources:",
        "    requests:",
        `      storage: ${q(workspace.resources.ephemeralStorage)}`,
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
  if (workspace.attachments.workspaceData.source.kind === "persistent-volume") {
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
  deploymentLines.push("        emptyDir: {}");
  deploymentLines.push("      - name: user-ssh-state");
  deploymentLines.push("        emptyDir: {}");
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
