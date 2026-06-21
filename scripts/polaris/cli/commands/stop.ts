import { loadWorkspaceForCommand } from "./shared.js";

export async function stopCommand(project: string): Promise<void> {
  const { workspace, driver } = loadWorkspaceForCommand("stop", project);
  await driver.stop(workspace);
}
