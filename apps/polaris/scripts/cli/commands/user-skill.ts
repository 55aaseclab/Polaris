import {
  addUserSkill,
  createSkillsCliDescriptor,
  ensureUserProfileExists,
  isSkillHarness,
  listUserSkills,
  removeUserSkill,
  type SkillHarness,
} from "../../config/skills.js";
import { logInfo } from "../../utils/log.js";
import { withUserMutationLock } from "../../utils/user-mutation-lock.js";

function parseFlag(argv: string[], flag: string): string | undefined {
  const index = argv.findIndex((value) => value === flag);
  const value = index >= 0 ? argv[index + 1]?.trim() : "";
  return value ? value : undefined;
}

function parseHarness(argv: string[]): SkillHarness {
  const harness = (parseFlag(argv, "--harness") ?? "codex").trim().toLowerCase();
  if (!isSkillHarness(harness)) {
    throw new Error(`Unsupported skill harness '${harness}'`);
  }
  return harness;
}

function parseListArgs(argv: string[]): { userProfileId: string } {
  const userProfileId = argv[0]?.trim();
  if (!userProfileId) {
    throw new Error(
      "Usage: pnpm --dir apps/polaris run polaris -- user skill list <userProfileId>",
    );
  }
  return { userProfileId };
}

function parseAddArgs(argv: string[]): {
  userProfileId: string;
  skillId?: string;
  harness: SkillHarness;
  source: string;
  selectedSkillName: string;
} {
  const userProfileId = argv[0]?.trim();
  const skillId = parseFlag(argv, "--skill-id");
  const source = parseFlag(argv, "--source")?.trim() || "";
  const selectedSkillName = parseFlag(argv, "--skill")?.trim() || "";
  if (!userProfileId || !source || !selectedSkillName) {
    throw new Error(
      "Usage: pnpm --dir apps/polaris run polaris -- user skill add <userProfileId> --source <repo-or-source> --skill <skillName> [--skill-id <skillId>] [--harness <codex|claude>]",
    );
  }
  return {
    userProfileId,
    ...(skillId ? { skillId } : {}),
    harness: parseHarness(argv),
    source,
    selectedSkillName,
  };
}

function parseRemoveArgs(argv: string[]): {
  userProfileId: string;
  skillId: string;
} {
  const userProfileId = argv[0]?.trim();
  const skillId = argv[1]?.trim();
  if (!userProfileId || !skillId) {
    throw new Error(
      "Usage: pnpm --dir apps/polaris run polaris -- user skill remove <userProfileId> <skillId>",
    );
  }
  return { userProfileId, skillId };
}

export async function listUserSkillCommand(argv: string[]): Promise<void> {
  const { userProfileId } = parseListArgs(argv);
  ensureUserProfileExists(userProfileId);
  const skills = listUserSkills(userProfileId);
  process.stdout.write(`${JSON.stringify({ skills }, null, 2)}\n`);
}

export async function addUserSkillCommand(argv: string[]): Promise<void> {
  const parsed = parseAddArgs(argv);
  await withUserMutationLock(import.meta.url, parsed.userProfileId, async () => {
    const descriptor = createSkillsCliDescriptor({
      source: parsed.source,
      harness: parsed.harness,
      selectedSkillName: parsed.selectedSkillName,
    });
    const skill = addUserSkill({
      userProfileId: parsed.userProfileId,
      skillId: parsed.skillId?.trim() || descriptor.suggestedSkillId,
      harness: parsed.harness,
      packageName: descriptor.packageName,
      args: descriptor.args,
      source: descriptor.source,
      selectedSkillName: descriptor.selectedSkillName,
    });
    logInfo("cli", "user-skill-added", {
      userProfileId: parsed.userProfileId,
      skillId: skill.id,
      harness: skill.harness,
      packageName: skill.packageName,
    });
    process.stdout.write(`${JSON.stringify({ skill }, null, 2)}\n`);
  });
}

export async function removeUserSkillCommand(argv: string[]): Promise<void> {
  const { userProfileId, skillId } = parseRemoveArgs(argv);
  await withUserMutationLock(import.meta.url, userProfileId, async () => {
    const skill = removeUserSkill({ userProfileId, skillId });
    logInfo("cli", "user-skill-removed", {
      userProfileId,
      skillId,
    });
    process.stdout.write(`${JSON.stringify({ skill }, null, 2)}\n`);
  });
}
