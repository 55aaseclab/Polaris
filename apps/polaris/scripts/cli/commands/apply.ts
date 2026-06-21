import { loadExecutableWorkspaceForCommand, runWorkspaceCommandWithEvolution } from "./shared.js";

export async function applyCommand(project: string): Promise<void> {
  const { workspace, driver } = await loadExecutableWorkspaceForCommand("apply", project);
  await runWorkspaceCommandWithEvolution({
    workspace,
    command: "apply",
    execute: async () => {
      await driver.apply(workspace);
    },
  });
}
