import type { AuthFile, PlainEnvVar, ServicePort, WorkspaceSpec } from "../../core/workspace.js";
import { writeGeneratedManifest } from "../../output/write-generated.js";

function q(value: string): string {
  return JSON.stringify(value);
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function indent(lines: string[], spaces: number): string[] {
  const prefix = " ".repeat(spaces);
  return lines.map((line) => `${prefix}${line}`);
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
    `          mkdir -p ${home} ${home}/.codex ${home}/.claude ${home}/.paseo && \\`,
    `          chown ${user}:${user} ${home} ${home}/.codex ${home}/.claude ${home}/.paseo && \\`,
    `          chmod 755 ${home} && chmod 755 ${home}/.codex && chmod 755 ${home}/.claude && chmod 700 ${home}/.paseo && \\`,
  ];
}

function buildAuthCopyLines(user: string, authFiles: AuthFile[]): string[] {
  return authFiles.flatMap((item) => {
    const content = item.content ?? "";
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const parent = item.mountPath.replace(/\/[^/]+$/, "");
    return [
      `          python3 -c ${q(`import base64, pathlib; path = pathlib.Path(${JSON.stringify(item.mountPath)}); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(base64.b64decode(${JSON.stringify(encoded)}));`)} && chown ${user}:${user} ${parent} ${item.mountPath} && chmod 600 ${item.mountPath} && \\`,
    ];
  });
}

function buildSshKeygenLine(user: string, home: string): string[] {
  const sshDir = `${home}/.ssh`;
  const keyPath = `${sshDir}/id_ed25519`;
  if (user === "root") {
    return [
      `          mkdir -p ${sshDir} && chown root:root ${sshDir} && chmod 700 ${sshDir} && \\`,
      `          if [ ! -f ${keyPath} ]; then ssh-keygen -q -t ed25519 -C morpheus@agent-vault -N '' -f ${keyPath}; fi && \\`,
      `          if [ -e ${keyPath} ] && { [ "$(stat -c %U:%G ${keyPath} 2>/dev/null || true)" != "root:root" ] || [ "$(stat -c %a ${keyPath} 2>/dev/null || true)" != "400" ]; }; then chown root:root ${keyPath} 2>/dev/null || true; chmod 400 ${keyPath} 2>/dev/null || true; fi && \\`,
      `          if [ -e ${keyPath}.pub ] && { [ "$(stat -c %U:%G ${keyPath}.pub 2>/dev/null || true)" != "root:root" ] || [ "$(stat -c %a ${keyPath}.pub 2>/dev/null || true)" != "644" ]; }; then chown root:root ${keyPath}.pub 2>/dev/null || true; chmod 644 ${keyPath}.pub 2>/dev/null || true; fi && \\`,
      `          for ssh_meta in ${sshDir}/authorized_keys ${sshDir}/known_hosts ${sshDir}/known_hosts.old; do if [ -e "$ssh_meta" ] && { [ "$(stat -c %U:%G "$ssh_meta" 2>/dev/null || true)" != "root:root" ] || [ "$(stat -c %a "$ssh_meta" 2>/dev/null || true)" != "600" ]; }; then chown root:root "$ssh_meta" 2>/dev/null || true; chmod 600 "$ssh_meta" 2>/dev/null || true; fi; done && \\`,
    ];
  }
  return [
    `          mkdir -p ${sshDir} && chown ${user}:${user} ${sshDir} && chmod 700 ${sshDir} && \\`,
    `          if [ ! -f ${keyPath} ]; then su - ${user} -c "mkdir -p ~/.ssh && chmod 700 ~/.ssh && ssh-keygen -q -t ed25519 -C morpheus@agent-vault -N '' -f ~/.ssh/id_ed25519"; fi && \\`,
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
      ...(user === "root" ? buildRootProfileFixLine(home) : []),
      ...buildGitConfigLines(workspace),
      ...buildAuthCopyLines(user, workspace.runtime.authFiles),
      ...buildSshKeygenLine(user, home),
      ...buildPaseoBootstrapLine(Boolean(workspace.runtime.agentCmd), home),
      "          touch /tmp/.ready && sleep infinity",
    ];
  }
  return [
    "          set -eux && \\",
    ...buildAgentDirsLine(user, home),
    `          apt-get update && apt-get install -y openssh-client ${workspace.runtime.aptPackages.join(" ")} && \\`,
    ...buildAuthCopyLines(user, workspace.runtime.authFiles),
    ...buildSshKeygenLine(user, home),
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
      `# Generated by agentctl.ts on ${timestamp()}`,
      "",
      "apiVersion: v1",
      "kind: Namespace",
      "metadata:",
      `  name: ${workspace.identity.projectName}`,
    ].join("\n"),
  );

  if (workspace.storage.persistState) {
    docs.push(
      [
        "apiVersion: v1",
        "kind: PersistentVolumeClaim",
        "metadata:",
        `  name: ${workspace.storage.claimName}`,
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
  deploymentLines.push("        - name: project");
  deploymentLines.push(`          mountPath: ${workspace.runtime.home}`);
  const envLines = buildEnvLines(workspace);
  if (envLines.length) {
    deploymentLines.push("        env:");
    deploymentLines.push(...envLines);
  }
  deploymentLines.push("      volumes:");
  deploymentLines.push("      - name: project");
  if (workspace.storage.persistState) {
    deploymentLines.push("        persistentVolumeClaim:");
    deploymentLines.push(`          claimName: ${workspace.storage.claimName}`);
  } else {
    deploymentLines.push("        emptyDir: {}");
  }
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
