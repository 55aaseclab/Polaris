import { loadWorkspaceForCommand } from "./shared.js";

export async function logsCommand(project: string, userProfileId?: string): Promise<void> {
  const { workspace, driver } = loadWorkspaceForCommand("logs", project, userProfileId);
  await driver.logs(workspace);
}
