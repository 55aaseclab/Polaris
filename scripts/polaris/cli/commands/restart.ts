import { loadWorkspaceForCommand } from "./shared.js";

export async function restartCommand(project: string): Promise<void> {
  const { workspace, driver } = loadWorkspaceForCommand("restart", project);
  await driver.restart(workspace);
}
