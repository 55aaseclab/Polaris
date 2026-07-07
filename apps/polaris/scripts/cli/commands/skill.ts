import { isSkillHarness, type SkillHarness } from "../../config/skills.js";
import {
  listWorkspaceSkills,
  skillInstallWorkspace,
  skillSyncWorkspace,
  skillUninstallWorkspace,
} from "../../executor/operations.js";

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
  workspaceRef: string,
  argv: string[],
): Promise<void> {
  const userProfileId = parseFlag(argv, "--user");
  const harness = parseHarness(argv);
  const result = await listWorkspaceSkills({
    workspaceRef,
    userProfileId,
    harness,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function skillInstallCommand(
  workspaceRef: string,
  argv: string[],
): Promise<void> {
  const skillId = argv[0]?.trim();
  if (!skillId) {
    throw new Error(
      "Usage: pnpm --dir apps/polaris run polaris -- skill-install <workspaceRef> <skillId> [--user <userProfileId>] [--harness <codex|claude>]",
    );
  }
  const userProfileId = parseFlag(argv, "--user");
  const harness = parseHarness(argv);
  const result = await skillInstallWorkspace({
    workspaceRef,
    userProfileId,
    harness,
    skillId,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function skillUninstallCommand(
  workspaceRef: string,
  argv: string[],
): Promise<void> {
  const skillId = argv[0]?.trim();
  if (!skillId) {
    throw new Error(
      "Usage: pnpm --dir apps/polaris run polaris -- skill-uninstall <workspaceRef> <skillId> [--user <userProfileId>] [--harness <codex|claude>]",
    );
  }
  const userProfileId = parseFlag(argv, "--user");
  const harness = parseHarness(argv);
  const result = await skillUninstallWorkspace({
    workspaceRef,
    userProfileId,
    harness,
    skillId,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function skillSyncCommand(
  workspaceRef: string,
  argv: string[],
): Promise<void> {
  const userProfileId = parseFlag(argv, "--user");
  const harness = parseHarness(argv);
  const result = await skillSyncWorkspace({
    workspaceRef,
    userProfileId,
    harness,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
