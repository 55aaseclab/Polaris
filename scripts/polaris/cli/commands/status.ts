import { loadWorkspace } from "../../config/load.js";
import { getBackendDriver } from "../../backends/index.js";
import { writeWorkspaceStatus } from "../../output/state-store.js";
import { computeWorkspaceDrift, synthesizeWorkspaceStatus } from "../../core/runtime-controller.js";

export async function statusCommand(project: string): Promise<void> {
  const workspace = loadWorkspace(project);
  const driver = getBackendDriver(workspace.backend.kind);
  const observation = await driver.inspect(workspace);
  const drift = computeWorkspaceDrift(workspace, observation);
  const status = synthesizeWorkspaceStatus(workspace, observation, drift, "status");
  const outputPath = writeWorkspaceStatus(status);
  process.stdout.write(`${JSON.stringify({ ...status, statusFile: outputPath }, null, 2)}\n`);
}
