import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getBackendDriver } from "../../backends/index.js";
import { parseVaultReference } from "../../config/load.js";
import { ensureProvisionedVault, ensureVaultConfig } from "../../config/provision.js";
import {
  VAULT_STATUS_SCHEMA_VERSION,
  type VaultSpec,
} from "../../core/vault.js";
import {
  vaultRuntimeResourceName,
  vaultRuntimeScopeName,
} from "../../core/vault-name.js";
import { writeVaultStatus } from "../../output/state-store.js";
import { logInfo } from "../../utils/log.js";
import { withVaultLifecycleLock } from "../../utils/vault-lifecycle-lock.js";
import { loadExecutableVaultForCommand, loadVaultForProjectRef, waitForVaultReady } from "./shared.js";
import { loadVaultSummary } from "../../core/portal.js";

const SUPPORTED_BACKENDS: Array<VaultSpec["backend"]["kind"]> = [
  "docker",
  "pod",
  "kubevirt-vm",
];

function isWanghaiServicePort(
  port: VaultSpec["connectivity"]["servicePorts"][number],
): boolean {
  return port.name?.toLowerCase() === "wanghai" || port.containerPort === "9090";
}

function switchableBackendsForVault(
  vault: VaultSpec,
): readonly VaultSpec["backend"]["kind"][] {
  const isDockerOnlyWanghai =
    vault.backend.kind === "docker"
    && !vault.agent.enabled
    && vault.connectivity.servicePorts.length > 0
    && vault.connectivity.servicePorts.every(isWanghaiServicePort);
  return isDockerOnlyWanghai ? ["docker"] : SUPPORTED_BACKENDS;
}

function loadVaultForBackend(
  project: string,
  backend: VaultSpec["backend"]["kind"],
  userProfileId?: string,
): VaultSpec | null {
  try {
    ensureVaultConfig(`${project}@${backend}`, userProfileId);
    const vault = loadVaultForProjectRef(`${project}@${backend}`, userProfileId);
    return vault.backend.kind === backend ? vault : null;
  } catch (error) {
    if (error instanceof Error && /Config not found/.test(error.message)) {
      return null;
    }
    throw error;
  }
}

function vaultRefForSelection(project: string, backend: VaultSpec["backend"]["kind"], profile?: string): string {
  return backend === "pod" && profile
    ? `${project}@${backend}:${profile}`
    : `${project}@${backend}`;
}

function runtimeScope(vault: VaultSpec): string {
  return vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName);
}

function runtimeResource(vault: VaultSpec, suffix: string): string {
  return vaultRuntimeResourceName(
    vault.userProfile.id,
    vault.identity.projectName,
    suffix,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBackendRunning(
  vault: VaultSpec,
  timeoutMs = 120000,
  intervalMs = 1500,
): Promise<void> {
  const driver = getBackendDriver(vault.backend.kind);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const observation = await driver.inspect(vault);
    if (
      observation.backend.exists &&
      observation.backend.running &&
      observation.backend.detail &&
      canAccessAttachmentEndpoint(vault, observation.backend.detail)
    ) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Vault '${vault.identity.projectName}' backend '${vault.backend.kind}' did not start within ${timeoutMs}ms`,
  );
}

async function waitForBackendStopped(
  vault: VaultSpec,
  timeoutMs = 120000,
  intervalMs = 1500,
): Promise<void> {
  const driver = getBackendDriver(vault.backend.kind);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const observation = await driver.inspect(vault);
    if (!observation.backend.running) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Vault '${vault.identity.projectName}' backend '${vault.backend.kind}' did not stop within ${timeoutMs}ms`,
  );
}

type AttachmentEndpoint =
  | { kind: "docker"; containerId: string }
  | { kind: "pod"; namespace: string; podName: string };

function resolveAttachmentEndpoint(vault: VaultSpec, detail: string): AttachmentEndpoint | null {
  if (vault.backend.kind === "docker") {
    const containerId = detail.trim();
    return containerId ? { kind: "docker", containerId } : null;
  }
  if (vault.backend.kind === "pod") {
    const prefix = "pod/";
    if (!detail.startsWith(prefix)) {
      return null;
    }
    const podName = detail.slice(prefix.length).trim();
    return podName
      ? { kind: "pod", namespace: runtimeScope(vault), podName }
      : null;
  }
  return null;
}

function runChecked(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Command failed (${result.status ?? 1}): ${command} ${args.join(" ")}\n${result.stderr || result.stdout || ""}`.trim(),
    );
  }
}

function vaultDataExportDeploymentName(vault: VaultSpec): string {
  return runtimeResource(vault, "vault-data-export");
}

function hasVaultDataExportDeployment(vault: VaultSpec): boolean {
  const deploymentName = vaultDataExportDeploymentName(vault);
  const result = spawnSync(
    "kubectl",
    ["-n", runtimeScope(vault), "get", "deployment", deploymentName, "-o", "jsonpath={.metadata.name}"],
    { encoding: "utf8" },
  );
  return result.status === 0 && Boolean((result.stdout || "").trim());
}

async function setVaultDataExportDesiredState(vault: VaultSpec, running: boolean): Promise<void> {
  if (!hasVaultDataExportDeployment(vault)) {
    return;
  }
  const deploymentName = vaultDataExportDeploymentName(vault);
  const replicas = running ? "1" : "0";
  logInfo("cli", "switch-vault-data-export", {
    project: vault.identity.projectName,
    deployment: deploymentName,
    replicas: Number(replicas),
  });
  runChecked("kubectl", ["-n", runtimeScope(vault), "scale", "deployment", deploymentName, `--replicas=${replicas}`]);
  runChecked("kubectl", ["-n", runtimeScope(vault), "rollout", "status", `deployment/${deploymentName}`, "--timeout=180s"]);
}

function switchScratchRoot(): string {
  const preferred = path.join(process.cwd(), ".tmp", "polaris-switch-state");
  fs.mkdirSync(preferred, { recursive: true });
  return preferred;
}

function canAccessAttachmentEndpoint(vault: VaultSpec, detail: string): boolean {
  const endpoint = resolveAttachmentEndpoint(vault, detail);
  if (!endpoint) {
    return false;
  }
  const result = endpoint.kind === "docker"
    ? spawnSync("docker", ["exec", endpoint.containerId, "sh", "-lc", "true"], { encoding: "utf8" })
    : spawnSync("kubectl", ["-n", endpoint.namespace, "exec", endpoint.podName, "--", "sh", "-lc", "true"], { encoding: "utf8" });
  return result.status === 0;
}

async function waitForKubevirtAttachmentRelease(
  vault: VaultSpec,
  timeoutMs = 120000,
  intervalMs = 1500,
): Promise<void> {
  if (vault.backend.kind !== "kubevirt-vm") {
    return;
  }
  const namespace = runtimeScope(vault);
  const virtualMachineName = runtimeResource(vault, "vm");
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const vmi = spawnSync(
      "kubectl",
      ["-n", namespace, "get", "vmi", virtualMachineName, "-o", "jsonpath={.metadata.name}"],
      { encoding: "utf8" },
    );
    const launcherPods = spawnSync(
      "kubectl",
      [
        "-n",
        namespace,
        "get",
        "pod",
        "-l",
        `vm.kubevirt.io/name=${virtualMachineName}`,
        "-o",
        "jsonpath={range .items[*]}{.metadata.name}:{.status.phase}{\"\\n\"}{end}",
      ],
      { encoding: "utf8" },
    );
    const hasVmi = vmi.status === 0 && Boolean(String(vmi.stdout || "").trim());
    const hasLauncherPods = Boolean(String(launcherPods.stdout || "").trim());
    if (!hasVmi && !hasLauncherPods) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`KubeVirt volumes for '${vault.identity.projectName}' were not released within ${timeoutMs}ms`);
}

type MigratedAttachment = "vaultRuntimeState" | "userIdentityState";

const MIGRATED_ATTACHMENTS: MigratedAttachment[] = [
  "vaultRuntimeState",
  "userIdentityState",
];

const PRE_RESTART_ATTACHMENTS: MigratedAttachment[] = [
  "vaultRuntimeState",
  "userIdentityState",
];

const POST_RESTART_ATTACHMENTS: MigratedAttachment[] = [
  "userIdentityState",
];

function attachmentRootPath(vault: VaultSpec, attachment: MigratedAttachment): string {
  switch (attachment) {
    case "vaultRuntimeState":
      return vault.attachments.vaultRuntimeState.mountRoot;
    case "userIdentityState":
      return vault.attachments.userIdentityState.mountRoot;
  }
}

function kubevirtAttachmentClaimName(
  vault: VaultSpec,
  attachment: MigratedAttachment,
): string {
  const source = (() => {
    switch (attachment) {
      case "vaultRuntimeState":
        return vault.attachments.vaultRuntimeState.source;
      case "userIdentityState":
        return vault.attachments.userIdentityState.source;
    }
  })();
  if (source.kind !== "persistent-volume" || !source.volumeRef?.trim()) {
    throw new Error(
      `KubeVirt switch migration requires '${attachment}' to use a dedicated persistent-volume source`,
    );
  }
  return source.volumeRef.trim();
}

function kubevirtAttachmentVolumeName(attachment: MigratedAttachment): string {
  switch (attachment) {
    case "vaultRuntimeState":
      return "vault-runtime-state";
    case "userIdentityState":
      return "user-identity-state";
  }
}

function attachmentExportDir(root: string, attachment: MigratedAttachment): string {
  return path.join(root, attachment);
}

function attachmentDataPath(vault: VaultSpec, attachment: MigratedAttachment): string {
  return attachmentRootPath(vault, attachment);
}

function kubevirtAttachmentDataPath(
  vault: VaultSpec,
  attachment: MigratedAttachment,
): string {
  return attachmentDataPath(vault, attachment);
}

function attachmentDurablePaths(
  vault: VaultSpec,
  attachment: MigratedAttachment,
): string[] {
  const durablePaths = (() => {
    switch (attachment) {
      case "vaultRuntimeState":
        return vault.attachments.vaultRuntimeState.durablePaths;
      case "userIdentityState":
        return vault.attachments.userIdentityState.durablePaths;
    }
  })();
  const sorted = [...durablePaths].sort((a, b) => a.length - b.length);
  const minimal: string[] = [];
  for (const candidate of sorted) {
    const normalized = candidate.replace(/\/+$/, "");
    if (minimal.some((existing) => normalized === existing || normalized.startsWith(`${existing}/`))) {
      continue;
    }
    minimal.push(normalized);
  }
  return minimal;
}

function relativeDurablePath(root: string, durablePath: string): string {
  const relative = path.relative(root, durablePath);
  return relative === "" ? "." : relative;
}

function pruneExportedAttachmentState(attachment: MigratedAttachment, dir: string): void {
  if (attachment !== "vaultRuntimeState") {
    return;
  }
  for (const relativePath of [
    path.join("paseo", "models"),
    path.join("paseo", "daemon.log"),
    path.join("paseo", "paseo.pid"),
  ]) {
    fs.rmSync(path.join(dir, relativePath), { recursive: true, force: true });
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sanitizeVolumeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function resolveDockerAttachmentVolumeName(
  vault: VaultSpec,
  attachment: MigratedAttachment,
): string {
  const source = (() => {
    switch (attachment) {
      case "vaultRuntimeState":
        return vault.attachments.vaultRuntimeState.source;
      case "userIdentityState":
        return vault.attachments.userIdentityState.source;
    }
  })();
  const userScope = vault.userProfile.id.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const fallbackName = (() => {
    switch (attachment) {
      case "vaultRuntimeState":
        return runtimeResource(vault, "vault-runtime-state");
      case "userIdentityState":
        return `polaris-${userScope}-identity`;
    }
  })();
  const baseName = source.volumeRef?.trim() || fallbackName;
  const suffix = source.subPath?.trim()
    ? `-${sanitizeVolumeToken(source.subPath.trim())}`
    : "";
  return `${baseName}${suffix}`;
}

function ensureDockerVolume(name: string): void {
  runChecked("docker", ["volume", "create", name]);
}

function importSwitchStateIntoDockerVolumes(
  vault: VaultSpec,
  exportRoot: string,
  attachments: MigratedAttachment[],
): void {
  for (const attachment of attachments) {
    const volumeName = resolveDockerAttachmentVolumeName(vault, attachment);
    ensureDockerVolume(volumeName);
    const exportDir = attachmentExportDir(exportRoot, attachment);
    const rootPath = attachmentDataPath(vault, attachment);
    for (const durablePath of attachmentDurablePaths(vault, attachment)) {
      const relativePath = relativeDurablePath(rootPath, durablePath);
      const localSource = relativePath === "."
        ? exportDir
        : path.join(exportDir, relativePath);
      if (!fs.existsSync(localSource)) {
        continue;
      }
      const targetPath = relativePath === "."
        ? "/target"
        : `/target/${relativePath.replace(/^\/+/, "")}`;
      const copyCommand = [
        "set -e",
        `mkdir -p ${shellSingleQuote(targetPath)}`,
        `find ${shellSingleQuote(targetPath)} -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true`,
        `cp -a /source/. ${shellSingleQuote(targetPath)}`,
      ].join(" ; ");
      runChecked("docker", [
        "run",
        "--rm",
        "-v",
        `${volumeName}:/target`,
        "-v",
        `${localSource}:/source:ro`,
        "busybox:1.36",
        "sh",
        "-lc",
        copyCommand,
      ]);
    }
  }
}

function normalizeImportedAttachmentOwnershipCommand(
  vault: VaultSpec,
  attachment: MigratedAttachment,
): string {
  const owner = vault.runtime.user === "root"
    ? "0:0"
    : `${vault.runtime.user}:${vault.runtime.user}`;
  const durablePaths = attachmentDurablePaths(vault, attachment)
    .map((entry) => `if [ -e ${shellSingleQuote(entry)} ]; then chown -R ${owner} ${shellSingleQuote(entry)}; fi`);
  return durablePaths.join(" ; ");
}

function normalizeImportedAttachmentOwnership(
  vault: VaultSpec,
  endpoint: AttachmentEndpoint,
  attachment: MigratedAttachment,
): void {
  const command = normalizeImportedAttachmentOwnershipCommand(vault, attachment);
  if (!command.trim()) {
    return;
  }
  if (endpoint.kind === "docker") {
    runChecked("docker", ["exec", endpoint.containerId, "sh", "-lc", command]);
    return;
  }
  runChecked("kubectl", ["-n", endpoint.namespace, "exec", endpoint.podName, "--", "sh", "-lc", command]);
}

function deleteTransferPod(namespace: string, podName: string): void {
  spawnSync(
    "kubectl",
    ["-n", namespace, "delete", "pod", podName, "--ignore-not-found", "--wait=false"],
    { encoding: "utf8" },
  );
  const waitResult = spawnSync(
    "kubectl",
    ["-n", namespace, "wait", "--for=delete", `pod/${podName}`, "--timeout=5s"],
    { encoding: "utf8" },
  );
  if (waitResult.status === 0) {
    return;
  }
  spawnSync(
    "kubectl",
    [
      "-n",
      namespace,
      "delete",
      "pod",
      podName,
      "--ignore-not-found",
      "--wait=false",
      "--grace-period=0",
      "--force",
    ],
    { encoding: "utf8" },
  );
  spawnSync(
    "kubectl",
    ["-n", namespace, "wait", "--for=delete", `pod/${podName}`, "--timeout=5s"],
    { encoding: "utf8" },
  );
}

async function exportSwitchState(vault: VaultSpec): Promise<string | null> {
  const exportRoot = fs.mkdtempSync(path.join(switchScratchRoot(), "state-"));
  if (vault.backend.kind === "kubevirt-vm") {
    await waitForKubevirtAttachmentRelease(vault);
    const namespace = runtimeScope(vault);
    const pvcPodName = runtimeResource(vault, "pvc-export");
    const manifestPath = path.join(exportRoot, "pvc-export.yaml");
    const manifestLines = [
      "apiVersion: v1",
      "kind: Pod",
      "metadata:",
      `  name: ${pvcPodName}`,
      `  namespace: ${namespace}`,
      "spec:",
      "  restartPolicy: Never",
      "  containers:",
      "    - name: export",
      "      image: busybox:1.36",
      "      command: [\"sh\", \"-lc\", \"sleep 300\"]",
      "      volumeMounts:",
    ];
    for (const attachment of MIGRATED_ATTACHMENTS) {
      manifestLines.push(`        - name: ${kubevirtAttachmentVolumeName(attachment)}`);
      manifestLines.push(`          mountPath: ${attachmentRootPath(vault, attachment)}`);
    }
    manifestLines.push("  volumes:");
    for (const attachment of MIGRATED_ATTACHMENTS) {
      manifestLines.push(`    - name: ${kubevirtAttachmentVolumeName(attachment)}`);
      manifestLines.push("      persistentVolumeClaim:");
      manifestLines.push(`        claimName: ${kubevirtAttachmentClaimName(vault, attachment)}`);
    }
    manifestLines.push("");
    fs.writeFileSync(
      manifestPath,
      manifestLines.join("\n"),
      "utf8",
    );
    try {
      runChecked("kubectl", ["apply", "-f", manifestPath]);
      runChecked("kubectl", ["-n", namespace, "wait", "--for=condition=Ready", `pod/${pvcPodName}`, "--timeout=60s"]);
      for (const attachment of MIGRATED_ATTACHMENTS) {
        const exportDir = attachmentExportDir(exportRoot, attachment);
        fs.mkdirSync(exportDir, { recursive: true });
        const rootPath = kubevirtAttachmentDataPath(vault, attachment);
        for (const durablePath of attachmentDurablePaths(vault, attachment)) {
          const relativePath = relativeDurablePath(rootPath, durablePath);
          const localTarget = relativePath === "."
            ? exportDir
            : path.join(exportDir, relativePath);
          fs.mkdirSync(localTarget, { recursive: true });
          runChecked(
            "kubectl",
            ["-n", namespace, "cp", `${pvcPodName}:${durablePath}/.`, localTarget],
          );
        }
        pruneExportedAttachmentState(attachment, exportDir);
      }
    } finally {
      deleteTransferPod(namespace, pvcPodName);
    }
    return exportRoot;
  }

  const driver = getBackendDriver(vault.backend.kind);
  const observation = await driver.inspect(vault);
  if (!observation.backend.exists) {
    return null;
  }

  if (!observation.backend.running) {
    return null;
  }
  if (!observation.backend.detail) {
    return null;
  }
  const endpoint = resolveAttachmentEndpoint(vault, observation.backend.detail);
  if (!endpoint) {
    return null;
  }

  for (const attachment of MIGRATED_ATTACHMENTS) {
    const exportDir = attachmentExportDir(exportRoot, attachment);
    fs.mkdirSync(exportDir, { recursive: true });
    const rootPath = attachmentDataPath(vault, attachment);
    for (const durablePath of attachmentDurablePaths(vault, attachment)) {
      const relativePath = relativeDurablePath(rootPath, durablePath);
      const localTarget = relativePath === "."
        ? exportDir
        : path.join(exportDir, relativePath);
      fs.mkdirSync(localTarget, { recursive: true });
      const sourceRoot = `${durablePath}/.`;
      if (endpoint.kind === "docker") {
        runChecked("docker", ["cp", `${endpoint.containerId}:${sourceRoot}`, localTarget]);
      } else {
        runChecked("kubectl", ["-n", endpoint.namespace, "cp", `${endpoint.podName}:${sourceRoot}`, localTarget]);
      }
    }
    pruneExportedAttachmentState(attachment, exportDir);
  }
  return exportRoot;
}

async function importSwitchState(
  vault: VaultSpec,
  exportRoot: string,
  attachments: MigratedAttachment[],
): Promise<void> {
  if (vault.backend.kind === "docker") {
    importSwitchStateIntoDockerVolumes(vault, exportRoot, attachments);
    return;
  }
  if (vault.backend.kind === "kubevirt-vm") {
    const namespace = runtimeScope(vault);
    const pvcPodName = runtimeResource(vault, "pvc-import");
    const manifestPath = path.join(exportRoot, "pvc-import.yaml");
    const manifestLines = [
      "apiVersion: v1",
      "kind: Pod",
      "metadata:",
      `  name: ${pvcPodName}`,
      `  namespace: ${namespace}`,
      "spec:",
      "  restartPolicy: Never",
      "  containers:",
      "    - name: import",
      "      image: busybox:1.36",
      "      command: [\"sh\", \"-lc\", \"sleep 300\"]",
      "      volumeMounts:",
    ];
    for (const attachment of attachments) {
      manifestLines.push(`        - name: ${kubevirtAttachmentVolumeName(attachment)}`);
      manifestLines.push(`          mountPath: ${attachmentRootPath(vault, attachment)}`);
    }
    manifestLines.push("  volumes:");
    for (const attachment of attachments) {
      manifestLines.push(`    - name: ${kubevirtAttachmentVolumeName(attachment)}`);
      manifestLines.push("      persistentVolumeClaim:");
      manifestLines.push(`        claimName: ${kubevirtAttachmentClaimName(vault, attachment)}`);
    }
    manifestLines.push("");
    fs.writeFileSync(
      manifestPath,
      manifestLines.join("\n"),
      "utf8",
    );
    try {
      runChecked("kubectl", ["apply", "-f", manifestPath]);
      runChecked("kubectl", ["-n", namespace, "wait", "--for=condition=Ready", `pod/${pvcPodName}`, "--timeout=60s"]);
      const importEndpoint: AttachmentEndpoint = {
        kind: "pod",
        namespace,
        podName: pvcPodName,
      };
      for (const attachment of attachments) {
        const exportDir = attachmentExportDir(exportRoot, attachment);
        const rootPath = kubevirtAttachmentDataPath(vault, attachment);
        for (const durablePath of attachmentDurablePaths(vault, attachment)) {
          const relativePath = relativeDurablePath(rootPath, durablePath);
          const localSource = relativePath === "."
            ? exportDir
            : path.join(exportDir, relativePath);
          if (!fs.existsSync(localSource)) {
            continue;
          }
          runChecked("kubectl", ["-n", namespace, "exec", pvcPodName, "--", "sh", "-lc", `mkdir -p '${durablePath}'`]);
          runChecked("kubectl", ["-n", namespace, "cp", `${localSource}/.`, `${pvcPodName}:${durablePath}`]);
        }
        normalizeImportedAttachmentOwnership(vault, importEndpoint, attachment);
      }
    } finally {
      deleteTransferPod(namespace, pvcPodName);
    }
    return;
  }
  await waitForBackendRunning(vault);
  const driver = getBackendDriver(vault.backend.kind);
  const observation = await driver.inspect(vault);
  if (!observation.backend.detail) {
    throw new Error(`Could not resolve switch-state target for backend '${vault.backend.kind}'`);
  }
  const endpoint = resolveAttachmentEndpoint(vault, observation.backend.detail);
  if (!endpoint) {
    throw new Error(`Could not resolve switch-state target for backend '${vault.backend.kind}'`);
  }

  for (const attachment of attachments) {
    const exportDir = attachmentExportDir(exportRoot, attachment);
    const rootPath = attachmentDataPath(vault, attachment);
    for (const durablePath of attachmentDurablePaths(vault, attachment)) {
      const relativePath = relativeDurablePath(rootPath, durablePath);
      const localSource = relativePath === "."
        ? exportDir
        : path.join(exportDir, relativePath);
      if (!fs.existsSync(localSource)) {
        continue;
      }
      if (endpoint.kind === "docker") {
        runChecked("docker", ["cp", `${localSource}/.`, `${endpoint.containerId}:${durablePath}`]);
      } else {
        runChecked("kubectl", ["-n", endpoint.namespace, "cp", `${localSource}/.`, `${endpoint.podName}:${durablePath}`]);
      }
    }
    normalizeImportedAttachmentOwnership(vault, endpoint, attachment);
  }
}

async function stopCompetingBackends(
  project: string,
  targetBackend: VaultSpec["backend"]["kind"],
  switchableBackends: readonly VaultSpec["backend"]["kind"][],
  userProfileId?: string,
): Promise<VaultSpec["backend"]["kind"][]> {
  const stopped: VaultSpec["backend"]["kind"][] = [];
  for (const backend of switchableBackends) {
    if (backend === targetBackend) {
      continue;
    }
    const vault = loadVaultForBackend(project, backend, userProfileId);
    if (!vault) {
      continue;
    }
    const driver = getBackendDriver(vault.backend.kind);
    const observation = await driver.inspect(vault);
    if (!observation.backend.exists) {
      continue;
    }
    if (!observation.backend.running) {
      continue;
    }
    logInfo("cli", "switch-stop-previous-backend", {
      project,
      fromBackend: backend,
      toBackend: targetBackend,
    });
    await driver.stop(vault);
    await waitForBackendStopped(vault);
    stopped.push(backend);
  }
  return stopped;
}

async function runningBackendsForProject(
  project: string,
  targetBackend: VaultSpec["backend"]["kind"],
  switchableBackends: readonly VaultSpec["backend"]["kind"][],
  userProfileId?: string,
): Promise<Array<{
  backend: VaultSpec["backend"]["kind"];
  vault: VaultSpec;
}>> {
  const running: Array<{
    backend: VaultSpec["backend"]["kind"];
    vault: VaultSpec;
  }> = [];
  for (const backend of switchableBackends) {
    if (backend === targetBackend) {
      continue;
    }
    const vault = loadVaultForBackend(project, backend, userProfileId);
    if (!vault) {
      continue;
    }
    const observation = await getBackendDriver(vault.backend.kind).inspect(vault);
    if (!observation.backend.running) {
      continue;
    }
    running.push({ backend, vault });
  }
  return running;
}

export interface SwitchResult {
  project: string;
  previousBackend: VaultSpec["backend"]["kind"] | null;
  previousProfile: string | null;
  selectedBackend: VaultSpec["backend"]["kind"];
  selectedProfile: string | null;
  stoppedBackends: VaultSpec["backend"]["kind"][];
  selectionFile: string | null;
}

export async function performVaultSwitch(
  projectRef: string,
  userProfileId?: string,
): Promise<SwitchResult> {
  const { project, backendHint, profileHint } = parseVaultReference(projectRef);
  if (!backendHint || !SUPPORTED_BACKENDS.includes(backendHint)) {
    throw new Error("Usage: pnpm --dir apps/polaris run polaris -- switch <project>@<docker|pod|kubevirt-vm>[:driver]");
  }
  const runSwitch = async (): Promise<SwitchResult> => {
    ensureProvisionedVault(projectRef, userProfileId);
    const targetRef = backendHint === "pod" && profileHint
      ? `${project}@${backendHint}:${profileHint}`
      : `${project}@${backendHint}`;
    ensureVaultConfig(targetRef, userProfileId);
    const previewVault = loadVaultForProjectRef(targetRef, userProfileId);
    await getBackendDriver(previewVault.backend.kind).render(previewVault);
    const switchableBackends = switchableBackendsForVault(previewVault);

    const previousSelection = loadVaultSummary(userProfileId ?? "", project).status?.driver?.selected ?? null;
    const previousBackend = previousSelection?.backend;
    const previousSelectionVault = previousBackend && switchableBackends.includes(previousBackend)
      ? loadVaultForBackend(project, previousBackend, userProfileId)
      : null;
    const runningBackends = await runningBackendsForProject(
      project,
      backendHint,
      switchableBackends,
      userProfileId,
    );
    const selectedRunningVault = previousBackend
      ? runningBackends.find((entry) => entry.backend === previousBackend)?.vault ?? null
      : null;
    const selectedExportableVault =
      previousSelectionVault &&
      previousBackend &&
      previousBackend !== backendHint &&
      (selectedRunningVault !== null || previousBackend === "kubevirt-vm")
        ? previousSelectionVault
        : null;
    const previousVault = selectedExportableVault
      ?? selectedRunningVault
      ?? (runningBackends.length === 1 ? runningBackends[0]?.vault ?? null : null);
    const effectivePreviousBackend = previousVault?.backend.kind ?? previousBackend ?? null;
    const shouldStopBeforeExport =
      previousVault &&
      effectivePreviousBackend &&
      effectivePreviousBackend !== backendHint &&
      effectivePreviousBackend === "kubevirt-vm";
    const stoppedBackends = shouldStopBeforeExport
      ? await stopCompetingBackends(project, backendHint, switchableBackends, userProfileId)
      : [];
    const exportedSwitchState =
      previousVault &&
      effectivePreviousBackend &&
      effectivePreviousBackend !== backendHint
        ? await exportSwitchState(previousVault)
        : null;
    const finalizedStoppedBackends = shouldStopBeforeExport
      ? stoppedBackends
      : await stopCompetingBackends(project, backendHint, switchableBackends, userProfileId);
    const { vault, driver } = await loadExecutableVaultForCommand(
      "start",
      targetRef,
      userProfileId,
    );
    await setVaultDataExportDesiredState(vault, backendHint === "docker");
    const readyTimeoutMs = vault.backend.kind === "kubevirt-vm"
      ? 600000
      : vault.backend.kind === "docker"
        ? 120000
        : 45000;
    try {
      if (
        exportedSwitchState &&
        (vault.backend.kind === "docker" || vault.backend.kind === "kubevirt-vm")
      ) {
        logInfo("cli", "switch-migrate-small-state", {
          project,
          fromBackend: effectivePreviousBackend,
          toBackend: backendHint,
          phase: "pre-start",
        });
        await importSwitchState(vault, exportedSwitchState, PRE_RESTART_ATTACHMENTS);
      }
      await driver.start(vault);
      if (exportedSwitchState && vault.backend.kind === "pod") {
        logInfo("cli", "switch-migrate-small-state", {
          project,
          fromBackend: effectivePreviousBackend,
          toBackend: backendHint,
        });
        await importSwitchState(vault, exportedSwitchState, PRE_RESTART_ATTACHMENTS);
        await driver.restart(vault);
        await importSwitchState(vault, exportedSwitchState, POST_RESTART_ATTACHMENTS);
      }
      await waitForVaultReady(vault, readyTimeoutMs);
      const summary = loadVaultSummary(userProfileId ?? "", project);
      const currentStatus = summary.status;
      const selectedDriver = {
        backend: backendHint,
        ...(backendHint === "pod" && (profileHint ?? vault.backend.profile)
          ? { profile: profileHint ?? vault.backend.profile }
          : {}),
      };
      writeVaultStatus({
        schemaVersion: VAULT_STATUS_SCHEMA_VERSION,
        project,
        paseo: currentStatus?.paseo ?? {
          daemon: "unknown",
          web: "unavailable",
          reconnectMode: "unknown",
          liveTarget: null,
          reconnectTarget: null,
        },
        details: currentStatus?.details ?? {},
        driver: {
          ...(currentStatus?.driver ?? {
            status: "running",
          }),
          selected: selectedDriver,
        },
      }, userProfileId);
    } finally {
      if (exportedSwitchState) {
        fs.rmSync(exportedSwitchState, { recursive: true, force: true });
      }
    }

    return {
      project,
      previousBackend: effectivePreviousBackend ?? null,
      previousProfile: previousSelection?.profile ?? null,
      selectedBackend: backendHint,
      selectedProfile: backendHint === "pod" ? (profileHint ?? vault.backend.profile) : null,
      stoppedBackends: finalizedStoppedBackends,
      selectionFile: null,
    };
  };
  if (!userProfileId?.trim()) {
    return runSwitch();
  }
  return withVaultLifecycleLock(
    import.meta.url,
    userProfileId,
    project,
    runSwitch,
  );
}

export async function switchCommand(projectRef: string): Promise<void> {
  const result = await performVaultSwitch(projectRef);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
