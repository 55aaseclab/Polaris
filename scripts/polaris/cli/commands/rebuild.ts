import { loadWorkspace } from "../../config/load.js";
import { getBackendDriver } from "../../backends/index.js";

export async function rebuildCommand(project: string): Promise<void> {
  const workspace = loadWorkspace(project);
  await getBackendDriver(workspace.backend.kind).rebuild(workspace);
}
