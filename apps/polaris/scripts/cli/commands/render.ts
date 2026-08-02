import { loadExecutableVaultForCommand } from "./shared.js";
import { runVaultCommandWithEvolution } from "./shared.js";

export async function renderCommand(project: string, userProfileId?: string): Promise<void> {
  const { vault, driver } = await loadExecutableVaultForCommand("render", project, userProfileId);
  await runVaultCommandWithEvolution({
    vault,
    command: "render",
    execute: async () => {
      await driver.render(vault);
    },
  });
}
