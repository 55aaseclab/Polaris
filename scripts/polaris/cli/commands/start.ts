import { loadExecutableWorkspaceForCommand, waitForWorkspaceReady } from "./shared.js";

export async function startCommand(project: string): Promise<void> {
  const { workspace, driver } = await loadExecutableWorkspaceForCommand("start", project);
  await driver.start(workspace);
  await waitForWorkspaceReady(workspace);
}
