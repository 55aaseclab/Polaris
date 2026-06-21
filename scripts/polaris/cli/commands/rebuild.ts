import { loadWorkspaceForCommand } from "./shared.js";

export async function rebuildCommand(project: string): Promise<void> {
  const { workspace, driver } = loadWorkspaceForCommand("rebuild", project);
  await driver.rebuild(workspace);
}
