import { getBackendDriver } from "../../backends/index.js";
import { spawnSync } from "node:child_process";
import { loadWorkspaceFromConfigPath, resolveWorkspaceConfigPath } from "../../config/load.js";
import { ensureProvisionedWorkspace, ensureWorkspaceConfig } from "../../config/provision.js";
import { computeWorkspaceDrift, synthesizeWorkspaceStatus } from "../../core/runtime-controller.js";
import type { WorkspaceSpec, WorkspaceStatus } from "../../core/workspace.js";
import { workspaceRuntimeScopeName } from "../../core/workspace-name.js";
import { readKubevirtPersistedPaseoState } from "../../backends/kubevirt/driver.js";
import {
  appendEvolutionEvent,
  createEvolutionSessionId,
  finalizeEvolutionSession,
  prepareEvolutionMemorySnapshot,
} from "../../evolution/runtime.js";
import { writeWorkspacePaseoPairing, writeWorkspacePaseoServerId } from "../../output/state-store.js";
import { logDebug, logInfo, logWarn } from "../../utils/log.js";

function runCheckedCapture(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    const stdout = String(result.stdout || "").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? "unknown"})${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ""}`,
    );
  }
  return String(result.stdout || "");
}

function readJsonObject(raw: string): (Record<string, unknown> & { url: string }) | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.url === "string" && parsed.url.trim() ? { ...parsed, url: parsed.url.trim() } : null;
  } catch {
    return null;
  }
}

export async function persistWorkspacePaseoState(workspace: WorkspaceSpec): Promise<void> {
  if (!workspace.agent.enabled) {
    return;
  }
  let serverId = "";
  let pairing: (Record<string, unknown> & { url: string }) | null = null;
  const serverIdPath = `${workspace.agent.runtime.stateRoot}/server-id`;
  const pairingPath = workspace.agent.runtime.pairingFile ?? `${workspace.agent.runtime.stateRoot}/pairing.json`;

  if (workspace.backend.kind === "docker") {
    const scope = workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName);
    serverId = runCheckedCapture(
      "docker",
      ["exec", `${scope}-docker`, "sh", "-lc", `cat ${serverIdPath} 2>/dev/null || true`],
    ).trim();
    pairing = readJsonObject(
      runCheckedCapture(
        "docker",
        ["exec", `${scope}-docker`, "sh", "-lc", `cat ${pairingPath} 2>/dev/null || true`],
      ),
    );
  } else if (workspace.backend.kind === "pod") {
    const scope = workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName);
    serverId = runCheckedCapture(
      "kubectl",
      ["-n", scope, "exec", `deployment/${scope}`, "--", "sh", "-lc", `cat ${serverIdPath} 2>/dev/null || true`],
    ).trim();
    pairing = readJsonObject(
      runCheckedCapture(
        "kubectl",
        ["-n", scope, "exec", `deployment/${scope}`, "--", "sh", "-lc", `cat ${pairingPath} 2>/dev/null || true`],
      ),
    );
  } else if (workspace.backend.kind === "kubevirt-vm") {
    const snapshot = await readKubevirtPersistedPaseoState(workspace);
    serverId = snapshot?.serverId ?? "";
    pairing = snapshot?.pairing ?? null;
  }

  if (!serverId || !pairing) {
    logWarn("cli", "workspace-paseo-state-persist-skipped", {
      project: workspace.identity.projectName,
      backend: workspace.backend.kind,
      hasServerId: Boolean(serverId),
      hasPairing: Boolean(pairing),
    });
    return;
  }

  writeWorkspacePaseoServerId(workspace.identity.projectName, serverId, workspace.userProfile.id);
  writeWorkspacePaseoPairing(workspace.identity.projectName, pairing, workspace.userProfile.id);
  logInfo("cli", "workspace-paseo-state-persisted", {
    project: workspace.identity.projectName,
    backend: workspace.backend.kind,
    serverId,
  });
}

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

export async function loadPreparedWorkspaceForCommand(
  command: WorkspaceStatus["lifecycleAction"],
  projectRef: string,
  userProfileId?: string,
): Promise<{
  workspace: WorkspaceSpec;
  driver: ReturnType<typeof getBackendDriver>;
}> {
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
      backendLiveness: status.health.backendLiveness,
      workspaceReadiness: status.health.workspaceReadiness,
      reason: status.health.reason,
    });

    if (status.health.workspaceReadiness === "ready") {
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
    backendLiveness: lastStatus?.health.backendLiveness,
    workspaceReadiness: lastStatus?.health.workspaceReadiness,
    reason: lastStatus?.health.reason,
  });

  if (lastStatus) {
    throw new Error(
      `Workspace '${workspace.identity.projectName}' did not become ready within ${timeoutMs}ms (${lastStatus.driver?.backend ?? "unknown"}, backendLiveness=${lastStatus.health.backendLiveness}, workspaceReadiness=${lastStatus.health.workspaceReadiness}, reason=${lastStatus.health.reason ?? "unknown"})`,
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
