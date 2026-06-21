import { loadWorkspaceForCommand, runWorkspaceCommandWithEvolution } from "./shared.js";

export async function stopCommand(project: string): Promise<void> {
  const { workspace, driver } = loadWorkspaceForCommand("stop", project);
  await runWorkspaceCommandWithEvolution({
    workspace,
    command: "stop",
    execute: async () => {
      await driver.stop(workspace);
    },
  });
}
