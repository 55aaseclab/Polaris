import {
  loadPreparedVaultForCommand,
  persistVaultPaseoState,
  waitForVaultReady,
} from "./shared.js";
import { runVaultCommandWithEvolution } from "./shared.js";

export async function startCommand(project: string, userProfileId?: string): Promise<void> {
  const { vault, driver } = await loadPreparedVaultForCommand("start", project, userProfileId);
  await runVaultCommandWithEvolution({
    vault,
    command: "start",
    execute: async () => {
      await driver.start(vault);
      await waitForVaultReady(vault);
      await persistVaultPaseoState(vault);
    },
  });
}
