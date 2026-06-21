import { loadExecutableWorkspaceForCommand } from "./shared.js";

export async function renderCommand(project: string): Promise<void> {
  const { workspace, driver } = await loadExecutableWorkspaceForCommand("render", project);
  await driver.render(workspace);
}
