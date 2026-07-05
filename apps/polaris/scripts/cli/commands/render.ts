import { loadExecutableWorkspaceForCommand } from "./shared.js";
import { runWorkspaceCommandWithEvolution } from "./shared.js";

export async function renderCommand(project: string, userProfileId?: string): Promise<void> {
  const { workspace, driver } = await loadExecutableWorkspaceForCommand("render", project, userProfileId);
  await runWorkspaceCommandWithEvolution({
    workspace,
    command: "render",
    execute: async () => {
      await driver.render(workspace);
    },
  });
}
