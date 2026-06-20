import { loadWorkspace } from "../../config/load.js";
import { getBackendDriver } from "../../backends/index.js";

export async function renderCommand(project: string): Promise<void> {
  const workspace = loadWorkspace(project);
  const driver = getBackendDriver(workspace.backend.kind);
  await driver.render(workspace);
}
