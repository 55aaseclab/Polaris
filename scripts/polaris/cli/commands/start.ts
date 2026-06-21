import { loadWorkspaceForCommand, waitForWorkspaceReady } from "./shared.js";

export async function startCommand(project: string): Promise<void> {
  const { workspace, driver } = loadWorkspaceForCommand("start", project);
  await driver.start(workspace);
  await waitForWorkspaceReady(workspace);
}
