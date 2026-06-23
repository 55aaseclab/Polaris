import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getBackendDriver } from "../../backends/index.js";
import { loadWorkspace, parseWorkspaceReference } from "../../config/load.js";
import { ensureProvisionedWorkspace, ensureWorkspaceConfig } from "../../config/provision.js";
import type { WorkspaceSpec } from "../../core/workspace.js";
import { readWorkspaceDriverSelection, writeWorkspaceDriverSelection } from "../../output/state-store.js";
import { logInfo } from "../../utils/log.js";
import { loadExecutableWorkspaceForCommand, waitForWorkspaceReady } from "./shared.js";

const SUPPORTED_BACKENDS: Array<WorkspaceSpec["backend"]["kind"]> = [
  "docker",
  "pod",
  "kubevirt-vm",
];

function loadWorkspaceForBackend(project: string, backend: WorkspaceSpec["backend"]["kind"]): WorkspaceSpec | null {
  try {
    ensureWorkspaceConfig(`${project}@${backend}`);
    const workspace = loadWorkspace(`${project}@${backend}`);
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

type MigratedAttachment = "workspaceRuntimeState" | "userIdentityState" | "userSshState";

const MIGRATED_ATTACHMENTS: MigratedAttachment[] = [
  "workspaceRuntimeState",
  "userIdentityState",
  "userSshState",
];

const PRE_RESTART_ATTACHMENTS: MigratedAttachment[] = [
  "workspaceRuntimeState",
  "userIdentityState",
  "userSshState",
];

const POST_RESTART_ATTACHMENTS: MigratedAttachment[] = [
  "userIdentityState",
  "userSshState",
];

function attachmentRootPath(workspace: WorkspaceSpec, attachment: MigratedAttachment): string {
  switch (attachment) {
    case "workspaceRuntimeState":
      return workspace.attachments.workspaceRuntimeState.mountRoot;
    case "userIdentityState":
      return workspace.attachments.userIdentityState.mountRoot;
    case "userSshState":
      return workspace.attachments.userSshState.mountRoot;
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
      case "userSshState":
        return workspace.attachments.userSshState.source;
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
    case "userSshState":
      return "user-ssh-state";
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

function pruneExportedAttachmentState(attachment: MigratedAttachment, dir: string): void {
  void attachment;
  void dir;
}

async function exportSwitchState(workspace: WorkspaceSpec): Promise<string | null> {
  const driver = getBackendDriver(workspace.backend.kind);
  const observation = await driver.inspect(workspace);
  if (!observation.backend.exists) {
    return null;
  }

  const exportRoot = fs.mkdtempSync(path.join(switchScratchRoot(), "state-"));
  if (workspace.backend.kind === "kubevirt-vm") {
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
        const sourceRoot = `${kubevirtAttachmentDataPath(workspace, attachment)}/.`;
        runChecked("kubectl", ["-n", workspace.identity.projectName, "cp", `${pvcPodName}:${sourceRoot}`, exportDir]);
        pruneExportedAttachmentState(attachment, exportDir);
      }
    } finally {
      spawnSync("kubectl", ["-n", workspace.identity.projectName, "delete", "pod", pvcPodName, "--ignore-not-found"], { encoding: "utf8" });
    }
    return exportRoot;
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
    const sourceRoot = `${attachmentDataPath(workspace, attachment)}/.`;
    if (endpoint.kind === "docker") {
      runChecked("docker", ["cp", `${endpoint.containerId}:${sourceRoot}`, exportDir]);
    } else {
      runChecked("kubectl", ["-n", endpoint.namespace, "cp", `${endpoint.podName}:${sourceRoot}`, exportDir]);
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
      for (const attachment of attachments) {
        const exportDir = attachmentExportDir(exportRoot, attachment);
        const targetDir = kubevirtAttachmentDataPath(workspace, attachment);
        runChecked("kubectl", ["-n", workspace.identity.projectName, "exec", pvcPodName, "--", "sh", "-lc", `mkdir -p '${targetDir}'`]);
        runChecked("kubectl", ["-n", workspace.identity.projectName, "cp", `${exportDir}/.`, `${pvcPodName}:${targetDir}`]);
      }
    } finally {
      spawnSync("kubectl", ["-n", workspace.identity.projectName, "delete", "pod", pvcPodName, "--ignore-not-found"], { encoding: "utf8" });
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
    const targetDir = attachmentDataPath(workspace, attachment);
    if (endpoint.kind === "docker") {
      runChecked("docker", ["cp", `${exportDir}/.`, `${endpoint.containerId}:${targetDir}`]);
    } else {
      runChecked("kubectl", ["-n", endpoint.namespace, "cp", `${exportDir}/.`, `${endpoint.podName}:${targetDir}`]);
    }
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
    if (!observation.backend.exists && !observation.backend.running) {
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

export async function switchCommand(projectRef: string): Promise<void> {
  const { project, backendHint, profileHint } = parseWorkspaceReference(projectRef);
  if (!backendHint || !SUPPORTED_BACKENDS.includes(backendHint)) {
    throw new Error("Usage: pnpm --dir apps/polaris run polaris -- switch <project>@<docker|pod|kubevirt-vm>[:driver]");
  }
  ensureProvisionedWorkspace(projectRef);

  const previousSelection = readWorkspaceDriverSelection(project);
  const previousBackend = previousSelection?.backend;
  const previousRef = previousBackend
    ? workspaceRefForSelection(project, previousBackend, previousSelection?.profile)
    : null;
  const previousWorkspace = previousRef && previousBackend
    ? loadWorkspaceForBackend(project, previousBackend)
    : null;
  const exportedSwitchState = previousWorkspace && previousBackend && previousBackend !== backendHint
    ? await exportSwitchState(previousWorkspace)
    : null;
  const stoppedBackends = await stopCompetingBackends(project, backendHint);
  const selectionFile = writeWorkspaceDriverSelection(project, {
    backend: backendHint,
    profile: backendHint === "pod" ? profileHint : undefined,
  });
  const targetRef = backendHint === "pod" && profileHint
    ? `${project}@${backendHint}:${profileHint}`
    : `${project}@${backendHint}`;
  const { workspace, driver } = await loadExecutableWorkspaceForCommand("start", targetRef);
  const readyTimeoutMs = workspace.backend.kind === "kubevirt-vm" ? 600000 : 45000;
  try {
    await driver.start(workspace);
    if (exportedSwitchState) {
      logInfo("cli", "switch-migrate-small-state", {
        project,
        fromBackend: previousBackend,
        toBackend: backendHint,
      });
      await importSwitchState(workspace, exportedSwitchState, PRE_RESTART_ATTACHMENTS);
      await driver.restart(workspace);
      await importSwitchState(workspace, exportedSwitchState, POST_RESTART_ATTACHMENTS);
    }
    await waitForWorkspaceReady(workspace, readyTimeoutMs);
  } finally {
    if (exportedSwitchState) {
      fs.rmSync(exportedSwitchState, { recursive: true, force: true });
    }
  }

  process.stdout.write(`${JSON.stringify({
    project,
    previousBackend: previousBackend ?? null,
    previousProfile: previousSelection?.profile ?? null,
    selectedBackend: backendHint,
    selectedProfile: backendHint === "pod" ? (profileHint ?? workspace.backend.profile) : null,
    stoppedBackends,
    selectionFile,
  }, null, 2)}\n`);
}
