import { loadExecutableVaultForCommand, runVaultCommandWithEvolution } from "./shared.js";

export async function rebuildCommand(project: string, userProfileId?: string): Promise<void> {
  const { vault, driver } = await loadExecutableVaultForCommand("rebuild", project, userProfileId);
  await runVaultCommandWithEvolution({
    vault,
    command: "rebuild",
    execute: async () => {
      await driver.rebuild(vault);
    },
  });
}
