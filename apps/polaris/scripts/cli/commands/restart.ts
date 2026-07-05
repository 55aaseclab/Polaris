import { loadExecutableWorkspaceForCommand, runWorkspaceCommandWithEvolution } from "./shared.js";

export async function restartCommand(project: string, userProfileId?: string): Promise<void> {
  const { workspace, driver } = await loadExecutableWorkspaceForCommand("restart", project, userProfileId);
  await runWorkspaceCommandWithEvolution({
    workspace,
    command: "restart",
    execute: async () => {
      await driver.restart(workspace);
    },
  });
}
