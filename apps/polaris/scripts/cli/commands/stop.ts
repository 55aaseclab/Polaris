import { loadWorkspaceForCommand, runWorkspaceCommandWithEvolution } from "./shared.js";

export async function stopCommand(project: string, userProfileId?: string): Promise<void> {
  const { workspace, driver } = loadWorkspaceForCommand("stop", project, userProfileId);
  await runWorkspaceCommandWithEvolution({
    workspace,
    command: "stop",
    execute: async () => {
      await driver.stop(workspace);
    },
  });
}
