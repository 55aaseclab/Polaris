import { loadVaultForCommand } from "./shared.js";

export async function logsCommand(project: string, userProfileId?: string): Promise<void> {
  const { vault, driver } = loadVaultForCommand("logs", project, userProfileId);
  await driver.logs(vault);
}
