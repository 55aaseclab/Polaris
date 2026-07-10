import {
  normalizeWorkspaceStatus,
  workspaceStatusPath,
  writeWorkspaceStatus,
} from "../../output/state-store.js";
import { computeWorkspaceDrift, synthesizeWorkspaceStatus } from "../../core/runtime-controller.js";
import { buildStatusAssets } from "../../core/status-assets.js";
import type { WorkspaceStatus } from "../../core/workspace.js";
import { appendEvolutionEvent, createEvolutionSessionId, finalizeEvolutionSession, getEvolutionSummary } from "../../evolution/runtime.js";
import { loadWorkspaceForCommand, persistWorkspacePaseoState } from "./shared.js";
import { logInfo } from "../../utils/log.js";
import { measureWorkspacePhase } from "../../utils/workspace-log.js";

export async function synthesizeAndWriteWorkspaceStatus(
  project: string,
  userProfileId?: string,
  options?: {
    write?: boolean;
  },
): Promise<{
  outputPath: string;
  status: WorkspaceStatus;
}> {
  const { workspace, driver } = loadWorkspaceForCommand("status", project, userProfileId);
  const evolutionSessionId = workspace.agent.enabled ? createEvolutionSessionId("status") : undefined;
  const observation = await measureWorkspacePhase({
    context: {
      userId: workspace.userProfile.id,
      workspace: workspace.identity.projectName,
      backend: workspace.backend.kind,
      profile: workspace.backend.profile,
    },
    phase: "inspect-workspace",
    execute: () => driver.inspect(workspace),
  });
  let effectiveObservation = observation;
  if (workspace.agent.enabled && observation.backend.exists && observation.backend.running) {
    const persistResult = await persistWorkspacePaseoState(workspace);
    if (persistResult === "stopped") {
      effectiveObservation = {
        ...observation,
        backend: {
          ...observation.backend,
          running: false,
        },
      };
    }
  }
  const drift = computeWorkspaceDrift(workspace, effectiveObservation);
  const status = synthesizeWorkspaceStatus(workspace, effectiveObservation, drift);
  status.assets = buildStatusAssets(workspace);
  if (evolutionSessionId) {
    await appendEvolutionEvent(workspace, evolutionSessionId, "task-completed", {
      command: "status",
      runtimeLifecycle: status.driver?.status,
      reason: status.driver?.reason,
    });
    await finalizeEvolutionSession(workspace, evolutionSessionId);
    status.evolution = {
      ...(await getEvolutionSummary(workspace)),
      lastSessionId: evolutionSessionId,
    };
  }
  const outputPath = workspaceStatusPath(status.project, workspace.userProfile.id);
  if (options?.write === false) {
    return {
      outputPath,
      status: normalizeWorkspaceStatus(status),
    };
  }
  writeWorkspaceStatus(status, workspace.userProfile.id);
  return {
    outputPath,
    status: normalizeWorkspaceStatus(status),
  };
}

export async function statusCommand(project: string, userProfileId?: string): Promise<void> {
  const { outputPath, status } = await synthesizeAndWriteWorkspaceStatus(project, userProfileId);
  logInfo("cli", "status-synthesized", {
    project: status.project,
    backend: status.driver?.selected?.backend,
    runtimeLifecycle: status.driver?.status,
    statusFile: outputPath,
  });
  process.stdout.write(`${JSON.stringify({ ...status, statusFile: outputPath }, null, 2)}\n`);
}
