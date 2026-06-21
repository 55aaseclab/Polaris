import { loadWorkspace } from "../../config/load.js";
import { getBackendDriver } from "../../backends/index.js";

export async function logsCommand(project: string): Promise<void> {
  const workspace = loadWorkspace(project);
  await getBackendDriver(workspace.backend.kind).logs(workspace);
}
