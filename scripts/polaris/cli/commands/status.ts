import { writeWorkspaceStatus } from "../../output/state-store.js";
import { computeWorkspaceDrift, synthesizeWorkspaceStatus } from "../../core/runtime-controller.js";
import { loadWorkspaceForCommand } from "./shared.js";
import { logInfo } from "../../utils/log.js";

export async function statusCommand(project: string): Promise<void> {
  const { workspace, driver } = loadWorkspaceForCommand("status", project);
  const observation = await driver.inspect(workspace);
  const drift = computeWorkspaceDrift(workspace, observation);
  const status = synthesizeWorkspaceStatus(workspace, observation, drift, "status");
  const outputPath = writeWorkspaceStatus(status);
  logInfo("cli", "status-synthesized", {
    project: status.project,
    backend: status.backend.kind,
    state: status.state,
    backendState: status.backend.instanceState,
    statusFile: outputPath,
  });
  process.stdout.write(`${JSON.stringify({ ...status, statusFile: outputPath }, null, 2)}\n`);
}
