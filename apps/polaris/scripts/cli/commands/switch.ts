import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getBackendDriver } from "../../backends/index.js";
import { parseWorkspaceReference } from "../../config/load.js";
import { ensureProvisionedWorkspace, ensureWorkspaceConfig } from "../../config/provision.js";
import type { WorkspaceSpec } from "../../core/workspace.js";
import { readWorkspaceDriverSelection, writeWorkspaceDriverSelection } from "../../output/state-store.js";
import { logInfo } from "../../utils/log.js";
import { loadExecutableWorkspaceForCommand, loadWorkspaceForProjectRef, waitForWorkspaceReady } from "./shared.js";

const SUPPORTED_BACKENDS: Array<WorkspaceSpec["backend"]["kind"]> = [
  "docker",
  "pod",
  "kubevirt-vm",
];

function loadWorkspaceForBackend(project: string, backend: WorkspaceSpec["backend"]["kind"]): WorkspaceSpec | null {
  try {
    ensureWorkspaceConfig(`${project}@${backend}`);
    const workspace = loadWorkspaceForProjectRef(`${project}@${backend}`);
    return workspace.backend.kind === backend ? workspace : null;
  } catch (error) {
    if (error instanceof Error && /Config not found/.test(error.message)) {
      return null;
    }
    throw error;
  }
}

function workspaceRefForSelection(project: string, backend: WorkspaceSpec["backend"]["kind"], profile?: string): string {
  return backend === "pod" && profile
    ? `${project}@${backend}:${profile}`
    : `${project}@${backend}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBackendRunning(
  workspace: WorkspaceSpec,
  timeoutMs = 120000,
  intervalMs = 1500,
): Promise<void> {
  const driver = getBackendDriver(workspace.backend.kind);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const observation = await driver.inspect(workspace);
    if (
      observation.backend.exists &&
      observation.backend.running &&
      observation.backend.detail &&
      canAccessAttachmentEndpoint(workspace, observation.backend.detail)
    ) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Workspace '${workspace.identity.projectName}' backend '${workspace.backend.kind}' did not start within ${timeoutMs}ms`,
  );
}

async function waitForBackendStopped(
  workspace: WorkspaceSpec,
  timeoutMs = 120000,
  intervalMs = 1500,
): Promise<void> {
  const driver = getBackendDriver(workspace.backend.kind);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const observation = await driver.inspect(workspace);
    if (!observation.backend.running) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Workspace '${workspace.identity.projectName}' backend '${workspace.backend.kind}' did not stop within ${timeoutMs}ms`,
  );
}

type AttachmentEndpoint =
  | { kind: "docker"; containerId: string }
  | { kind: "pod"; namespace: string; podName: string };

function resolveAttachmentEndpoint(workspace: WorkspaceSpec, detail: string): AttachmentEndpoint | null {
  if (workspace.backend.kind === "docker") {
    const containerId = detail.trim();
    return containerId ? { kind: "docker", containerId } : null;
  }
  if (workspace.backend.kind === "pod") {
    const prefix = "pod/";
    if (!detail.startsWith(prefix)) {
      return null;
    }
    const podName = detail.slice(prefix.length).trim();
    return podName
      ? { kind: "pod", namespace: workspace.identity.projectName, podName }
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

function workspaceDataExportDeploymentName(project: string): string {
  return `${project}-workspace-data-export`;
}

function hasWorkspaceDataExportDeployment(project: string): boolean {
  const deploymentName = workspaceDataExportDeploymentName(project);
  const result = spawnSync(
    "kubectl",
    ["-n", project, "get", "deployment", deploymentName, "-o", "jsonpath={.metadata.name}"],
    { encoding: "utf8" },
  );
  return result.status === 0 && Boolean((result.stdout || "").trim());
}

async function setWorkspaceDataExportDesiredState(project: string, running: boolean): Promise<void> {
  if (!hasWorkspaceDataExportDeployment(project)) {
    return;
  }
  const deploymentName = workspaceDataExportDeploymentName(project);
  const replicas = running ? "1" : "0";
  logInfo("cli", "switch-workspace-data-export", {
    project,
    deployment: deploymentName,
    replicas: Number(replicas),
  });
  runChecked("kubectl", ["-n", project, "scale", "deployment", deploymentName, `--replicas=${replicas}`]);
  runChecked("kubectl", ["-n", project, "rollout", "status", `deployment/${deploymentName}`, "--timeout=180s"]);
}

function switchScratchRoot(): string {
  const preferred = path.join(process.cwd(), ".tmp", "polaris-switch-state");
  fs.mkdirSync(preferred, { recursive: true });
  return preferred;
}

function canAccessAttachmentEndpoint(workspace: WorkspaceSpec, detail: string): boolean {
  const endpoint = resolveAttachmentEndpoint(workspace, detail);
  if (!endpoint) {
    return false;
  }
  const result = endpoint.kind === "docker"
    ? spawnSync("docker", ["exec", endpoint.containerId, "sh", "-lc", "true"], { encoding: "utf8" })
    : spawnSync("kubectl", ["-n", endpoint.namespace, "exec", endpoint.podName, "--", "sh", "-lc", "true"], { encoding: "utf8" });
  return result.status === 0;
}

async function waitForKubevirtAttachmentRelease(
  workspace: WorkspaceSpec,
  timeoutMs = 120000,
  intervalMs = 1500,
): Promise<void> {
  if (workspace.backend.kind !== "kubevirt-vm") {
    return;
  }
  const project = workspace.identity.projectName;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const vmi = spawnSync(
      "kubectl",
      ["-n", project, "get", "vmi", `${project}-vm`, "-o", "jsonpath={.metadata.name}"],
      { encoding: "utf8" },
    );
    const launcherPods = spawnSync(
      "kubectl",
      [
        "-n",
        project,
        "get",
        "pod",
        "-l",
        `vm.kubevirt.io/name=${project}-vm`,
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
  throw new Error(`KubeVirt volumes for '${workspace.identity.projectName}' were not released within ${timeoutMs}ms`);
}

type MigratedAttachment = "workspaceRuntimeState" | "userIdentityState";

const MIGRATED_ATTACHMENTS: MigratedAttachment[] = [
  "workspaceRuntimeState",
  "userIdentityState",
];

const PRE_RESTART_ATTACHMENTS: MigratedAttachment[] = [
  "workspaceRuntimeState",
  "userIdentityState",
];

const POST_RESTART_ATTACHMENTS: MigratedAttachment[] = [
  "userIdentityState",
];

function attachmentRootPath(workspace: WorkspaceSpec, attachment: MigratedAttachment): string {
  switch (attachment) {
    case "workspaceRuntimeState":
      return workspace.attachments.workspaceRuntimeState.mountRoot;
    case "userIdentityState":
      return workspace.attachments.userIdentityState.mountRoot;
  }
}

function kubevirtAttachmentClaimName(
  workspace: WorkspaceSpec,
  attachment: MigratedAttachment,
): string {
  const source = (() => {
    switch (attachment) {
      case "workspaceRuntimeState":
        return workspace.attachments.workspaceRuntimeState.source;
      case "userIdentityState":
        return workspace.attachments.userIdentityState.source;
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
    case "workspaceRuntimeState":
      return "workspace-runtime-state";
    case "userIdentityState":
      return "user-identity-state";
  }
}

function attachmentExportDir(root: string, attachment: MigratedAttachment): string {
  return path.join(root, attachment);
}

function attachmentDataPath(workspace: WorkspaceSpec, attachment: MigratedAttachment): string {
  return attachmentRootPath(workspace, attachment);
}

function kubevirtAttachmentDataPath(
  workspace: WorkspaceSpec,
  attachment: MigratedAttachment,
): string {
  return attachmentDataPath(workspace, attachment);
}

function attachmentDurablePaths(
  workspace: WorkspaceSpec,
  attachment: MigratedAttachment,
): string[] {
  const durablePaths = (() => {
    switch (attachment) {
      case "workspaceRuntimeState":
        return workspace.attachments.workspaceRuntimeState.durablePaths;
      case "userIdentityState":
        return workspace.attachments.userIdentityState.durablePaths;
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
  if (attachment !== "workspaceRuntimeState") {
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
  workspace: WorkspaceSpec,
  attachment: MigratedAttachment,
): string {
  const source = (() => {
    switch (attachment) {
      case "workspaceRuntimeState":
        return workspace.attachments.workspaceRuntimeState.source;
      case "userIdentityState":
        return workspace.attachments.userIdentityState.source;
    }
  })();
  const userScope = workspace.userProfile.id.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const fallbackName = (() => {
    switch (attachment) {
      case "workspaceRuntimeState":
        return `${workspace.identity.projectName}-workspace-runtime-state`;
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
  workspace: WorkspaceSpec,
  exportRoot: string,
  attachments: MigratedAttachment[],
): void {
  for (const attachment of attachments) {
    const volumeName = resolveDockerAttachmentVolumeName(workspace, attachment);
    ensureDockerVolume(volumeName);
    const exportDir = attachmentExportDir(exportRoot, attachment);
    const rootPath = attachmentDataPath(workspace, attachment);
    for (const durablePath of attachmentDurablePaths(workspace, attachment)) {
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
  workspace: WorkspaceSpec,
  attachment: MigratedAttachment,
): string {
  const owner = workspace.runtime.user === "root"
    ? "0:0"
    : `${workspace.runtime.user}:${workspace.runtime.user}`;
  const durablePaths = attachmentDurablePaths(workspace, attachment)
    .map((entry) => `if [ -e ${shellSingleQuote(entry)} ]; then chown -R ${owner} ${shellSingleQuote(entry)}; fi`);
  return durablePaths.join(" ; ");
}

function normalizeImportedAttachmentOwnership(
  workspace: WorkspaceSpec,
  endpoint: AttachmentEndpoint,
  attachment: MigratedAttachment,
): void {
  const command = normalizeImportedAttachmentOwnershipCommand(workspace, attachment);
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

async function exportSwitchState(workspace: WorkspaceSpec): Promise<string | null> {
  const exportRoot = fs.mkdtempSync(path.join(switchScratchRoot(), "state-"));
  if (workspace.backend.kind === "kubevirt-vm") {
    await waitForKubevirtAttachmentRelease(workspace);
    const pvcPodName = `${workspace.identity.projectName}-pvc-export`;
    const manifestPath = path.join(exportRoot, "pvc-export.yaml");
    const manifestLines = [
      "apiVersion: v1",
      "kind: Pod",
      "metadata:",
      `  name: ${pvcPodName}`,
      `  namespace: ${workspace.identity.projectName}`,
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
      manifestLines.push(`          mountPath: ${attachmentRootPath(workspace, attachment)}`);
    }
    manifestLines.push("  volumes:");
    for (const attachment of MIGRATED_ATTACHMENTS) {
      manifestLines.push(`    - name: ${kubevirtAttachmentVolumeName(attachment)}`);
      manifestLines.push("      persistentVolumeClaim:");
      manifestLines.push(`        claimName: ${kubevirtAttachmentClaimName(workspace, attachment)}`);
    }
    manifestLines.push("");
    fs.writeFileSync(
      manifestPath,
      manifestLines.join("\n"),
      "utf8",
    );
    try {
      runChecked("kubectl", ["apply", "-f", manifestPath]);
      runChecked("kubectl", ["-n", workspace.identity.projectName, "wait", "--for=condition=Ready", `pod/${pvcPodName}`, "--timeout=60s"]);
      for (const attachment of MIGRATED_ATTACHMENTS) {
        const exportDir = attachmentExportDir(exportRoot, attachment);
        fs.mkdirSync(exportDir, { recursive: true });
        const rootPath = kubevirtAttachmentDataPath(workspace, attachment);
        for (const durablePath of attachmentDurablePaths(workspace, attachment)) {
          const relativePath = relativeDurablePath(rootPath, durablePath);
          const localTarget = relativePath === "."
            ? exportDir
            : path.join(exportDir, relativePath);
          fs.mkdirSync(localTarget, { recursive: true });
          runChecked(
            "kubectl",
            ["-n", workspace.identity.projectName, "cp", `${pvcPodName}:${durablePath}/.`, localTarget],
          );
        }
        pruneExportedAttachmentState(attachment, exportDir);
      }
    } finally {
      deleteTransferPod(workspace.identity.projectName, pvcPodName);
    }
    return exportRoot;
  }

  const driver = getBackendDriver(workspace.backend.kind);
  const observation = await driver.inspect(workspace);
  if (!observation.backend.exists) {
    return null;
  }

  if (!observation.backend.running) {
    return null;
  }
  if (!observation.backend.detail) {
    return null;
  }
  const endpoint = resolveAttachmentEndpoint(workspace, observation.backend.detail);
  if (!endpoint) {
    return null;
  }

  for (const attachment of MIGRATED_ATTACHMENTS) {
    const exportDir = attachmentExportDir(exportRoot, attachment);
    fs.mkdirSync(exportDir, { recursive: true });
    const rootPath = attachmentDataPath(workspace, attachment);
    for (const durablePath of attachmentDurablePaths(workspace, attachment)) {
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
  workspace: WorkspaceSpec,
  exportRoot: string,
  attachments: MigratedAttachment[],
): Promise<void> {
  if (workspace.backend.kind === "docker") {
    importSwitchStateIntoDockerVolumes(workspace, exportRoot, attachments);
    return;
  }
  if (workspace.backend.kind === "kubevirt-vm") {
    const pvcPodName = `${workspace.identity.projectName}-pvc-import`;
    const manifestPath = path.join(exportRoot, "pvc-import.yaml");
    const manifestLines = [
      "apiVersion: v1",
      "kind: Pod",
      "metadata:",
      `  name: ${pvcPodName}`,
      `  namespace: ${workspace.identity.projectName}`,
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
      manifestLines.push(`          mountPath: ${attachmentRootPath(workspace, attachment)}`);
    }
    manifestLines.push("  volumes:");
    for (const attachment of attachments) {
      manifestLines.push(`    - name: ${kubevirtAttachmentVolumeName(attachment)}`);
      manifestLines.push("      persistentVolumeClaim:");
      manifestLines.push(`        claimName: ${kubevirtAttachmentClaimName(workspace, attachment)}`);
    }
    manifestLines.push("");
    fs.writeFileSync(
      manifestPath,
      manifestLines.join("\n"),
      "utf8",
    );
    try {
      runChecked("kubectl", ["apply", "-f", manifestPath]);
      runChecked("kubectl", ["-n", workspace.identity.projectName, "wait", "--for=condition=Ready", `pod/${pvcPodName}`, "--timeout=60s"]);
      const importEndpoint: AttachmentEndpoint = {
        kind: "pod",
        namespace: workspace.identity.projectName,
        podName: pvcPodName,
      };
      for (const attachment of attachments) {
        const exportDir = attachmentExportDir(exportRoot, attachment);
        const rootPath = kubevirtAttachmentDataPath(workspace, attachment);
        for (const durablePath of attachmentDurablePaths(workspace, attachment)) {
          const relativePath = relativeDurablePath(rootPath, durablePath);
          const localSource = relativePath === "."
            ? exportDir
            : path.join(exportDir, relativePath);
          if (!fs.existsSync(localSource)) {
            continue;
          }
          runChecked("kubectl", ["-n", workspace.identity.projectName, "exec", pvcPodName, "--", "sh", "-lc", `mkdir -p '${durablePath}'`]);
          runChecked("kubectl", ["-n", workspace.identity.projectName, "cp", `${localSource}/.`, `${pvcPodName}:${durablePath}`]);
        }
        normalizeImportedAttachmentOwnership(workspace, importEndpoint, attachment);
      }
    } finally {
      deleteTransferPod(workspace.identity.projectName, pvcPodName);
    }
    return;
  }
  await waitForBackendRunning(workspace);
  const driver = getBackendDriver(workspace.backend.kind);
  const observation = await driver.inspect(workspace);
  if (!observation.backend.detail) {
    throw new Error(`Could not resolve switch-state target for backend '${workspace.backend.kind}'`);
  }
  const endpoint = resolveAttachmentEndpoint(workspace, observation.backend.detail);
  if (!endpoint) {
    throw new Error(`Could not resolve switch-state target for backend '${workspace.backend.kind}'`);
  }

  for (const attachment of attachments) {
    const exportDir = attachmentExportDir(exportRoot, attachment);
    const rootPath = attachmentDataPath(workspace, attachment);
    for (const durablePath of attachmentDurablePaths(workspace, attachment)) {
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
    normalizeImportedAttachmentOwnership(workspace, endpoint, attachment);
  }
}

async function stopCompetingBackends(project: string, targetBackend: WorkspaceSpec["backend"]["kind"]): Promise<WorkspaceSpec["backend"]["kind"][]> {
  const stopped: WorkspaceSpec["backend"]["kind"][] = [];
  for (const backend of SUPPORTED_BACKENDS) {
    if (backend === targetBackend) {
      continue;
    }
    const workspace = loadWorkspaceForBackend(project, backend);
    if (!workspace) {
      continue;
    }
    const driver = getBackendDriver(workspace.backend.kind);
    const observation = await driver.inspect(workspace);
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
    await driver.stop(workspace);
    await waitForBackendStopped(workspace);
    stopped.push(backend);
  }
  return stopped;
}

async function runningBackendsForProject(
  project: string,
  targetBackend: WorkspaceSpec["backend"]["kind"],
): Promise<Array<{
  backend: WorkspaceSpec["backend"]["kind"];
  workspace: WorkspaceSpec;
}>> {
  const running: Array<{
    backend: WorkspaceSpec["backend"]["kind"];
    workspace: WorkspaceSpec;
  }> = [];
  for (const backend of SUPPORTED_BACKENDS) {
    if (backend === targetBackend) {
      continue;
    }
    const workspace = loadWorkspaceForBackend(project, backend);
    if (!workspace) {
      continue;
    }
    const observation = await getBackendDriver(workspace.backend.kind).inspect(workspace);
    if (!observation.backend.running) {
      continue;
    }
    running.push({ backend, workspace });
  }
  return running;
}

export interface SwitchResult {
  project: string;
  previousBackend: WorkspaceSpec["backend"]["kind"] | null;
  previousProfile: string | null;
  selectedBackend: WorkspaceSpec["backend"]["kind"];
  selectedProfile: string | null;
  stoppedBackends: WorkspaceSpec["backend"]["kind"][];
  selectionFile: string | null;
}

export async function performWorkspaceSwitch(projectRef: string): Promise<SwitchResult> {
  const { project, backendHint, profileHint } = parseWorkspaceReference(projectRef);
  if (!backendHint || !SUPPORTED_BACKENDS.includes(backendHint)) {
    throw new Error("Usage: pnpm --dir apps/polaris run polaris -- switch <project>@<docker|pod|kubevirt-vm>[:driver]");
  }
  ensureProvisionedWorkspace(projectRef);
  const targetRef = backendHint === "pod" && profileHint
    ? `${project}@${backendHint}:${profileHint}`
    : `${project}@${backendHint}`;
  ensureWorkspaceConfig(targetRef);
  const previewWorkspace = loadWorkspaceForProjectRef(targetRef);
  await getBackendDriver(previewWorkspace.backend.kind).render(previewWorkspace);

  const previousSelection = readWorkspaceDriverSelection(project);
  const previousBackend = previousSelection?.backend;
  const previousSelectionWorkspace = previousBackend
    ? loadWorkspaceForBackend(project, previousBackend)
    : null;
  const runningBackends = await runningBackendsForProject(project, backendHint);
  const selectedRunningWorkspace = previousBackend
    ? runningBackends.find((entry) => entry.backend === previousBackend)?.workspace ?? null
    : null;
  const selectedExportableWorkspace =
    previousSelectionWorkspace &&
    previousBackend &&
    previousBackend !== backendHint &&
    (selectedRunningWorkspace !== null || previousBackend === "kubevirt-vm")
      ? previousSelectionWorkspace
      : null;
  const previousWorkspace = selectedExportableWorkspace
    ?? selectedRunningWorkspace
    ?? (runningBackends.length === 1 ? runningBackends[0]?.workspace ?? null : null);
  const effectivePreviousBackend = previousWorkspace?.backend.kind ?? previousBackend ?? null;
  const shouldStopBeforeExport =
    previousWorkspace &&
    effectivePreviousBackend &&
    effectivePreviousBackend !== backendHint &&
    effectivePreviousBackend === "kubevirt-vm";
  const stoppedBackends = shouldStopBeforeExport
    ? await stopCompetingBackends(project, backendHint)
    : [];
  const exportedSwitchState = previousWorkspace && effectivePreviousBackend && effectivePreviousBackend !== backendHint
    ? await exportSwitchState(previousWorkspace)
    : null;
  const finalizedStoppedBackends = shouldStopBeforeExport
    ? stoppedBackends
    : await stopCompetingBackends(project, backendHint);
  await setWorkspaceDataExportDesiredState(project, backendHint === "docker");
  const { workspace, driver } = await loadExecutableWorkspaceForCommand("start", targetRef);
  const readyTimeoutMs = workspace.backend.kind === "kubevirt-vm"
    ? 600000
    : workspace.backend.kind === "docker"
      ? 120000
      : 45000;
  let selectionFile: string | undefined;
  try {
    if (
      exportedSwitchState &&
      (workspace.backend.kind === "docker" || workspace.backend.kind === "kubevirt-vm")
    ) {
      logInfo("cli", "switch-migrate-small-state", {
        project,
        fromBackend: effectivePreviousBackend,
        toBackend: backendHint,
        phase: "pre-start",
      });
      await importSwitchState(workspace, exportedSwitchState, PRE_RESTART_ATTACHMENTS);
    }
    await driver.start(workspace);
    if (exportedSwitchState && workspace.backend.kind === "pod") {
      logInfo("cli", "switch-migrate-small-state", {
        project,
        fromBackend: effectivePreviousBackend,
        toBackend: backendHint,
      });
      await importSwitchState(workspace, exportedSwitchState, PRE_RESTART_ATTACHMENTS);
      await driver.restart(workspace);
      await importSwitchState(workspace, exportedSwitchState, POST_RESTART_ATTACHMENTS);
    }
    await waitForWorkspaceReady(workspace, readyTimeoutMs);
    selectionFile = writeWorkspaceDriverSelection(project, {
      backend: backendHint,
      profile: backendHint === "pod" ? profileHint : undefined,
    });
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
    selectedProfile: backendHint === "pod" ? (profileHint ?? workspace.backend.profile) : null,
    stoppedBackends: finalizedStoppedBackends,
    selectionFile: selectionFile ?? null,
  };
}

export async function switchCommand(projectRef: string): Promise<void> {
  const result = await performWorkspaceSwitch(projectRef);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
