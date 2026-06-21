import { loadExecutableWorkspaceForCommand } from "./shared.js";
import { runWorkspaceCommandWithEvolution } from "./shared.js";

export async function renderCommand(project: string): Promise<void> {
  const { workspace, driver } = await loadExecutableWorkspaceForCommand("render", project);
  await runWorkspaceCommandWithEvolution({
    workspace,
    command: "render",
    execute: async () => {
      await driver.render(workspace);
    },
  });
}
