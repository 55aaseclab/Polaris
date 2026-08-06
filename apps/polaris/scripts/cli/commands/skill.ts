import { isSkillHarness, type SkillHarness } from "../../config/skills.js";
import {
  listVaultSkills,
  skillInstallVault,
  skillSyncVault,
  skillUninstallVault,
} from "../../runtime/operations.js";

function parseFlag(argv: string[], flag: string): string | undefined {
  const index = argv.findIndex((value) => value === flag);
  const value = index >= 0 ? argv[index + 1]?.trim() : "";
  return value ? value : undefined;
}

function parseHarness(argv: string[]): SkillHarness {
  const raw = (parseFlag(argv, "--harness") ?? "codex").trim().toLowerCase();
  if (!isSkillHarness(raw)) {
    throw new Error(`Unsupported skill harness '${raw}'`);
  }
  return raw;
}

export async function skillListCommand(
  vaultRef: string,
  argv: string[],
): Promise<void> {
  const userProfileId = parseFlag(argv, "--user");
  const harness = parseHarness(argv);
  const result = await listVaultSkills({
    vaultRef,
    userProfileId,
    harness,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function skillInstallCommand(
  vaultRef: string,
  argv: string[],
): Promise<void> {
  const skillId = argv[0]?.trim();
  if (!skillId) {
    throw new Error(
      "Usage: pnpm --dir apps/polaris run polaris -- vault skill-install <vaultRef> <skillId> [--user <userProfileId>] [--harness <codex|claude>]",
    );
  }
  const userProfileId = parseFlag(argv, "--user");
  const harness = parseHarness(argv);
  const result = await skillInstallVault({
    vaultRef,
    userProfileId,
    harness,
    skillId,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function skillUninstallCommand(
  vaultRef: string,
  argv: string[],
): Promise<void> {
  const skillId = argv[0]?.trim();
  if (!skillId) {
    throw new Error(
      "Usage: pnpm --dir apps/polaris run polaris -- vault skill-uninstall <vaultRef> <skillId> [--user <userProfileId>] [--harness <codex|claude>]",
    );
  }
  const userProfileId = parseFlag(argv, "--user");
  const harness = parseHarness(argv);
  const result = await skillUninstallVault({
    vaultRef,
    userProfileId,
    harness,
    skillId,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function skillSyncCommand(
  vaultRef: string,
  argv: string[],
): Promise<void> {
  const userProfileId = parseFlag(argv, "--user");
  const harness = parseHarness(argv);
  const result = await skillSyncVault({
    vaultRef,
    userProfileId,
    harness,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
