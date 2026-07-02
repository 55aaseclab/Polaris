import { writeWorkspaceStatus } from "../../output/state-store.js";
import { computeWorkspaceDrift, synthesizeWorkspaceStatus } from "../../core/runtime-controller.js";
import { buildStatusAssets } from "../../core/status-assets.js";
import { appendEvolutionEvent, createEvolutionSessionId, finalizeEvolutionSession, getEvolutionSummary } from "../../evolution/runtime.js";
import { loadWorkspaceForCommand } from "./shared.js";
import { logInfo } from "../../utils/log.js";

export async function statusCommand(project: string, userProfileId?: string): Promise<void> {
  const { workspace, driver } = loadWorkspaceForCommand("status", project, userProfileId);
  const evolutionSessionId = workspace.agent.enabled ? createEvolutionSessionId("status") : undefined;
  const observation = await driver.inspect(workspace);
  const drift = computeWorkspaceDrift(workspace, observation);
  const status = synthesizeWorkspaceStatus(workspace, observation, drift, "status");
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
