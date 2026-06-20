import { loadWorkspace } from "../../config/load.js";
import { getBackendDriver } from "../../backends/index.js";
import { writeWorkspaceStatus } from "../../output/state-store.js";

export async function reconcileCommand(project: string): Promise<void> {
  const workspace = loadWorkspace(project);
  const driver = getBackendDriver(workspace.backend.kind);
  const status = await driver.reconcile(workspace);
  const outputPath = writeWorkspaceStatus(status);
  process.stdout.write(`${JSON.stringify({ ...status, statusFile: outputPath }, null, 2)}\n`);
}
