import { loadWorkspaceForCommand } from "./shared.js";

export async function applyCommand(project: string): Promise<void> {
  const { workspace, driver } = loadWorkspaceForCommand("apply", project);
  await driver.apply(workspace);
}
