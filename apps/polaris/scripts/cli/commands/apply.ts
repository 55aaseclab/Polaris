import { loadExecutableVaultForCommand, runVaultCommandWithEvolution } from "./shared.js";

export async function applyCommand(project: string, userProfileId?: string): Promise<void> {
  const { vault, driver } = await loadExecutableVaultForCommand("apply", project, userProfileId);
  await runVaultCommandWithEvolution({
    vault,
    command: "apply",
    execute: async () => {
      await driver.apply(vault);
    },
  });
}
