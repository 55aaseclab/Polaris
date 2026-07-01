import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ensureCanonicalWorkspaceImage, ensureWorkspaceConfig } from "../config/provision.js";
import { assertProjectNameAvailableForUser } from "../config/project-ownership.js";
import { userProfileExists, workspaceConfigExists, workspaceConfigPath } from "../config/scaffold.js";
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
import { createWorkspaceForUser } from "../cli/commands/create.js";
import { performWorkspaceSwitch, type SwitchResult } from "../cli/commands/switch.js";
import { archiveWorkspaceOwnedByUser } from "../cli/commands/delete.js";
import { loadExecutableWorkspaceForCommand } from "../cli/commands/shared.js";
import { startCommand } from "../cli/commands/start.js";
import { statusCommand } from "../cli/commands/status.js";
import { stopCommand } from "../cli/commands/stop.js";
import { renderAndWriteDockerWorkspace } from "../backends/docker/render.js";
import { renderAndWritePodWorkspace } from "../backends/pod/render.js";
import { renderAndWriteKubevirtWorkspace } from "../backends/kubevirt/render.js";
import { getBackendDriver } from "../backends/index.js";
import type { WorkspaceSpec, WorkspaceStatus } from "../core/workspace.js";
import { workspaceRuntimeScopeName } from "../core/workspace-name.js";
import { writeWorkspaceLiveCredentialSelection, writeWorkspaceStatus } from "../output/state-store.js";
import { logInfo, logWarn } from "../utils/log.js";
import { polarisUsersRoot, repoRoot } from "../utils/paths.js";
import { withUserMutationLock } from "../utils/user-mutation-lock.js";
import {
  withWorkspaceLifecycleLock,
  withWorkspaceMutationLock,
} from "../utils/workspace-lifecycle-lock.js";

const REPO_ROOT = repoRoot(import.meta.url);
const USER_ROOT = polarisUsersRoot(import.meta.url);
const PROVISION_TOTAL_STEPS = 7;
const provisionJobs = new Map<string, Promise<void>>();
const statusRefreshJobs = new Map<string, Promise<void>>();

function provisionStepDelayMs(): number {
  const raw = process.env.POLARIS_TEST_PROVISION_STEP_DELAY_MS?.trim();
  if (!raw) {
    return 0;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function maybeDelayProvisionStep(
  userId: string,
  workspace: string,
  phase: string,
): Promise<void> {
  const delayMs = provisionStepDelayMs();
  if (!delayMs) {
    return;
  }
  logInfo("executor", "workspace-provision-step-delay", {
    userId,
    workspace,
    phase,
    delayMs,
  });
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function rootKey(userId: string, workspace: string): string {
  return `${userId}:${workspace}`;
}

function portalRoot(userId: string, workspace: string): string {
  return path.join(USER_ROOT, userId, "workspaces", workspace);
}

function portalStateProgress(
  userId: string,
  workspace: string,
): PortalProvisionProgress | null {
  return readWorkspaceProvisionProgress(userId, workspace);
}

function classifyProvisionError(error: unknown): {
  message: string;
  errorCode: string;
  retryable: boolean;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancelled/i.test(message)) {
    return {
      message,
      errorCode: "workspace-provision-cancelled",
      retryable: true,
    };
  }
  if (/docker build/i.test(message)) {
    return {
      message,
      errorCode: "image-build-failed",
      retryable: true,
    };
  }
  if (/docker compose|workspace .* does not have a selected driver|Image '.*' is not available/i.test(message)) {
    return {
      message,
      errorCode: "workspace-runtime-failed",
      retryable: true,
    };
  }
  return {
    message,
    errorCode: "workspace-provision-failed",
    retryable: true,
  };
}

function assertProvisionNotCancelled(userId: string, workspace: string): void {
  const current = portalStateProgress(userId, workspace);
  if (!current?.cancelRequested) {
    return;
  }
  updateProgress(userId, workspace, {
    status: "cancelled",
    phase: "cancelled",
    message: "workspace provisioning cancelled",
    done: true,
    cancellable: false,
    error: undefined,
    errorCode: "workspace-provision-cancelled",
    retryable: true,
  });
  throw new Error("workspace provisioning cancelled");
}

function updateProgress(
  userId: string,
  workspace: string,
  patch: Partial<PortalProvisionProgress>,
): PortalProvisionProgress {
  const current = portalStateProgress(userId, workspace) ?? {
    jobId: randomUUID(),
    userId,
    workspace,
    status: "queued",
    phase: "queued",
    step: 0,
    totalSteps: PROVISION_TOTAL_STEPS,
    percent: 0,
    message: "queued",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    done: false,
    cancelRequested: false,
    cancellable: true,
  };
  const next: PortalProvisionProgress = {
    ...current,
    ...patch,
    jobId: patch.jobId ?? current.jobId,
    userId,
    workspace,
    status: patch.status
      ?? (
        patch.done
          ? (patch.error ? "error" : current.cancelRequested ? "cancelled" : "completed")
          : patch.phase === "queued"
            ? "queued"
            : current.cancelRequested
              ? "cancelling"
              : "running"
      ),
    totalSteps: PROVISION_TOTAL_STEPS,
    percent:
      patch.percent ??
      Math.round(
        ((patch.step ?? current.step) / PROVISION_TOTAL_STEPS) * 100,
      ),
    startedAt: patch.startedAt ?? current.startedAt,
    updatedAt: new Date().toISOString(),
    done: patch.done ?? current.done,
    cancelRequested: patch.cancelRequested ?? current.cancelRequested,
    cancellable: patch.cancellable ?? (patch.done ? false : current.cancellable),
  };
  writeWorkspaceProvisionProgress(userId, workspace, next);
  logInfo("executor", "workspace-provision-progress", {
    userId,
    workspace,
    jobId: next.jobId,
    status: next.status,
    phase: next.phase,
    step: next.step,
    percent: next.percent,
    done: next.done,
    cancelRequested: next.cancelRequested,
    errorCode: next.errorCode,
    message: next.message,
  });
  return next;
}

function writeDirectWorkspaceStatus(
  userId: string,
  workspace: string,
  mutate: (current: WorkspaceStatus | null) => WorkspaceStatus,
): WorkspaceStatus {
  const current = loadWorkspaceSummary(userId, workspace).status;
  const next = mutate(current);
  writeWorkspaceStatus(next, userId);
  return next;
}

function writeCachedWorkspaceStatusUpdate(args: {
  userId: string;
  workspace: string;
  mutate: (current: WorkspaceStatus | null, summary: PortalWorkspaceDetail | ReturnType<typeof loadWorkspaceSummary>) => WorkspaceStatus | null;
  reason: string;
}): void {
  const summary = loadWorkspaceSummary(args.userId, args.workspace);
  const next = args.mutate(summary.status, summary);
  if (!next) {
    return;
  }
  writeWorkspaceStatus(next, args.userId);
  logInfo("executor", "workspace-status-cached", {
    userId: args.userId,
    workspace: args.workspace,
    reason: args.reason,
    state: next.state,
  });
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
  const ensuredConfig = ensureWorkspaceConfig(projectRef, userId);
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
  return `${workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName)}-docker`;
}

function runtimeScope(workspace: WorkspaceSpec): string {
  return workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName);
}

function runningPodName(workspace: WorkspaceSpec): string {
  return runChecked(
    "kubectl",
    [
      "-n",
      runtimeScope(workspace),
      "get",
      "pod",
      "-l",
      `app=${runtimeScope(workspace)}`,
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
        runtimeScope(workspace),
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
  ensureCanonicalWorkspaceImage(`${workspace}@docker`, userId);
  if (defaultDockerOnly) {
    return;
  }
  ensureCanonicalWorkspaceImage(`${workspace}@pod:gvisor`, userId);
  ensureCanonicalWorkspaceImage(`${workspace}@kubevirt-vm`, userId);
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
  ensureWorkspaceConfig(`${workspace}@docker`, userId);
  if (!defaultDockerOnly) {
    ensureWorkspaceConfig(`${workspace}@pod:gvisor`, userId);
    ensureWorkspaceConfig(`${workspace}@kubevirt-vm`, userId);
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
  return withWorkspaceMutationLock(
    import.meta.url,
    userId,
    workspace,
    async () => {
      const defaultDockerOnly = options?.defaultDockerOnly ?? false;
      const startAfterCreate = options?.startAfterCreate ?? false;
      writeDirectWorkspaceStatus(userId, workspace, (current) => ({
        project: workspace,
        backend: current?.backend ?? {
          kind: "docker",
          profile: "legacy",
        },
        driver: current?.driver,
        lifecycleAction: current?.lifecycleAction ?? "status",
        state: "creating",
        health: {
          backendLiveness: current?.health.backendLiveness ?? "missing",
          workspaceReadiness: "not-ready",
          daemonReadiness: current?.health.daemonReadiness ?? "unknown",
          reason: "workspace creation in progress",
        },
        paseo: current?.paseo,
        credentials: current?.credentials,
        details: current?.details ?? {},
        evolution: current?.evolution,
        ssh: current?.ssh,
        assets: current?.assets,
        drift: current?.drift,
        attachments: current?.attachments,
        runtimeAssembly: current?.runtimeAssembly,
        daemon: current?.daemon,
      }));
      if (!fs.existsSync(workspaceConfigPath(workspace, "docker", userId))) {
        await createWorkspaceForUser(workspace, userId);
      }

      updateProgress(userId, workspace, {
        status: "running",
        phase: "starting",
        step: 0,
        message: "starting workspace provisioning",
        cancellable: true,
      });
      assertProvisionNotCancelled(userId, workspace);

      updateProgress(userId, workspace, {
        status: "running",
        phase: "specs",
        step: 1,
        message: "ensuring driver specs",
      });
      await maybeDelayProvisionStep(userId, workspace, "specs");
      ensureWorkspaceTargetSpecs(userId, workspace, defaultDockerOnly);
      assertProvisionNotCancelled(userId, workspace);

      updateProgress(userId, workspace, {
        status: "running",
        phase: "images",
        step: 2,
        message: "ensuring workspace images",
      });
      await maybeDelayProvisionStep(userId, workspace, "images");
      ensureWorkspaceImageTargets(userId, workspace, defaultDockerOnly);
      assertProvisionNotCancelled(userId, workspace);

      updateProgress(userId, workspace, {
        status: "running",
        phase: "manifests",
        step: 3,
        message: "rendering backend manifests",
      });
      await maybeDelayProvisionStep(userId, workspace, "manifests");
      renderWorkspaceTargets(userId, workspace, defaultDockerOnly);
      assertProvisionNotCancelled(userId, workspace);

      updateProgress(userId, workspace, {
        status: "running",
        phase: "status",
        step: 4,
        message: "collecting workspace status",
      });
      await maybeDelayProvisionStep(userId, workspace, "status");
      await captureStdout(() => statusCommand(`${workspace}@docker`, userId));
      const summary = loadWorkspaceSummary(userId, workspace);
      if (summary.selectedDriver === null) {
        updateProgress(userId, workspace, {
          status: "running",
          phase: "selection",
          step: 5,
          message: "defaulting driver selection",
        });
        await maybeDelayProvisionStep(userId, workspace, "selection");
      }
      assertProvisionNotCancelled(userId, workspace);

      if (startAfterCreate) {
        updateProgress(userId, workspace, {
          status: "running",
          phase: "start",
          step: 6,
          message: "starting workspace",
          cancellable: false,
        });
        await maybeDelayProvisionStep(userId, workspace, "start");
        await startCommand(`${workspace}@docker`, userId);
      }

      updateProgress(userId, workspace, {
        status: "running",
        phase: "finalize",
        step: PROVISION_TOTAL_STEPS,
        message: "capturing final workspace status",
        cancellable: false,
      });
      await maybeDelayProvisionStep(userId, workspace, "finalize");
      const finalRef = workspaceRefFromTarget(
        workspace,
        summary.selectedDriver ?? { backend: "docker" },
      );
      await captureStdout(() => statusCommand(finalRef, userId));

      updateProgress(userId, workspace, {
        status: "completed",
        phase: "done",
        step: PROVISION_TOTAL_STEPS,
        message: "workspace provisioning complete",
        done: true,
        percent: 100,
        cancellable: false,
      });
    },
  );
}

async function startWorkspaceWithoutWait(
  projectRef: string,
  userProfileId?: string,
): Promise<void> {
  const { workspace, driver } = await loadExecutableWorkspaceForCommand(
    "start",
    projectRef,
    userProfileId,
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
      logWarn("executor", "workspace-status-refresh-skipped", {
        userId,
        workspace,
        reason: "no-selected-driver",
      });
      return;
    }
    const ref = workspaceRefFromTarget(workspace, summary.selectedDriver);
    logInfo("executor", "workspace-status-refresh-started", {
      userId,
      workspace,
      ref,
    });
    try {
      await captureStdout(() => statusCommand(ref, userId));
      logInfo("executor", "workspace-status-refresh-completed", {
        userId,
        workspace,
        ref,
      });
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

export async function reportPortalWorkspaceStatus(input: {
  userId: string;
  workspace: string;
  status: Partial<WorkspaceStatus>;
}): Promise<{ reported: true }> {
  const summary = loadWorkspaceSummary(input.userId, input.workspace);
  const next: WorkspaceStatus = {
    project: input.workspace,
    backend: {
      kind: summary.status?.backend.kind ?? "docker",
      profile: summary.status?.backend.profile ?? "legacy",
      ...(input.status.backend ?? {}),
    },
    lifecycleAction: input.status.lifecycleAction ?? summary.status?.lifecycleAction ?? "status",
    state: input.status.state ?? summary.status?.state ?? "not-applied",
    health: {
      backendLiveness: summary.status?.health.backendLiveness ?? "unknown",
      workspaceReadiness: summary.status?.health.workspaceReadiness ?? "unknown",
      daemonReadiness: summary.status?.health.daemonReadiness ?? "unknown",
      ...(input.status.health ?? {}),
    },
    details: {
      ...(summary.status?.details ?? {}),
      ...(input.status.details ?? {}),
    },
    ...(input.status.driver ? { driver: input.status.driver } : {}),
    ...(input.status.paseo ? { paseo: input.status.paseo } : {}),
    ...(input.status.credentials ? { credentials: input.status.credentials } : {}),
    ...(input.status.evolution ? { evolution: input.status.evolution } : {}),
    ...(input.status.ssh ? { ssh: input.status.ssh } : {}),
    ...(input.status.assets ? { assets: input.status.assets } : {}),
    ...(input.status.drift ? { drift: input.status.drift } : {}),
    ...(input.status.attachments ? { attachments: input.status.attachments } : {}),
    ...(input.status.runtimeAssembly ? { runtimeAssembly: input.status.runtimeAssembly } : {}),
    ...(input.status.daemon ? { daemon: input.status.daemon } : {}),
  };
  writeWorkspaceStatus(next, input.userId);
  logInfo("executor", "workspace-status-reported", {
    userId: input.userId,
    workspace: input.workspace,
    state: next.state,
  });
  return { reported: true };
}

export async function queueProvisionWorkspace(
  userId: string,
  workspace: string,
  options?: {
    defaultDockerOnly?: boolean;
    startAfterCreate?: boolean;
  },
): Promise<PortalProvisionProgress> {
  return withUserMutationLock(import.meta.url, userId, async () => {
    if (!userProfileExists(userId)) {
      throw new Error(`User profile '${userId}' was not found. Create it first with user create.`);
    }
    const key = rootKey(userId, workspace);
    const existing = provisionJobs.get(key);
    if (existing) {
      logInfo("executor", "workspace-provision-queue-reused", {
        userId,
        workspace,
      });
      return (
        readWorkspaceProvisionProgress(userId, workspace) ??
        updateProgress(userId, workspace, {
          status: "queued",
          phase: "queued",
          step: 0,
          percent: 0,
          done: false,
          error: undefined,
          message: "workspace provisioning queued",
          cancellable: true,
        })
      );
    }
    assertProjectNameAvailableForUser(workspace, userId);
    if (workspaceConfigExists(workspace, userId)) {
      throw new Error(`Workspace '${workspace}' already exists for user ${userId}.`);
    }

    const queuedProgress = updateProgress(userId, workspace, {
      status: "queued",
      phase: "queued",
      step: 0,
      percent: 0,
      done: false,
      error: undefined,
      message: "workspace provisioning queued",
      cancellable: true,
    });
    logInfo("executor", "workspace-provision-queued", {
      userId,
      workspace,
      jobId: queuedProgress.jobId,
      defaultDockerOnly: options?.defaultDockerOnly ?? false,
      startAfterCreate: options?.startAfterCreate ?? false,
    });
    void startProvisionWorkspace(userId, workspace, options);
    return queuedProgress;
  });
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
      const classified = classifyProvisionError(error);
      if (/cancelled/i.test(classified.errorCode)) {
        return;
      }
      updateProgress(userId, workspace, {
        status: "error",
        phase: "error",
        done: true,
        cancellable: false,
        message: classified.message,
        error: classified.message,
        errorCode: classified.errorCode,
        retryable: classified.retryable,
      });
      writeDirectWorkspaceStatus(userId, workspace, (current) => ({
        project: workspace,
        backend: current?.backend ?? {
          kind: "docker",
          profile: "legacy",
        },
        driver: current?.driver,
        lifecycleAction: current?.lifecycleAction ?? "status",
        state: "degraded",
        health: {
          backendLiveness: current?.health.backendLiveness ?? "missing",
          workspaceReadiness: "not-ready",
          daemonReadiness: current?.health.daemonReadiness ?? "degraded",
          reason: classified.message,
        },
        paseo: current?.paseo,
        credentials: current?.credentials,
        details: current?.details ?? {},
        evolution: current?.evolution,
        ssh: current?.ssh,
        assets: current?.assets,
        drift: current?.drift,
        attachments: current?.attachments,
        runtimeAssembly: current?.runtimeAssembly,
        daemon: current?.daemon,
      }));
      throw error;
    } finally {
      provisionJobs.delete(key);
    }
  })();
  job.catch(() => undefined);
  provisionJobs.set(key, job);
  return job;
}

export async function cancelProvisionWorkspace(
  userId: string,
  workspace: string,
): Promise<PortalProvisionProgress> {
  const current = portalStateProgress(userId, workspace);
  if (!current) {
    throw new Error(`Workspace '${workspace}' does not have an active provision job`);
  }
  if (current.done) {
    logInfo("executor", "workspace-provision-cancel-ignored", {
      userId,
      workspace,
      reason: "job-already-done",
      status: current.status,
    });
    return current;
  }
  const cancelled = updateProgress(userId, workspace, {
    status: "cancelling",
    cancelRequested: true,
    message: "cancelling workspace provisioning",
    cancellable: false,
  });
  logInfo("executor", "workspace-provision-cancel-requested", {
    userId,
    workspace,
    jobId: cancelled.jobId,
  });
  return cancelled;
}

export async function switchPortalWorkspace(
  userId: string,
  workspace: string,
  target: PortalDriverTarget,
): Promise<SwitchResult> {
  const ref = workspaceRefFromTarget(workspace, target);
  return performWorkspaceSwitch(ref, userId);
}

export async function deletePortalWorkspace(
  userId: string,
  workspace: string,
): Promise<{
  archived: true;
  archiveId: string;
  archivedAt: string;
  workspace: string;
}> {
  writeCachedWorkspaceStatusUpdate({
    userId,
    workspace,
    reason: "workspace-archiving",
    mutate: (current) => {
      if (!current) {
        return null;
      }
      return {
        ...current,
        state: "archiving",
        health: {
          ...current.health,
          workspaceReadiness: "not-ready",
          reason: "workspace archiving",
        },
      };
    },
  });
  return archiveWorkspaceOwnedByUser(userId, workspace);
}

export async function stopPortalWorkspace(
  userId: string,
  workspace: string,
): Promise<{ stopped: true }> {
  return withWorkspaceLifecycleLock(import.meta.url, userId, workspace, async () => {
    const summary = loadWorkspaceSummary(userId, workspace);
    if (!summary.selectedDriver) {
      throw new Error(`Workspace '${workspace}' does not have a selected driver`);
    }
    const ref = workspaceRefFromTarget(workspace, summary.selectedDriver);
    logInfo("executor", "workspace-stop-started", {
      userId,
      workspace,
      ref,
    });
    writeCachedWorkspaceStatusUpdate({
      userId,
      workspace,
      reason: "workspace-stopping",
      mutate: (current, currentSummary) => {
        if (!current) {
          return null;
        }
        return {
          ...current,
          backend: {
            ...current.backend,
            kind: currentSummary.selectedDriver?.backend ?? current.backend.kind,
          },
          state: "stopping",
          health: {
            ...current.health,
            workspaceReadiness: "not-ready",
            reason: "workspace stop requested",
          },
        };
      },
    });
    await stopCommand(ref, userId);
    await refreshPortalWorkspaceStatus(userId, workspace);
    logInfo("executor", "workspace-stop-completed", {
      userId,
      workspace,
      ref,
    });
    return { stopped: true };
  });
}

export async function startPortalWorkspace(
  userId: string,
  workspace: string,
): Promise<{ started: true }> {
  return withWorkspaceLifecycleLock(import.meta.url, userId, workspace, async () => {
    const summary = loadWorkspaceSummary(userId, workspace);
    if (!summary.selectedDriver) {
      throw new Error(`Workspace '${workspace}' does not have a selected driver`);
    }
    const ref = workspaceRefFromTarget(workspace, summary.selectedDriver);
    logInfo("executor", "workspace-start-started", {
      userId,
      workspace,
      ref,
    });
    writeCachedWorkspaceStatusUpdate({
      userId,
      workspace,
      reason: "workspace-starting",
      mutate: (current, currentSummary) => {
        if (!current) {
          return null;
        }
        return {
          ...current,
          backend: {
            ...current.backend,
            kind: currentSummary.selectedDriver?.backend ?? current.backend.kind,
          },
          state: "starting",
          health: {
            ...current.health,
            backendLiveness: "starting",
            workspaceReadiness: "not-ready",
            daemonReadiness: current.health.daemonReadiness || "unknown",
            reason: "workspace start requested",
          },
        };
      },
    });
    await startCommand(ref, userId);
    await refreshPortalWorkspaceStatus(userId, workspace);
    logInfo("executor", "workspace-start-completed", {
      userId,
      workspace,
      ref,
    });
    return { started: true };
  });
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
  return withWorkspaceLifecycleLock(
    import.meta.url,
    input.userId,
    input.workspace,
    async () => {
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
      writeCachedWorkspaceStatusUpdate({
        userId: input.userId,
        workspace: input.workspace,
        reason: "live-credential-switched",
        mutate: (current) => {
          if (!current?.credentials?.live) {
            return current;
          }
          const selectedByHarness = {
            ...(current.credentials.live.selectedByHarness ?? {}),
            [input.harness]: {
              credentialId: input.credentialId,
              label:
                current.credentials.live.selectedByHarness?.[input.harness]
                  ?.label ?? input.credentialId,
              source: "runtime-state" as const,
            },
          };
          return {
            ...current,
            credentials: {
              ...current.credentials,
              live: {
                ...current.credentials.live,
                selectedHarness: input.harness,
                selectedCredentialId: input.credentialId,
                selectedCredentialLabel: selectedByHarness[input.harness].label,
                source: "runtime-state",
                selectedByHarness,
              },
            },
          };
        },
      });
      void refreshPortalWorkspaceStatus(input.userId, input.workspace);
      return {
        switched: true,
        driver: ref,
        credentialId: input.credentialId,
      };
    },
  );
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
  return withWorkspaceLifecycleLock(
    import.meta.url,
    input.userId,
    input.workspace,
    async () => {
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
        await stopCommand(ref, input.userId);
      }
      const updated = updatePortalWorkspaceAgentBinding({
        userId: input.userId,
        workspace: input.workspace,
        target,
        credentialId: input.credentialId,
        enabled: true,
      });
      renderWorkspaceTarget(input.userId, input.workspace, target);
      await startWorkspaceWithoutWait(ref, input.userId);
      return {
        enabled: true,
        driver: ref,
        credentialBindings: updated.credentialBindings,
        restarted,
      };
    },
  );
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
  return withWorkspaceLifecycleLock(
    import.meta.url,
    input.userId,
    input.workspace,
    async () => {
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
        await stopCommand(ref, input.userId);
      }
      const updated = updatePortalWorkspaceAgentBinding({
        userId: input.userId,
        workspace: input.workspace,
        target,
        enabled: false,
      });
      renderWorkspaceTarget(input.userId, input.workspace, target);
      await startWorkspaceWithoutWait(ref, input.userId);
      return {
        enabled: false,
        driver: ref,
        credentialBindings: updated.credentialBindings,
        restarted,
      };
    },
  );
}

export async function healthCheckPortalWorkspaceExecutor(
  baseUrl: string,
  headers: HeadersInit,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/health`, {
      method: "GET",
      headers,
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Polaris executor health check failed for ${baseUrl}/health: ${cause}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Polaris executor health check failed (${response.status} ${response.statusText}) for ${baseUrl}/health: ${await response.text()}`,
    );
  }
  const payload = await response.json() as { ok?: boolean };
  if (payload.ok !== true) {
    throw new Error(
      `Polaris executor health check returned an unexpected payload for ${baseUrl}/health`,
    );
  }
}
