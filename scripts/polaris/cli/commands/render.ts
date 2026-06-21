import { loadWorkspaceForCommand } from "./shared.js";

export async function renderCommand(project: string): Promise<void> {
  const { workspace, driver } = loadWorkspaceForCommand("render", project);
  await driver.render(workspace);
}
