import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureCanonicalWorkspaceImage, ensureWorkspaceConfig } from "../config/provision.js";
import { workspaceConfigPath } from "../config/scaffold.js";
import {
  loadWorkspaceDetail,
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
  await stopCommand(workspaceRefFromTarget(workspace, summary.selectedDriver));
  return { stopped: true };
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
