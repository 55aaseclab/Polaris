import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureCanonicalWorkspaceImage, ensureWorkspaceConfig } from "../config/provision.js";
import { workspaceConfigPath } from "../config/scaffold.js";
import { readManagedCredentialRecord } from "../config/credentials.js";
import {
  supportsLiveCredentialSwitch,
  type ManagedHarness,
} from "../config/credential-catalog.js";
import {
  defaultMountPathForCredentialFile,
  stateStoragePathForMountPath,
} from "../core/identity-layout.js";
import {
  loadWorkspaceDetail,
  loadPortalWorkspaceByTarget,
  loadWorkspaceSummary,
  readWorkspaceProvisionProgress,
  type PortalDriverTarget,
  type PortalProvisionProgress,
  type PortalWorkspaceDetail,
  updatePortalWorkspaceAgentBinding,
  workspaceRefFromTarget,
  writeWorkspaceProvisionProgress,
} from "../core/portal.js";
import { loadWorkspaceFromConfigPath } from "../config/load.js";
import { createCommand } from "../cli/commands/create.js";
import { performWorkspaceSwitch, type SwitchResult } from "../cli/commands/switch.js";
import { deleteWorkspaceOwnedByUser } from "../cli/commands/delete.js";
import { loadExecutableWorkspaceForCommand } from "../cli/commands/shared.js";
import { startCommand } from "../cli/commands/start.js";
import { statusCommand } from "../cli/commands/status.js";
import { stopCommand } from "../cli/commands/stop.js";
import { renderAndWriteDockerWorkspace } from "../backends/docker/render.js";
import { renderAndWritePodWorkspace } from "../backends/pod/render.js";
import { renderAndWriteKubevirtWorkspace } from "../backends/kubevirt/render.js";
import { getBackendDriver } from "../backends/index.js";
import type { WorkspaceSpec } from "../core/workspace.js";
import { writeWorkspaceLiveCredentialSelection } from "../output/state-store.js";
import { logWarn } from "../utils/log.js";
import { resolveRepoRoot } from "../utils/repo-root.js";

const REPO_ROOT = resolveRepoRoot(import.meta.url);
const PROVISION_TOTAL_STEPS = 7;
const provisionJobs = new Map<string, Promise<void>>();
const statusRefreshJobs = new Map<string, Promise<void>>();

function rootKey(userId: string, workspace: string): string {
  return `${userId}:${workspace}`;
}

function portalRoot(userId: string, workspace: string): string {
  return path.join(REPO_ROOT, "config", "users", userId, "workspaces", workspace);
}

function portalStateProgress(
  userId: string,
  workspace: string,
): PortalProvisionProgress | null {
  return readWorkspaceProvisionProgress(userId, workspace);
}

function updateProgress(
  userId: string,
  workspace: string,
  patch: Partial<PortalProvisionProgress>,
): PortalProvisionProgress {
  const current = portalStateProgress(userId, workspace) ?? {
    userId,
    workspace,
    phase: "queued",
    step: 0,
    totalSteps: PROVISION_TOTAL_STEPS,
    percent: 0,
    message: "queued",
    updatedAt: new Date().toISOString(),
    done: false,
  };
  const next: PortalProvisionProgress = {
    ...current,
    ...patch,
    userId,
    workspace,
    totalSteps: PROVISION_TOTAL_STEPS,
    percent:
      patch.percent ??
      Math.round(
        ((patch.step ?? current.step) / PROVISION_TOTAL_STEPS) * 100,
      ),
    updatedAt: new Date().toISOString(),
    done: patch.done ?? current.done,
  };
  writeWorkspaceProvisionProgress(userId, workspace, next);
  return next;
}

function runChecked(
  command: string,
  args: string[],
): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(
      `Failed to execute '${command} ${args.join(" ")}': ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "")
        .trim() || `Command failed (${result.status ?? 1}): ${command} ${args.join(" ")}`,
    );
  }
  return {
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

async function captureStdout<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string }> {
  const stdoutChunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    stdoutChunks.push(
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString("utf8"),
    );
    const callback = args.find(
      (arg) => typeof arg === "function",
    ) as (() => void) | undefined;
    callback?.();
    return true;
  }) as typeof process.stdout.write;

  try {
    const result = await fn();
    return { result, stdout: stdoutChunks.join("").trim() };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function ensureImageRefAvailable(imageRef: string): void {
  const inspect = spawnSync("docker", ["image", "inspect", imageRef], {
    encoding: "utf8",
  });
  if (inspect.status === 0) {
    return;
  }
  const pull = spawnSync("docker", ["pull", imageRef], { encoding: "utf8" });
  if (pull.status === 0) {
    return;
  }
  throw new Error(`Image '${imageRef}' is not available`);
}

function loadUserWorkspace(
  userId: string,
  workspace: string,
  backend: "docker" | "pod" | "kubevirt-vm",
  profileHint?: string,
): WorkspaceSpec {
  const projectRef =
    backend === "pod" && profileHint
      ? `${workspace}@${backend}:${profileHint}`
      : `${workspace}@${backend}`;
  const ensuredConfig = ensureWorkspaceConfig(projectRef);
  const configPath =
    ensuredConfig?.configPath ?? workspaceConfigPath(workspace, backend, userId);
  return loadWorkspaceFromConfigPath(
    configPath,
    workspace,
    backend,
    profileHint,
  );
}

function liveRuntimeCredentialFiles(
  workspace: WorkspaceSpec,
  userId: string,
  credentialId: string,
  requestedHarness?: ManagedHarness,
  requireSupported = false,
): {
  harness: ManagedHarness;
  files: Array<{ path: string; content: string }>;
} {
  const record = readManagedCredentialRecord({
    userProfileId: userId,
    credentialId,
  });
  if (requestedHarness && record.summary.harness !== requestedHarness) {
    throw new Error(
      `Credential '${credentialId}' belongs to harness '${record.summary.harness}', not '${requestedHarness}'`,
    );
  }
  if (
    requireSupported
    && !supportsLiveCredentialSwitch(record.summary.harness)
  ) {
    throw new Error(
      `Credential '${credentialId}' does not support live runtime switching`,
    );
  }
  const files = record.files.map((file) => {
    const mountPath =
      file.mountPath?.trim()
      || defaultMountPathForCredentialFile(
        record.summary.kind,
        workspace.runtime.home,
        file.key,
      );
    const targetPath = stateStoragePathForMountPath({
      mountPath,
      runtimeHome: workspace.runtime.home,
      identityRoot: workspace.attachments.userIdentityState.mountRoot,
    });
    if (
      !targetPath
      || !targetPath.startsWith(
        `${workspace.attachments.userIdentityState.mountRoot}/`,
      )
    ) {
      throw new Error(
        `Credential '${credentialId}' file '${file.key}' does not map into workspace identity state`,
      );
    }
    return {
      path: targetPath,
      content: file.content,
    };
  });
  if (files.length === 0) {
    throw new Error(
      `Credential '${credentialId}' does not contain live runtime material files`,
    );
  }
  return {
    harness: record.summary.harness,
    files,
  };
}

function runtimeWriteScript(
  workspace: WorkspaceSpec,
  files: Array<{ path: string; content: string }>,
): string {
  const payload = JSON.stringify(
    files.map((file) => ({
      path: file.path,
      content: Buffer.from(file.content, "utf8").toString("base64"),
    })),
  );
  const runtimeUser = workspace.runtime.user.trim() || "root";
  return [
    "python3 - <<'PY'",
    "import base64, json, os, pathlib, pwd, stat",
    `files = json.loads(${JSON.stringify(payload)})`,
    `runtime_user = ${JSON.stringify(runtimeUser)}`,
    "uid = gid = None",
    "if runtime_user and runtime_user != 'root':",
    "    try:",
    "        account = pwd.getpwnam(runtime_user)",
    "        uid = account.pw_uid",
    "        gid = account.pw_gid",
    "    except KeyError:",
    "        uid = gid = None",
    "",
    "def is_ssh_path(path: pathlib.Path) -> bool:",
    "    return 'ssh' in path.parts",
    "",
    "def desired_mode(path: pathlib.Path) -> int:",
    "    name = path.name",
    "    if name.endswith('.pub'):",
    "        return stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH",
    "    if name in {'authorized_keys', 'known_hosts', 'known_hosts.old'}:",
    "        return stat.S_IRUSR | stat.S_IWUSR",
    "    if is_ssh_path(path):",
    "        return stat.S_IRUSR | stat.S_IWUSR",
    "    return stat.S_IRUSR | stat.S_IWUSR",
    "",
    "for entry in files:",
    "    path = pathlib.Path(entry['path'])",
    "    path.parent.mkdir(parents=True, exist_ok=True)",
    "    if is_ssh_path(path):",
    "        path.parent.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)",
    "    path.write_bytes(base64.b64decode(entry['content']))",
    "    if uid is not None and gid is not None:",
    "        try:",
    "            os.chown(path.parent, uid, gid)",
    "        except FileNotFoundError:",
    "            pass",
    "        os.chown(path, uid, gid)",
    "    path.chmod(desired_mode(path))",
    "PY",
  ].join("\n");
}

function dockerContainerName(workspace: WorkspaceSpec): string {
  return `${workspace.identity.projectName}-docker`;
}

function runningPodName(workspace: WorkspaceSpec): string {
  return runChecked(
    "kubectl",
    [
      "-n",
      workspace.identity.projectName,
      "get",
      "pod",
      "-l",
      `app=${workspace.identity.projectName}`,
      "-o",
      "jsonpath={.items[0].metadata.name}",
    ],
  ).stdout.trim();
}

function applyLiveRuntimeFiles(
  workspace: WorkspaceSpec,
  files: Array<{ path: string; content: string }>,
): void {
  const script = runtimeWriteScript(workspace, files);
  if (workspace.backend.kind === "docker") {
    const containerName = dockerContainerName(workspace);
    runChecked("docker", ["exec", containerName, "sh", "-lc", script]);
    return;
  }
  if (workspace.backend.kind === "pod") {
    const podName = runningPodName(workspace);
    if (!podName) {
      throw new Error(
        `Workspace '${workspace.identity.projectName}' does not have a running pod`,
      );
    }
    runChecked(
      "kubectl",
      [
        "-n",
        workspace.identity.projectName,
        "exec",
        podName,
        "--",
        "sh",
        "-lc",
        script,
      ],
    );
    return;
  }
  throw new Error(
    `Live credential switching is not supported for backend '${workspace.backend.kind}'`,
  );
}

export function switchWorkspaceLiveCredentialMaterial(input: {
  workspace: WorkspaceSpec;
  userId: string;
  credentialId: string;
  harness?: ManagedHarness;
  requireSupported?: boolean;
}): {
  harness: ManagedHarness;
  credentialId: string;
} {
  const resolved = liveRuntimeCredentialFiles(
    input.workspace,
    input.userId,
    input.credentialId,
    input.harness,
    input.requireSupported ?? false,
  );
  applyLiveRuntimeFiles(input.workspace, resolved.files);
  writeWorkspaceLiveCredentialSelection(
    input.workspace.identity.projectName,
    resolved.harness,
    input.credentialId,
    input.userId,
  );
  return {
    harness: resolved.harness,
    credentialId: input.credentialId,
  };
}

function renderWorkspaceTargets(
  userId: string,
  workspace: string,
  defaultDockerOnly = false,
): void {
  const dockerWorkspace = loadUserWorkspace(userId, workspace, "docker");
  renderAndWriteDockerWorkspace(dockerWorkspace);
  if (defaultDockerOnly) {
    return;
  }
  const podWorkspace = loadUserWorkspace(
    userId,
    workspace,
    "pod",
    "gvisor",
  );
  renderAndWritePodWorkspace(podWorkspace);
  const kubevirtWorkspace = loadUserWorkspace(
    userId,
    workspace,
    "kubevirt-vm",
  );
  renderAndWriteKubevirtWorkspace(kubevirtWorkspace);
}

function renderWorkspaceTarget(
  userId: string,
  workspace: string,
  target: PortalDriverTarget,
): void {
  if (target.backend === "docker") {
    renderAndWriteDockerWorkspace(loadUserWorkspace(userId, workspace, "docker"));
    return;
  }
  if (target.backend === "pod") {
    renderAndWritePodWorkspace(
      loadUserWorkspace(userId, workspace, "pod", target.profile ?? "gvisor"),
    );
    return;
  }
  renderAndWriteKubevirtWorkspace(
    loadUserWorkspace(userId, workspace, "kubevirt-vm"),
  );
}

async function shouldRecycleRunningWorkspace(
  userId: string,
  workspace: string,
  target: PortalDriverTarget,
): Promise<boolean> {
  const loaded = loadUserWorkspace(
    userId,
    workspace,
    target.backend,
    target.profile,
  );
  const observation = await getBackendDriver(loaded.backend.kind).inspect(loaded);
  return Boolean(observation.backend.exists && observation.backend.running);
}

function ensureWorkspaceImageTargets(
  userId: string,
  workspace: string,
  defaultDockerOnly = false,
): void {
  ensureCanonicalWorkspaceImage(`${workspace}@docker`);
  if (defaultDockerOnly) {
    return;
  }
  ensureCanonicalWorkspaceImage(`${workspace}@pod:gvisor`);
  ensureCanonicalWorkspaceImage(`${workspace}@kubevirt-vm`);
  const kubevirtWorkspace = loadUserWorkspace(
    userId,
    workspace,
    "kubevirt-vm",
  );
  ensureImageRefAvailable(
    kubevirtWorkspace.runtime.rootdiskImage ??
      "quay.io/containerdisks/debian:13",
  );
}

function ensureWorkspaceTargetSpecs(
  userId: string,
  workspace: string,
  defaultDockerOnly = false,
): void {
  fs.mkdirSync(portalRoot(userId, workspace), { recursive: true });
  ensureWorkspaceConfig(`${workspace}@docker`);
  if (!defaultDockerOnly) {
    ensureWorkspaceConfig(`${workspace}@pod:gvisor`);
    ensureWorkspaceConfig(`${workspace}@kubevirt-vm`);
  }
  const selectionPath = path.join(
    portalRoot(userId, workspace),
    "state",
    "selection.json",
  );
  if (!fs.existsSync(selectionPath)) {
    fs.mkdirSync(path.dirname(selectionPath), { recursive: true });
    fs.writeFileSync(
      selectionPath,
      `${JSON.stringify({ backend: "docker" }, null, 2)}\n`,
      "utf8",
    );
  }
}

async function provisionWorkspaceInternal(
  userId: string,
  workspace: string,
  options?: {
    defaultDockerOnly?: boolean;
    startAfterCreate?: boolean;
  },
): Promise<void> {
  const defaultDockerOnly = options?.defaultDockerOnly ?? false;
  const startAfterCreate = options?.startAfterCreate ?? false;
  if (!fs.existsSync(workspaceConfigPath(workspace, "docker", userId))) {
    await createCommand([workspace, "--user", userId]);
  }

  updateProgress(userId, workspace, {
    phase: "starting",
    step: 0,
    message: "starting workspace provisioning",
  });

  updateProgress(userId, workspace, {
    phase: "specs",
    step: 1,
    message: "ensuring driver specs",
  });
  ensureWorkspaceTargetSpecs(userId, workspace, defaultDockerOnly);

  updateProgress(userId, workspace, {
    phase: "images",
    step: 2,
    message: "ensuring workspace images",
  });
  ensureWorkspaceImageTargets(userId, workspace, defaultDockerOnly);

  updateProgress(userId, workspace, {
    phase: "manifests",
    step: 3,
    message: "rendering backend manifests",
  });
  renderWorkspaceTargets(userId, workspace, defaultDockerOnly);

  updateProgress(userId, workspace, {
    phase: "status",
    step: 4,
    message: "collecting workspace status",
  });
  const summary = loadWorkspaceSummary(userId, workspace);
  if (summary.selectedDriver === null) {
    updateProgress(userId, workspace, {
      phase: "selection",
      step: 5,
      message: "defaulting driver selection",
    });
  }

  if (startAfterCreate) {
    updateProgress(userId, workspace, {
      phase: "start",
      step: 6,
      message: "starting workspace",
    });
    await startCommand(`${workspace}@docker`);
  }

  updateProgress(userId, workspace, {
    phase: "done",
    step: PROVISION_TOTAL_STEPS,
    message: "workspace provisioning complete",
    done: true,
    percent: 100,
  });
}

async function startWorkspaceWithoutWait(projectRef: string): Promise<void> {
  const { workspace, driver } = await loadExecutableWorkspaceForCommand(
    "start",
    projectRef,
  );
  await driver.start(workspace);
}

export async function refreshPortalWorkspaceStatus(
  userId: string,
  workspace: string,
): Promise<void> {
  const key = rootKey(userId, workspace);
  const existing = statusRefreshJobs.get(key);
  if (existing) {
    return existing;
  }
  const job = (async () => {
    const summary = loadWorkspaceSummary(userId, workspace);
    if (!summary.selectedDriver) {
      return;
    }
    const ref = workspaceRefFromTarget(workspace, summary.selectedDriver);
    try {
      await captureStdout(() => statusCommand(ref));
    } catch (error) {
      logWarn("executor", "workspace-status-refresh-failed", {
        userId,
        workspace,
        ref,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      statusRefreshJobs.delete(key);
    }
  })();
  statusRefreshJobs.set(key, job);
  return job;
}

export async function queueProvisionWorkspace(
  userId: string,
  workspace: string,
  options?: {
    defaultDockerOnly?: boolean;
    startAfterCreate?: boolean;
  },
): Promise<PortalProvisionProgress> {
  const key = rootKey(userId, workspace);
  const existing = provisionJobs.get(key);
  if (existing) {
    return (
      readWorkspaceProvisionProgress(userId, workspace) ??
      updateProgress(userId, workspace, {
        phase: "queued",
        step: 0,
        percent: 0,
        done: false,
        error: undefined,
        message: "workspace provisioning queued",
      })
    );
  }

  const queuedProgress = updateProgress(userId, workspace, {
    phase: "queued",
    step: 0,
    percent: 0,
    done: false,
    error: undefined,
    message: "workspace provisioning queued",
  });
  void startProvisionWorkspace(userId, workspace, options);
  return queuedProgress;
}

export function startProvisionWorkspace(
  userId: string,
  workspace: string,
  options?: {
    defaultDockerOnly?: boolean;
    startAfterCreate?: boolean;
  },
): Promise<void> {
  const key = rootKey(userId, workspace);
  const existing = provisionJobs.get(key);
  if (existing) {
    return existing;
  }
  const job = (async () => {
    try {
      await provisionWorkspaceInternal(userId, workspace, options);
    } catch (error) {
      updateProgress(userId, workspace, {
        phase: "error",
        done: true,
        message: error instanceof Error ? error.message : String(error),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      provisionJobs.delete(key);
    }
  })();
  job.catch(() => undefined);
  provisionJobs.set(key, job);
  return job;
}

export async function switchPortalWorkspace(
  _userId: string,
  workspace: string,
  target: PortalDriverTarget,
): Promise<SwitchResult> {
  const ref = workspaceRefFromTarget(workspace, target);
  return performWorkspaceSwitch(ref);
}

export async function deletePortalWorkspace(
  userId: string,
  workspace: string,
): Promise<{ removed: true }> {
  await deleteWorkspaceOwnedByUser(userId, workspace);
  return { removed: true };
}

export async function stopPortalWorkspace(
  userId: string,
  workspace: string,
): Promise<{ stopped: true }> {
  const summary = loadWorkspaceSummary(userId, workspace);
  if (!summary.selectedDriver) {
    throw new Error(`Workspace '${workspace}' does not have a selected driver`);
  }
  const ref = workspaceRefFromTarget(workspace, summary.selectedDriver);
  await stopCommand(ref);
  await captureStdout(() => statusCommand(ref));
  return { stopped: true };
}

export async function startPortalWorkspace(
  userId: string,
  workspace: string,
): Promise<{ started: true }> {
  const summary = loadWorkspaceSummary(userId, workspace);
  if (!summary.selectedDriver) {
    throw new Error(`Workspace '${workspace}' does not have a selected driver`);
  }
  const ref = workspaceRefFromTarget(workspace, summary.selectedDriver);
  await startCommand(ref);
  await captureStdout(() => statusCommand(ref));
  return { started: true };
}

export async function switchPortalWorkspaceLiveCredential(input: {
  userId: string;
  workspace: string;
  harness: ManagedHarness;
  credentialId: string;
}): Promise<{
  switched: true;
  driver: string;
  credentialId: string;
}> {
  if (!supportsLiveCredentialSwitch(input.harness)) {
    throw new Error(
      `Live credential switching is not supported for harness '${input.harness}'`,
    );
  }
  const summary = loadWorkspaceSummary(input.userId, input.workspace);
  const target = summary.selectedDriver;
  if (!target) {
    throw new Error(
      `Workspace '${input.workspace}' does not have a selected driver`,
    );
  }
  const workspaceSpec = loadPortalWorkspaceByTarget(
    input.userId,
    input.workspace,
    target,
  );
  if (
    workspaceSpec.backend.kind !== "docker" &&
    workspaceSpec.backend.kind !== "pod"
  ) {
    throw new Error(
      `Live credential switching is not supported for backend '${workspaceSpec.backend.kind}'`,
    );
  }
  const observation = await getBackendDriver(workspaceSpec.backend.kind).inspect(
    workspaceSpec,
  );
  if (!observation.backend.exists || !observation.backend.running) {
    throw new Error(
      `Workspace '${input.workspace}' is not running on ${workspaceSpec.backend.kind}`,
    );
  }
  switchWorkspaceLiveCredentialMaterial({
    workspace: workspaceSpec,
    userId: input.userId,
    credentialId: input.credentialId,
    harness: input.harness,
    requireSupported: true,
  });
  const ref = workspaceRefFromTarget(input.workspace, target);
  await captureStdout(() => statusCommand(ref));
  return {
    switched: true,
    driver: ref,
    credentialId: input.credentialId,
  };
}

export async function bindPortalWorkspaceAgent(input: {
  userId: string;
  workspace: string;
  credentialId: string;
  driver?: PortalDriverTarget;
}): Promise<{
  enabled: true;
  driver: string;
  credentialBindings: PortalWorkspaceDetail["credentialBindings"];
  restarted: boolean;
}> {
  const summary = loadWorkspaceSummary(input.userId, input.workspace);
  const target = input.driver ?? summary.selectedDriver;
  if (!target) {
    throw new Error(
      `Workspace '${input.workspace}' does not have a selected driver`,
    );
  }
  const ref = workspaceRefFromTarget(input.workspace, target);
  const restarted = await shouldRecycleRunningWorkspace(
    input.userId,
    input.workspace,
    target,
  );
  if (restarted) {
    await stopCommand(ref);
  }
  const updated = updatePortalWorkspaceAgentBinding({
    userId: input.userId,
    workspace: input.workspace,
    target,
    credentialId: input.credentialId,
    enabled: true,
  });
  renderWorkspaceTarget(input.userId, input.workspace, target);
  await startWorkspaceWithoutWait(ref);
  return {
    enabled: true,
    driver: ref,
    credentialBindings: updated.credentialBindings,
    restarted,
  };
}

export async function unbindPortalWorkspaceAgent(input: {
  userId: string;
  workspace: string;
  driver?: PortalDriverTarget;
}): Promise<{
  enabled: false;
  driver: string;
  credentialBindings: PortalWorkspaceDetail["credentialBindings"];
  restarted: boolean;
}> {
  const summary = loadWorkspaceSummary(input.userId, input.workspace);
  const target = input.driver ?? summary.selectedDriver;
  if (!target) {
    throw new Error(
      `Workspace '${input.workspace}' does not have a selected driver`,
    );
  }
  const ref = workspaceRefFromTarget(input.workspace, target);
  const restarted = await shouldRecycleRunningWorkspace(
    input.userId,
    input.workspace,
    target,
  );
  if (restarted) {
    await stopCommand(ref);
  }
  const updated = updatePortalWorkspaceAgentBinding({
    userId: input.userId,
    workspace: input.workspace,
    target,
    enabled: false,
  });
  renderWorkspaceTarget(input.userId, input.workspace, target);
  await startWorkspaceWithoutWait(ref);
  return {
    enabled: false,
    driver: ref,
    credentialBindings: updated.credentialBindings,
    restarted,
  };
}
