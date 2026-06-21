import { loadExecutableWorkspaceForCommand, runWorkspaceCommandWithEvolution } from "./shared.js";

export async function restartCommand(project: string): Promise<void> {
  const { workspace, driver } = await loadExecutableWorkspaceForCommand("restart", project);
  await runWorkspaceCommandWithEvolution({
    workspace,
    command: "restart",
    execute: async () => {
      await driver.restart(workspace);
    },
  });
}
