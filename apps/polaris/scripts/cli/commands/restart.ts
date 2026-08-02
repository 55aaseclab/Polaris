import { loadExecutableVaultForCommand, runVaultCommandWithEvolution } from "./shared.js";

export async function restartCommand(project: string, userProfileId?: string): Promise<void> {
  const { vault, driver } = await loadExecutableVaultForCommand("restart", project, userProfileId);
  await runVaultCommandWithEvolution({
    vault,
    command: "restart",
    execute: async () => {
      await driver.restart(vault);
    },
  });
}
