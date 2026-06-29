import { loadExecutableWorkspaceForCommand, waitForWorkspaceReady } from "./shared.js";
import { runWorkspaceCommandWithEvolution } from "./shared.js";

export async function startCommand(project: string, userProfileId?: string): Promise<void> {
  const { workspace, driver } = await loadExecutableWorkspaceForCommand("start", project, userProfileId);
  await runWorkspaceCommandWithEvolution({
    workspace,
    command: "start",
    execute: async () => {
      await driver.start(workspace);
      await waitForWorkspaceReady(workspace);
    },
  });
}
