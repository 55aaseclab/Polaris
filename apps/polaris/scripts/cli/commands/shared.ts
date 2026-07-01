import { getBackendDriver } from "../../backends/index.js";
import { loadWorkspaceFromConfigPath, resolveWorkspaceConfigPath } from "../../config/load.js";
import { ensureProvisionedWorkspace, ensureWorkspaceConfig } from "../../config/provision.js";
import { computeWorkspaceDrift, synthesizeWorkspaceStatus } from "../../core/runtime-controller.js";
import type { WorkspaceSpec, WorkspaceStatus } from "../../core/workspace.js";
import {
  appendEvolutionEvent,
  createEvolutionSessionId,
  finalizeEvolutionSession,
  prepareEvolutionMemorySnapshot,
} from "../../evolution/runtime.js";
import { logDebug, logInfo, logWarn } from "../../utils/log.js";

export function loadWorkspaceForProjectRef(
  projectRef: string,
  userProfileId?: string,
): WorkspaceSpec {
  const resolved = resolveWorkspaceConfigPath(projectRef, userProfileId);
  return loadWorkspaceFromConfigPath(
    resolved.configPath,
    resolved.project,
    resolved.backendHint,
    resolved.profileHint,
  );
}

export function loadWorkspaceForCommand(
  command: WorkspaceStatus["lifecycleAction"],
  projectRef: string,
  userProfileId?: string,
): {
  workspace: WorkspaceSpec;
  driver: ReturnType<typeof getBackendDriver>;
} {
  logInfo("cli", "load-workspace", { command, projectRef, userProfileId });
  ensureWorkspaceConfig(projectRef, userProfileId);
  const workspace = loadWorkspaceForProjectRef(projectRef, userProfileId);
  const driver = getBackendDriver(workspace.backend.kind);
  logDebug("cli", "workspace-loaded", {
    command,
    project: workspace.identity.projectName,
    backend: workspace.backend.kind,
    profile: workspace.backend.profile,
  });
  return { workspace, driver };
}

export async function loadExecutableWorkspaceForCommand(
  command: WorkspaceStatus["lifecycleAction"],
  projectRef: string,
  userProfileId?: string,
): Promise<{
  workspace: WorkspaceSpec;
  driver: ReturnType<typeof getBackendDriver>;
}> {
  ensureProvisionedWorkspace(projectRef, userProfileId);
  const { workspace, driver } = loadWorkspaceForCommand(command, projectRef, userProfileId);
  const preparedWorkspace = await prepareEvolutionMemorySnapshot(workspace);
  return { workspace: preparedWorkspace, driver };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForWorkspaceReady(
  workspace: WorkspaceSpec,
  timeoutMs = 120000,
  intervalMs = 1500,
): Promise<void> {
  const driver = getBackendDriver(workspace.backend.kind);
  const startedAt = Date.now();
  let lastStatus: WorkspaceStatus | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    const observation = await driver.inspect(workspace);
    const drift = computeWorkspaceDrift(workspace, observation);
    const status = synthesizeWorkspaceStatus(workspace, observation, drift, "start");
    lastStatus = status;

    logDebug("cli", "start-probe", {
      project: workspace.identity.projectName,
      backend: workspace.backend.kind,
      state: status.state,
      reason: status.health.reason,
    });

    if (status.state === "ready") {
      logInfo("cli", "workspace-ready", {
        project: workspace.identity.projectName,
        backend: workspace.backend.kind,
      });
      return;
    }

    await sleep(intervalMs);
  }

  logWarn("cli", "workspace-not-ready-before-timeout", {
    project: workspace.identity.projectName,
    backend: workspace.backend.kind,
    state: lastStatus?.state,
    reason: lastStatus?.health.reason,
  });

  if (lastStatus) {
    throw new Error(
      `Workspace '${workspace.identity.projectName}' did not become ready within ${timeoutMs}ms (${lastStatus.backend.kind}, state=${lastStatus.state}, reason=${lastStatus.health.reason ?? "unknown"})`,
    );
  }
  throw new Error(`Workspace '${workspace.identity.projectName}' did not become ready within ${timeoutMs}ms`);
}

export async function runWorkspaceCommandWithEvolution<T>(params: {
  workspace: WorkspaceSpec;
  command: WorkspaceStatus["lifecycleAction"];
  execute: () => Promise<T>;
  onSuccessPayload?: (result: T) => Record<string, unknown>;
}): Promise<{ result: T; evolutionSessionId?: string }> {
  const { workspace, command, execute, onSuccessPayload } = params;
  if (!workspace.agent.enabled) {
    return { result: await execute() };
  }
  const sessionId = createEvolutionSessionId(command);
  await appendEvolutionEvent(workspace, sessionId, "task-started", {
    command,
    backend: workspace.backend.kind,
    project: workspace.identity.projectName,
  });
  try {
    const result = await execute();
    await appendEvolutionEvent(workspace, sessionId, "task-completed", {
      command,
      ...(onSuccessPayload ? onSuccessPayload(result) : {}),
    });
    await finalizeEvolutionSession(workspace, sessionId);
    return { result, evolutionSessionId: sessionId };
  } catch (error) {
    await appendEvolutionEvent(workspace, sessionId, "task-failed", {
      command,
      error: error instanceof Error ? error.message : String(error),
    });
    await finalizeEvolutionSession(workspace, sessionId);
    throw error;
  }
}
