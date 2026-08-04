import type { AuthFile, PlainEnvVar, ServicePort, VaultSpec } from "../../core/vault.js";
import {
  isNetfsSource,
  netfsResolvedPath,
  requireNetfsField,
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
import { resolveConfiguredPaseoAppBaseUrl } from "../../core/pairing-url.js";
import { writeGeneratedManifest } from "../../output/write-generated.js";
import { vaultRuntimeResourceName, vaultRuntimeScopeName } from "../../core/vault-name.js";
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

function runtimeScope(vault: VaultSpec): string {
  return vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName);
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function authFileStorageTarget(file: AuthFile, vault: VaultSpec): string {
  return (
    stateStoragePathForMountPath({
      mountPath: file.mountPath,
      runtimeHome: vault.runtime.home,
      identityRoot: vault.attachments.userIdentityState.mountRoot,
    })
    ?? file.mountPath
  );
}

function buildAttachmentAssemblyLines(vault: VaultSpec): string[] {
  const home = vault.runtime.home;
  const user = vault.runtime.user;
  const projectRoot = vault.attachments.vaultData.mountRoot;
  const paseoRoot = `${vault.attachments.vaultRuntimeState.mountRoot}/paseo`;
  const evolutionRoot = `${paseoRoot}/evolution`;
  const toolRoot = `${vault.attachments.vaultRuntimeState.mountRoot}/tooling/polaris`;
  const identityRoot = vault.attachments.userIdentityState.mountRoot;
  const sshRoot = `${identityRoot}/ssh`;
  const runtimeRoot = vault.attachments.ephemeralRuntime.mountRoot;
  const identityDirs = userIdentityBootstrapDirs(identityRoot);
  return [
    `          mkdir -p ${projectRoot} ${vault.attachments.vaultRuntimeState.mountRoot} ${paseoRoot} ${evolutionRoot} ${toolRoot} ${identityDirs.join(" ")} ${runtimeRoot}/tmp ${runtimeRoot}/pids ${runtimeRoot}/sockets ${home}/.config ${home}/.local ${home}/.local/share /tmp/npm-cache && \\`,
    `          chown -R ${user}:${user} ${projectRoot} ${vault.attachments.vaultRuntimeState.mountRoot} ${identityRoot} ${runtimeRoot} && \\`,
    `          rm -rf ${home}/.codex ${home}/.claude ${home}/.copilot ${home}/.pi ${home}/.config/opencode ${home}/.local/share/opencode ${home}/.paseo ${home}/.ssh ${home}/vault && \\`,
    `          ln -sfn ${identityRoot}/codex ${home}/.codex && \\`,
    `          ln -sfn ${identityRoot}/claude ${home}/.claude && \\`,
    `          ln -sfn ${identityRoot}/copilot ${home}/.copilot && \\`,
    `          ln -sfn ${identityRoot}/pi ${home}/.pi && \\`,
    `          ln -sfn ${identityRoot}/opencode/config ${home}/.config/opencode && \\`,
    `          ln -sfn ${identityRoot}/opencode/data ${home}/.local/share/opencode && \\`,
    `          ln -sfn ${paseoRoot} ${home}/.paseo && \\`,
    `          ln -sfn ${sshRoot} ${home}/.ssh && \\`,
    `          if [ -x ${home}/.local/polaris/bin/paseo ] && [ ! -L ${home}/.local/polaris ]; then rm -rf ${toolRoot}/bin/paseo ${toolRoot}/lib/node_modules/@getpaseo && cp -a ${home}/.local/polaris/. ${toolRoot}/; fi && \\`,
    `          ln -sfn ${toolRoot} ${home}/.local/polaris && \\`,
    `          ln -sfn ${projectRoot} ${home}/vault && \\`,
    ...(vault.profile.vaultAlias ? [`          ln -sfn ${projectRoot} ${home}/${vault.profile.vaultAlias} && \\`] : []),
  ];
}

function buildRootProfileFixLine(vault: VaultSpec): string[] {
  const home = vault.runtime.home;
  const toolRoot = `${home}/.local/polaris`;
  const codexXdgRoot = `${vault.attachments.userIdentityState.mountRoot}/codex-xdg`;
  const toolBinaries = vaultToolCatalog()
    .filter((tool) => !["codex", "claude"].includes(tool.id))
    .map((tool) => tool.binName);
  return [
    "          profile_fix_needed=0 && \\",
    `          [ -f ${home}/.profile ] || profile_fix_needed=1 && \\`,
    `          for rc in ${home}/.profile ${home}/.bashrc ${home}/.zshrc; do [ -f "$rc" ] || continue; grep -Eq "/root/root/\\\\.cargo/env|\\\\$HOME/root/\\\\.cargo/env|^\\. \\"\\\\$HOME/\\\\.cargo/env\\"$|^source \\"\\\\$HOME/\\\\.cargo/env\\"$" "$rc" && profile_fix_needed=1 && break; done && \\`,
    `          if [ "$profile_fix_needed" = 1 ]; then touch ${home}/.profile && for rc in ${home}/.profile ${home}/.bashrc ${home}/.zshrc; do [ -f "$rc" ] || continue; awk 'BEGIN{seen=0} { if ($0 ~ /\\/root\\/root\\/\\.cargo\\/env/ || $0 ~ /\\$HOME\\/root\\/\\.cargo\\/env/) { if (!seen) print "[ -f \\"$HOME/.cargo/env\\" ] && . \\"$HOME/.cargo/env\\""; seen=1; next } if ($0 == ". \\"$HOME/.cargo/env\\"" || $0 == "source \\"$HOME/.cargo/env\\"" || $0 == "[ -f \\"$HOME/.cargo/env\\" ] && . \\"$HOME/.cargo/env\\"") { if (!seen) print "[ -f \\"$HOME/.cargo/env\\" ] && . \\"$HOME/.cargo/env\\""; seen=1; next } print } END{ if (ARGV[1] ~ /\\.profile$/ && !seen) print "[ -f \\"$HOME/.cargo/env\\" ] && . \\"$HOME/.cargo/env\\"" }' "$rc" > "$rc.tmp" && mv "$rc.tmp" "$rc"; done; fi && \\`,
    ...toolBinaries.map((binary) => `          if [ ! -L /usr/local/bin/${binary} ] || [ "$(readlink /usr/local/bin/${binary} 2>/dev/null)" != "${toolRoot}/bin/${binary}" ]; then ln -sf ${toolRoot}/bin/${binary} /usr/local/bin/${binary}; fi && \\`),
    `          printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'export PATH=${toolRoot}/bin:$PATH' 'export CODEX_HOME=${home}/.codex' 'export XDG_CONFIG_HOME=${codexXdgRoot}/config' 'export XDG_DATA_HOME=${codexXdgRoot}/data' 'export XDG_STATE_HOME=${codexXdgRoot}/state' 'mkdir -p ${home}/.codex ${codexXdgRoot}/config ${codexXdgRoot}/data ${codexXdgRoot}/state /tmp/npm-cache' 'exec ${toolRoot}/bin/codex \"$@\"' > /usr/local/bin/codex && chmod 755 /usr/local/bin/codex && \\`,
    `          printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'export PATH=${toolRoot}/bin:$PATH' 'export NPM_CONFIG_PREFIX=${toolRoot}' 'export npm_config_cache=/tmp/npm-cache' 'mkdir -p /tmp/npm-cache' 'exec ${toolRoot}/bin/claude \"$@\"' > /usr/local/bin/claude && chmod 755 /usr/local/bin/claude && \\`,
    `          if [ ! -L /usr/local/bin/pnpm ] || [ "$(readlink /usr/local/bin/pnpm 2>/dev/null)" != "${toolRoot}/bin/pnpm" ]; then ln -sf ${toolRoot}/bin/pnpm /usr/local/bin/pnpm; fi && \\`,
  ];
}

function buildToolInstallLines(vault: VaultSpec): string[] {
  const toolRoot = `${vault.attachments.vaultRuntimeState.mountRoot}/tooling/polaris`;
  return [
    `          if command -v npm >/dev/null 2>&1; then npm_config_cache=/tmp/npm-cache npm install -g --prefix ${toolRoot} ${vaultNonPaseoToolPackageSpecs().join(" ")}; fi && \\`,
    `          if [ ! -x ${toolRoot}/bin/paseo ] && command -v npm >/dev/null 2>&1; then npm_config_cache=/tmp/npm-cache npm install -g --prefix ${toolRoot} ${vaultPaseoPackageSpec()}; fi && \\`,
  ];
}

function buildAgentDirsLine(user: string, home: string): string[] {
  return [
    `          mkdir -p ${home} && \\`,
    `          chown ${user}:${user} ${home} && \\`,
    `          chmod 755 ${home} && \\`,
  ];
}

function buildAuthCopyLines(user: string, authFiles: AuthFile[], vault: VaultSpec): string[] {
  return authFiles.flatMap((item) => {
    const content = item.content ?? "";
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const target = authFileStorageTarget(item, vault);
    const parent = target.replace(/\/[^/]+$/, "");
    return [
      `          if [ ! -f ${target} ]; then python3 -c ${q(`import base64, pathlib; path = pathlib.Path(${JSON.stringify(target)}); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(base64.b64decode(${JSON.stringify(encoded)}));`)}; fi && chown ${user}:${user} ${parent} ${target} && chmod 600 ${target} && \\`,
    ];
  });
}

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
      `          python3 -c ${q(`import base64, pathlib; path = pathlib.Path(${JSON.stringify(filePath)}); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(base64.b64decode(${JSON.stringify(encoded)}));`)} && \\`,
    ];
  });
}

function buildSshMaterialLines(user: string, vault: VaultSpec): string[] {
  const sshDir = `${vault.attachments.userIdentityState.mountRoot}/ssh`;
  if (user === "root") {
    return [
      `          mkdir -p ${sshDir} && chown root:root ${sshDir} && chmod 700 ${sshDir} && \\`,
      `          find ${sshDir} -maxdepth 1 -type f -exec chown root:root {} + 2>/dev/null || true && \\`,
      `          find ${sshDir} -maxdepth 1 -type f ! -name '*.pub' ! -name 'authorized_keys' ! -name 'known_hosts' ! -name 'known_hosts.old' -exec chmod 400 {} + 2>/dev/null || true && \\`,
      `          find ${sshDir} -maxdepth 1 -type f -name '*.pub' -exec chmod 644 {} + 2>/dev/null || true && \\`,
      `          for ssh_meta in ${sshDir}/authorized_keys ${sshDir}/known_hosts ${sshDir}/known_hosts.old; do if [ -e "$ssh_meta" ] && { [ "$(stat -c %U:%G "$ssh_meta" 2>/dev/null || true)" != "root:root" ] || [ "$(stat -c %a "$ssh_meta" 2>/dev/null || true)" != "600" ]; }; then chown root:root "$ssh_meta" 2>/dev/null || true; chmod 600 "$ssh_meta" 2>/dev/null || true; fi; done && \\`,
    ];
  }
  return [
    `          mkdir -p ${sshDir} && chown ${user}:${user} ${sshDir} && chmod 700 ${sshDir} && \\`,
    `          find ${sshDir} -maxdepth 1 -type f -exec chown ${user}:${user} {} + 2>/dev/null || true && \\`,
    `          find ${sshDir} -maxdepth 1 -type f ! -name '*.pub' ! -name 'authorized_keys' ! -name 'known_hosts' ! -name 'known_hosts.old' -exec chmod 600 {} + 2>/dev/null || true && \\`,
    `          find ${sshDir} -maxdepth 1 -type f -name '*.pub' -exec chmod 644 {} + 2>/dev/null || true && \\`,
    `          for ssh_meta in ${sshDir}/authorized_keys ${sshDir}/known_hosts ${sshDir}/known_hosts.old; do if [ -e "$ssh_meta" ]; then chown ${user}:${user} "$ssh_meta" 2>/dev/null || true; chmod 600 "$ssh_meta" 2>/dev/null || true; fi; done && \\`,
  ];
}

function buildPaseoBootstrapLine(enabled: boolean, home: string): string[] {
  if (!enabled) {
    return [];
  }
  const paseoAppBaseUrl = resolveConfiguredPaseoAppBaseUrl();
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
    `          python3 -c ${q(configScript)} && \\`,
    `          paseo_sync_pairing() { tmp_pairing=$$(mktemp); if PASEO_HOME=${home}/.paseo paseo daemon pair --json > "$$tmp_pairing"; then mv "$$tmp_pairing" ${home}/.paseo/pairing.json; else rm -f "$$tmp_pairing"; return 1; fi; } && \\`,
    `          paseo_daemon_healthy() { daemon_status=$$(PASEO_HOME=${home}/.paseo paseo daemon status --json 2>/dev/null || true); printf '%s' "$$daemon_status" | grep -q '"localDaemon"[[:space:]]*:[[:space:]]*"running"' && printf '%s' "$$daemon_status" | grep -q '"connectedDaemon"[[:space:]]*:[[:space:]]*"reachable"'; } && \\`,
    `          paseo_ready() { test -s ${home}/.paseo/server-id && test -f ${home}/.paseo/pairing.json && grep -q '"url"[[:space:]]*:' ${home}/.paseo/pairing.json && paseo_daemon_healthy; } && \\`,
    `          paseo_wait_ready() { for _ in $$(seq 1 15); do if paseo_ready; then return 0; fi; sleep 1; done; return 1; } && \\`,
    `          paseo_stop_runner() { paseo_pid=$$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' ${home}/.paseo/paseo.pid 2>/dev/null | head -n 1); if [ -z "$$paseo_pid" ]; then paseo_pid=$$(cat ${home}/.paseo/paseo.pid 2>/dev/null | tr -cd '0-9'); fi; if [ -n "$$paseo_pid" ]; then paseo_args=$$(ps -o args= -p "$$paseo_pid" 2>/dev/null || true); if printf '%s' "$$paseo_args" | grep -Eq 'daemon-runner|Paseo Supervisor|paseo daemon start'; then pkill -TERM -P "$$paseo_pid" 2>/dev/null || true; kill "$$paseo_pid" 2>/dev/null || true; sleep 1; pkill -KILL -P "$$paseo_pid" 2>/dev/null || true; kill -KILL "$$paseo_pid" 2>/dev/null || true; fi; fi; rm -f ${home}/.paseo/paseo.pid ${home}/.paseo/daemon.log; } && \\`,
    `          if ! paseo_wait_ready; then \\`,
    `            paseo_stop_runner && \\`,
    `            PASEO_HOME=${home}/.paseo paseo daemon start --listen 0.0.0.0:6767 && \\`,
    `            paseo_sync_pairing || true && \\`,
    `            if ! paseo_wait_ready; then \\`,
    `              paseo_stop_runner && \\`,
    `              PASEO_HOME=${home}/.paseo paseo daemon start --listen 0.0.0.0:6767 && \\`,
    `              paseo_sync_pairing || true && \\`,
    `              paseo_wait_ready; \\`,
    `            fi; \\`,
    `          else \\`,
    `            paseo_sync_pairing || true; \\`,
    "          fi && \\",
  ];
}

function buildGitConfigLines(vault: VaultSpec): string[] {
  const lines: string[] = [];
  if (vault.runtime.gitCoreEditor) {
    lines.push(`          git config --global core.editor ${vault.runtime.gitCoreEditor} && \\`);
  }
  lines.push("          git config --global pull.rebase true && \\");
  if (vault.runtime.gitUserName) {
    lines.push(`          git config --global user.name ${q(vault.runtime.gitUserName)} && \\`);
  }
  if (vault.runtime.gitUserEmail) {
    lines.push(`          git config --global user.email ${vault.runtime.gitUserEmail} && \\`);
  }
  return lines;
}

function buildBootstrap(vault: VaultSpec): string[] {
  const home = vault.runtime.home;
  const user = vault.runtime.user;
  const authFiles = vaultEnablesWanghaiPortal(vault)
    ? sanitizeIntegratedWanghaiAuthFiles(vault.runtime.authFiles)
    : vault.runtime.authFiles;
  if (vault.runtime.bootstrapProfile === "prebuilt") {
    return [
      "          set -eux && \\",
      ...buildAgentDirsLine(user, home),
      ...buildAttachmentAssemblyLines(vault),
      ...buildToolInstallLines(vault),
      ...(user === "root" ? buildRootProfileFixLine(vault) : []),
      ...buildGitConfigLines(vault),
      ...buildAuthCopyLines(user, authFiles, vault),
      ...buildEvolutionBootstrapLines(vault),
      ...buildSshMaterialLines(user, vault),
      ...buildPaseoBootstrapLine(Boolean(vault.runtime.agentCmd), home),
      ...buildWanghaiPortalRuntimeLines(vault),
      ...(vaultEnablesWanghaiPortal(vault)
        ? []
        : ["          touch /tmp/.ready && sleep infinity"]),
    ];
  }
  return [
    "          set -eux && \\",
    ...buildAgentDirsLine(user, home),
    ...buildAttachmentAssemblyLines(vault),
    ...buildToolInstallLines(vault),
    `          apt-get update && apt-get install -y openssh-client ripgrep ${vault.runtime.aptPackages.join(" ")} && \\`,
    ...buildAuthCopyLines(user, authFiles, vault),
    ...buildEvolutionBootstrapLines(vault),
    ...buildSshMaterialLines(user, vault),
    ...buildPaseoBootstrapLine(Boolean(vault.runtime.agentCmd), home),
    ...buildWanghaiPortalRuntimeLines(vault),
    ...(vaultEnablesWanghaiPortal(vault)
      ? []
      : ["          touch /tmp/.ready && sleep infinity"]),
  ];
}

function isWanghaiServicePort(
  port: VaultSpec["connectivity"]["servicePorts"][number],
): boolean {
  return port.name?.toLowerCase() === "wanghai" || String(port.containerPort) === "9090";
}

function vaultEnablesWanghaiPortal(vault: VaultSpec): boolean {
  return vault.connectivity.servicePorts.some(isWanghaiServicePort);
}

function wanghaiGatewayEnvironment(vault: VaultSpec): {
  assertionSecret: string;
  frameAncestors: string;
  tenantId: string;
  vaultId: string;
} {
  return {
    assertionSecret: deriveWanghaiVaultAssertionSecret(
      requireWanghaiGatewayMasterSecret(),
      vault.userProfile.id,
      vault.identity.projectName,
    ),
    frameAncestors: configuredWanghaiFrameAncestors(),
    tenantId: vault.userProfile.id,
    vaultId: vault.identity.projectName,
  };
}

function buildWanghaiPortalRuntimeLines(vault: VaultSpec): string[] {
  if (!vaultEnablesWanghaiPortal(vault)) return [];
  const gateway = wanghaiGatewayEnvironment(vault);
  return [
    `          export WANGHAI_GATEWAY_ASSERTION_SECRET=${q(gateway.assertionSecret)} && \\`,
    `          export WANGHAI_GATEWAY_TENANT_ID=${q(gateway.tenantId)} && \\`,
    `          export WANGHAI_GATEWAY_VAULT_ID=${q(gateway.vaultId)} && \\`,
    `          export WANGHAI_GATEWAY_FRAME_ANCESTORS=${q(gateway.frameAncestors)} && \\`,
    `          mkdir -p ${vault.attachments.ephemeralRuntime.mountRoot}/pids ${vault.attachments.vaultRuntimeState.mountRoot} && \\`,
    `          if [ ! -x /usr/local/bin/wanghai-entrypoint ] || [ ! -d /opt/wanghai/apps/admin-portal ]; then echo "Wanghai portal runtime is missing" >&2; exit 1; fi && \\`,
    "          exec env WANGHAI_SUPERVISE_PORTAL=1 /usr/local/bin/wanghai-entrypoint pnpm --dir /opt/wanghai/apps/admin-portal run start --hostname 0.0.0.0 --port 9090",
  ];
}

function buildReadinessProbe(vault: VaultSpec): string[] {
  if (vaultEnablesWanghaiPortal(vault)) {
    return [
      "        startupProbe:",
      "          httpGet:",
      "            path: /readyz",
      "            port: 9090",
      "          initialDelaySeconds: 2",
      "          timeoutSeconds: 5",
      "          periodSeconds: 5",
      "          failureThreshold: 60",
      "        livenessProbe:",
      "          httpGet:",
      "            path: /healthz",
      "            port: 9090",
      "          timeoutSeconds: 5",
      "          periodSeconds: 10",
      "          failureThreshold: 3",
      "        readinessProbe:",
      "          httpGet:",
      "            path: /readyz",
      "            port: 9090",
      "          timeoutSeconds: 5",
      "          periodSeconds: 5",
      "          failureThreshold: 3",
    ];
  }
  if (vault.health.readinessMode === "daemon-port") {
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

function buildEnvLines(vault: VaultSpec): string[] {
  const envLines: string[] = [];
  const gatewayNames = new Set([
    "WANGHAI_GATEWAY_ASSERTION_SECRET",
    "WANGHAI_GATEWAY_TENANT_ID",
    "WANGHAI_GATEWAY_VAULT_ID",
    "WANGHAI_GATEWAY_FRAME_ANCESTORS",
    "WANGHAI_RUNTIME_MODE",
  ]);
  const plainEnvVars = vaultEnablesWanghaiPortal(vault)
    ? filterIntegratedWanghaiPlainEnvVars(vault.runtime.plainEnvVars)
    : vault.runtime.plainEnvVars;
  for (const item of plainEnvVars as PlainEnvVar[]) {
    if (gatewayNames.has(item.name)) continue;
    envLines.push(`        - name: ${item.name}`);
    envLines.push(`          value: ${q(item.value)}`);
  }
  if (vault.runtime.agentCmd) {
    envLines.push("        - name: PASEO_HOME");
    envLines.push(`          value: ${q(`${vault.runtime.home}/.paseo`)}`);
  }
  envLines.push("        - name: POLARIS_VAULT_DATA_ROOT");
  envLines.push(`          value: ${q(vault.attachments.vaultData.mountRoot)}`);
  envLines.push("        - name: POLARIS_VAULT_RUNTIME_ROOT");
  envLines.push(`          value: ${q(vault.attachments.vaultRuntimeState.mountRoot)}`);
  envLines.push("        - name: POLARIS_USER_IDENTITY_ROOT");
  envLines.push(`          value: ${q(vault.attachments.userIdentityState.mountRoot)}`);
  envLines.push("        - name: POLARIS_EVOLUTION_ROOT");
  envLines.push(`          value: ${q(vault.agent.runtime.evolutionRoot)}`);
  envLines.push("        - name: POLARIS_VAULT_MEMORY_FILE");
  envLines.push(`          value: ${q(vault.evolution?.vaultMemoryFile ?? "")}`);
  envLines.push("        - name: POLARIS_USER_MEMORY_FILE");
  envLines.push(`          value: ${q(vault.evolution?.userMemoryFile ?? "")}`);
  envLines.push("        - name: POLARIS_MEMORY_SNAPSHOT_FILE");
  envLines.push(`          value: ${q(vault.evolution?.sessionSnapshotFile ?? "")}`);
  if (vaultEnablesWanghaiPortal(vault)) {
    const gateway = wanghaiGatewayEnvironment(vault);
    envLines.push("        - name: WANGHAI_RUNTIME_MODE");
    envLines.push(`          value: ${q("polaris")}`);
    envLines.push("        - name: WANGHAI_GATEWAY_ASSERTION_SECRET");
    envLines.push(`          value: ${q(gateway.assertionSecret)}`);
    envLines.push("        - name: WANGHAI_GATEWAY_TENANT_ID");
    envLines.push(`          value: ${q(gateway.tenantId)}`);
    envLines.push("        - name: WANGHAI_GATEWAY_VAULT_ID");
    envLines.push(`          value: ${q(gateway.vaultId)}`);
    envLines.push("        - name: WANGHAI_GATEWAY_FRAME_ANCESTORS");
    envLines.push(`          value: ${q(gateway.frameAncestors)}`);
  }
  return envLines;
}

function serviceName(port: ServicePort, index: number): string {
  return port.name || (index === 0 ? "http" : `http-${index + 1}`);
}

function persistentVolumeClaims(vault: VaultSpec): Array<{
  name: string;
  size: string;
}> {
  const claims: Array<{ name: string; size: string }> = [];
  for (const attachment of [
    vault.attachments.vaultData,
    vault.attachments.vaultRuntimeState,
    vault.attachments.userIdentityState,
  ]) {
    if (attachment.source.kind !== "persistent-volume" || !attachment.source.volumeRef) {
      continue;
    }
    claims.push({
      name: attachment.source.volumeRef,
      size: attachment.source.volumeSize ?? vault.resources.ephemeralStorage,
    });
  }
  return Array.from(new Map(claims.map((claim) => [claim.name, claim])).values());
}

export function renderPodVault(vault: VaultSpec): string {
  const docs: string[] = [];
  docs.push(
    [
      `# Agent deployment: ${runtimeScope(vault)}`,
      `# Generated by polaris.ts on ${timestamp()}`,
      "",
      "apiVersion: v1",
      "kind: Namespace",
      "metadata:",
      `  name: ${runtimeScope(vault)}`,
    ].join("\n"),
  );

  for (const claim of persistentVolumeClaims(vault)) {
    docs.push(
      [
        "apiVersion: v1",
        "kind: PersistentVolumeClaim",
        "metadata:",
        `  name: ${claim.name}`,
        `  namespace: ${runtimeScope(vault)}`,
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
    `  name: ${runtimeScope(vault)}`,
    `  namespace: ${runtimeScope(vault)}`,
    "spec:",
    "  progressDeadlineSeconds: 900",
    "  replicas: 1",
    "  strategy:",
    "    type: Recreate",
    "  selector:",
    "    matchLabels:",
    `      app: ${runtimeScope(vault)}`,
    "  template:",
    "    metadata:",
    "      labels:",
    `        app: ${runtimeScope(vault)}`,
    "    spec:",
    `      runtimeClassName: ${vault.backend.profile}`,
    "      containers:",
    "      - name: agent",
    `        image: ${vault.runtime.baseImage}`,
    '        command: ["/bin/sh", "-c"]',
    "        args:",
    "        - |",
    ...buildBootstrap(vault),
    ...buildReadinessProbe(vault),
  ];
  if (!vault.resources.unbounded) {
    deploymentLines.push("        resources:");
    deploymentLines.push("          limits:");
    deploymentLines.push(`            memory: ${q(vault.resources.memory)}`);
    deploymentLines.push(`            cpu: ${q(vault.resources.cpu)}`);
    deploymentLines.push(`            ephemeral-storage: ${q(vault.resources.ephemeralStorage)}`);
    if (vault.resources.cpuRequest || vault.resources.memoryRequest || vault.resources.storageRequest) {
      deploymentLines.push("          requests:");
      if (vault.resources.memoryRequest) deploymentLines.push(`            memory: ${q(vault.resources.memoryRequest)}`);
      if (vault.resources.cpuRequest) deploymentLines.push(`            cpu: ${q(vault.resources.cpuRequest)}`);
      if (vault.resources.storageRequest) deploymentLines.push(`            ephemeral-storage: ${q(vault.resources.storageRequest)}`);
    }
  }
  deploymentLines.push("        volumeMounts:");
  deploymentLines.push("        - name: vault-data");
  deploymentLines.push(`          mountPath: ${vault.attachments.vaultData.mountRoot}`);
  deploymentLines.push("        - name: vault-runtime-state");
  deploymentLines.push(`          mountPath: ${vault.attachments.vaultRuntimeState.mountRoot}`);
  deploymentLines.push("        - name: user-identity-state");
  deploymentLines.push(`          mountPath: ${vault.attachments.userIdentityState.mountRoot}`);
  deploymentLines.push("        - name: ephemeral-runtime");
  deploymentLines.push(`          mountPath: ${vault.attachments.ephemeralRuntime.mountRoot}`);
  const envLines = buildEnvLines(vault);
  if (envLines.length) {
    deploymentLines.push("        env:");
    deploymentLines.push(...envLines);
  }
  deploymentLines.push("      volumes:");
  deploymentLines.push("      - name: vault-data");
  if (isNetfsSource(vault.attachments.vaultData.source)) {
    deploymentLines.push("        nfs:");
    deploymentLines.push(
      `          server: ${requireNetfsField(
        vault.attachments.vaultData.source.server,
        "server",
        "vault-data",
      )}`,
    );
    deploymentLines.push(
      `          path: ${netfsResolvedPath(
        vault.attachments.vaultData.source,
      )}`,
    );
  } else if (vault.attachments.vaultData.source.kind === "persistent-volume") {
    deploymentLines.push("        persistentVolumeClaim:");
    deploymentLines.push(`          claimName: ${vault.attachments.vaultData.source.volumeRef ?? vault.storage.claimName}`);
  } else {
    deploymentLines.push("        emptyDir: {}");
  }
  deploymentLines.push("      - name: vault-runtime-state");
  if (vault.attachments.vaultRuntimeState.source.kind === "persistent-volume") {
    deploymentLines.push("        persistentVolumeClaim:");
    deploymentLines.push(`          claimName: ${vault.attachments.vaultRuntimeState.source.volumeRef ?? vault.storage.claimName}`);
  } else {
    deploymentLines.push("        emptyDir: {}");
  }
  deploymentLines.push("      - name: user-identity-state");
  if (vault.attachments.userIdentityState.source.kind === "persistent-volume") {
    deploymentLines.push("        persistentVolumeClaim:");
    deploymentLines.push(`          claimName: ${vault.attachments.userIdentityState.source.volumeRef}`);
  } else {
    deploymentLines.push("        emptyDir: {}");
  }
  deploymentLines.push("      - name: ephemeral-runtime");
  deploymentLines.push("        emptyDir: {}");
  docs.push(deploymentLines.join("\n"));

  const publicServicePorts = vault.connectivity.servicePorts.filter(
    (port) => !isWanghaiServicePort(port),
  );
  if (vault.connectivity.exposeService && publicServicePorts.length) {
    const serviceLines = [
      "apiVersion: v1",
      "kind: Service",
      "metadata:",
      `  name: ${runtimeScope(vault)}`,
      `  namespace: ${runtimeScope(vault)}`,
      "spec:",
      `  type: ${vault.connectivity.serviceMode === "nodeport" ? "NodePort" : "ClusterIP"}`,
      "  selector:",
      `    app: ${runtimeScope(vault)}`,
      "  ports:",
    ];
    publicServicePorts.forEach((port, index) => {
      serviceLines.push(`  - name: ${serviceName(port, index)}`);
      serviceLines.push("    protocol: TCP");
      serviceLines.push(`    port: ${port.containerPort}`);
      serviceLines.push(`    targetPort: ${port.containerPort}`);
      serviceLines.push("    appProtocol: http");
      if (vault.connectivity.serviceMode === "nodeport" && port.nodePort) {
        serviceLines.push(`    nodePort: ${port.nodePort}`);
      }
    });
    docs.push(serviceLines.join("\n"));
  }

  if (vault.connectivity.exposeService && vaultEnablesWanghaiPortal(vault)) {
    const service = vaultRuntimeResourceName(
      vault.userProfile.id,
      vault.identity.projectName,
      "wanghai",
    );
    const port = vault.connectivity.servicePorts.find(isWanghaiServicePort)!;
    docs.push([
      "apiVersion: v1",
      "kind: Service",
      "metadata:",
      `  name: ${service}`,
      `  namespace: ${runtimeScope(vault)}`,
      "spec:",
      "  type: ClusterIP",
      "  selector:",
      `    app: ${runtimeScope(vault)}`,
      "  ports:",
      `  - name: wanghai-private`,
      "    protocol: TCP",
      `    port: ${port.containerPort}`,
      `    targetPort: ${port.containerPort}`,
      "    appProtocol: http",
    ].join("\n"));
  }

  return `${docs.join("\n---\n")}\n`;
}

export function renderAndWritePodVault(vault: VaultSpec): string {
  return writeGeneratedManifest(vault, renderPodVault(vault));
}
