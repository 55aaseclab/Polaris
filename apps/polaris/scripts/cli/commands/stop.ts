import { loadVaultForCommand, runVaultCommandWithEvolution } from "./shared.js";

export async function stopCommand(project: string, userProfileId?: string): Promise<void> {
  const { vault, driver } = loadVaultForCommand("stop", project, userProfileId);
  await runVaultCommandWithEvolution({
    vault,
    command: "stop",
    execute: async () => {
      await driver.stop(vault);
    },
  });
}
