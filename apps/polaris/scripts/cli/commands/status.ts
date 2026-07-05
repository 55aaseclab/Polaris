import { writeWorkspaceStatus } from "../../output/state-store.js";
import { computeWorkspaceDrift, synthesizeWorkspaceStatus } from "../../core/runtime-controller.js";
import { buildStatusAssets } from "../../core/status-assets.js";
import { appendEvolutionEvent, createEvolutionSessionId, finalizeEvolutionSession, getEvolutionSummary } from "../../evolution/runtime.js";
import { loadWorkspaceForCommand, persistWorkspacePaseoState } from "./shared.js";
import { logInfo } from "../../utils/log.js";

export async function statusCommand(project: string, userProfileId?: string): Promise<void> {
  const { workspace, driver } = loadWorkspaceForCommand("status", project, userProfileId);
  const evolutionSessionId = workspace.agent.enabled ? createEvolutionSessionId("status") : undefined;
  const observation = await driver.inspect(workspace);
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
  const status = synthesizeWorkspaceStatus(workspace, effectiveObservation, drift, "status");
  status.assets = buildStatusAssets(workspace);
  if (evolutionSessionId) {
    await appendEvolutionEvent(workspace, evolutionSessionId, "task-completed", {
      command: "status",
      backendLiveness: status.health.backendLiveness,
      workspaceReadiness: status.health.workspaceReadiness,
      reason: status.health.reason,
    });
    await finalizeEvolutionSession(workspace, evolutionSessionId);
    status.evolution = {
      ...(await getEvolutionSummary(workspace)),
      lastSessionId: evolutionSessionId,
    };
  }
  const outputPath = writeWorkspaceStatus(status, workspace.userProfile.id);
  logInfo("cli", "status-synthesized", {
    project: status.project,
    backend: status.driver?.backend,
    backendLiveness: status.health.backendLiveness,
    workspaceReadiness: status.health.workspaceReadiness,
    statusFile: outputPath,
  });
  process.stdout.write(`${JSON.stringify({ ...status, statusFile: outputPath }, null, 2)}\n`);
}
