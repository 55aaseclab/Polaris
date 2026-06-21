import { loadWorkspaceForCommand } from "./shared.js";

export async function logsCommand(project: string): Promise<void> {
  const { workspace, driver } = loadWorkspaceForCommand("logs", project);
  await driver.logs(workspace);
}
