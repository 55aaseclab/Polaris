import { loadExecutableWorkspaceForCommand, runWorkspaceCommandWithEvolution } from "./shared.js";

export async function rebuildCommand(project: string): Promise<void> {
  const { workspace, driver } = await loadExecutableWorkspaceForCommand("rebuild", project);
  await runWorkspaceCommandWithEvolution({
    workspace,
    command: "rebuild",
    execute: async () => {
      await driver.rebuild(workspace);
    },
  });
}
