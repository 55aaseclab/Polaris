import {
  loadPreparedVaultForCommand,
  runVaultCommandWithEvolution,
  waitForVaultReady,
} from "./shared.js";
import {
  readStoredVaultStatus,
  writeVaultStatus,
} from "../../output/state-store.js";

export async function startCommand(project: string, userProfileId?: string): Promise<void> {
  const { vault, driver } = await loadPreparedVaultForCommand("start", project, userProfileId);
  await runVaultCommandWithEvolution({
    vault,
    command: "start",
    execute: async () => {
      await driver.start(vault);
      const readyStatus = await waitForVaultReady(vault);
      const currentStatus = readStoredVaultStatus(
        vault.identity.projectName,
        vault.userProfile.id,
      );
      writeVaultStatus({
        ...(currentStatus ?? {}),
        ...readyStatus,
      }, vault.userProfile.id);
    },
  });
}
