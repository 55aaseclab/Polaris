import { getBackendDriver } from "../../backends/index.js";
import { loadWorkspace } from "../../config/load.js";
import { computeWorkspaceDrift, synthesizeWorkspaceStatus } from "../../core/runtime-controller.js";
import type { WorkspaceSpec, WorkspaceStatus } from "../../core/workspace.js";
import { logDebug, logInfo, logWarn } from "../../utils/log.js";

export function loadWorkspaceForCommand(command: WorkspaceStatus["lifecycleAction"], projectRef: string): {
  workspace: WorkspaceSpec;
  driver: ReturnType<typeof getBackendDriver>;
} {
  logInfo("cli", "load-workspace", { command, projectRef });
  const workspace = loadWorkspace(projectRef);
  const driver = getBackendDriver(workspace.backend.kind);
  logDebug("cli", "workspace-loaded", {
    command,
    project: workspace.identity.projectName,
    backend: workspace.backend.kind,
    profile: workspace.backend.profile,
  });
  return { workspace, driver };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForWorkspaceReady(
  workspace: WorkspaceSpec,
  timeoutMs = 45000,
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
      backendState: status.backend.instanceState,
      daemonReadiness: status.health.daemonReadiness,
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
    backendState: lastStatus?.backend.instanceState,
    reason: lastStatus?.health.reason,
  });

  if (lastStatus) {
    throw new Error(
      `Workspace '${workspace.identity.projectName}' did not become ready within ${timeoutMs}ms (${lastStatus.backend.kind}, state=${lastStatus.state}, reason=${lastStatus.health.reason ?? "unknown"})`,
    );
  }
  throw new Error(`Workspace '${workspace.identity.projectName}' did not become ready within ${timeoutMs}ms`);
}
