#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SkillTarget = "codex" | "claude";
export type InstallMode = "copy" | "link";
export type InstallScope = "user" | "project";

export interface InstallOptions {
  destinationRoot: string;
  force?: boolean;
  mode?: InstallMode;
  skillNames: string[];
  sourceRoot?: string;
}

export interface CliOptions {
  force: boolean;
  mode: InstallMode;
  scope: InstallScope;
  skillNames: string[];
  target: SkillTarget;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const DEFAULT_SKILL_OWNER_ROOTS = [
  path.join(REPO_ROOT, "tools"),
  path.join(REPO_ROOT, "packs"),
];

export interface SkillSource {
  name: string;
  sourceDir: string;
}

function isDirectory(filePath: string): boolean {
  return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
}

function scanOwnedSkills(ownerRoot: string): SkillSource[] {
  if (!isDirectory(ownerRoot)) {
    return [];
  }
  return fs
    .readdirSync(ownerRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((owner) => {
      const skillsRoot = path.join(ownerRoot, owner.name, "skills");
      if (!isDirectory(skillsRoot)) {
        return [];
      }
      return fs
        .readdirSync(skillsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          sourceDir: path.join(skillsRoot, entry.name),
        }))
        .filter((skill) => fs.existsSync(path.join(skill.sourceDir, "SKILL.md")));
    });
}

export function listSkillSources(sourceRoot?: string): SkillSource[] {
  if (sourceRoot) {
    if (!isDirectory(sourceRoot)) {
      throw new Error(`Skills source directory not found: ${sourceRoot}`);
    }
    return fs
      .readdirSync(sourceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        sourceDir: path.join(sourceRoot, entry.name),
      }))
      .filter((skill) => fs.existsSync(path.join(skill.sourceDir, "SKILL.md")))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
  return DEFAULT_SKILL_OWNER_ROOTS
    .flatMap((ownerRoot) => scanOwnedSkills(ownerRoot))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function usage(): string {
  return [
    "Usage: pnpm --dir apps/polaris exec tsx scripts/install-skills.ts "
      + "--target <codex|claude> [options] [skill...]",
    "",
    "Options:",
    "  --target <codex|claude>  Install into the selected assistant home",
    "  --scope <user|project>   Default: user",
    "  --mode <copy|link>       Default: copy",
    "  --force                  Replace an existing installed skill",
    "  --help                   Show this message",
    "",
    "Examples:",
    "  pnpm --dir apps/polaris exec tsx scripts/install-skills.ts --target codex polaris-business",
    "  pnpm --dir apps/polaris exec tsx scripts/install-skills.ts --target claude --force",
    "  pnpm --dir apps/polaris exec tsx scripts/install-skills.ts --target codex "
      + "--scope project --mode link polaris-business",
  ].join("\n");
}

function isSkillTarget(value: string): value is SkillTarget {
  return value === "codex" || value === "claude";
}

function isInstallMode(value: string): value is InstallMode {
  return value === "copy" || value === "link";
}

function isInstallScope(value: string): value is InstallScope {
  return value === "user" || value === "project";
}

export function listAvailableSkills(sourceRoot?: string): string[] {
  return listSkillSources(sourceRoot).map((skill) => skill.name);
}

export function resolveInstallRoot(
  target: SkillTarget,
  scope: InstallScope,
  repoRoot = REPO_ROOT,
  homeDir = os.homedir(),
): string {
  if (scope === "project") {
    return path.join(repoRoot, `.${target}`, "skills");
  }

  return path.join(homeDir, `.${target}`, "skills");
}

export function installSkills({
  destinationRoot,
  force = false,
  mode = "copy",
  skillNames,
  sourceRoot,
}: InstallOptions): string[] {
  if (skillNames.length === 0) {
    throw new Error("No skill names provided.");
  }

  fs.mkdirSync(destinationRoot, { recursive: true });

  const installed: string[] = [];

  const catalog = new Map(listSkillSources(sourceRoot).map((skill) => [skill.name, skill]));
  for (const skillName of skillNames) {
    const sourceDir = catalog.get(skillName)?.sourceDir
      ?? (sourceRoot ? path.join(sourceRoot, skillName) : "");
    const skillFile = path.join(sourceDir, "SKILL.md");
    const destinationDir = path.join(destinationRoot, skillName);

    if (!fs.existsSync(skillFile)) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    if (fs.existsSync(destinationDir)) {
      if (!force) {
        throw new Error(
          `Destination already exists for ${skillName}: ${destinationDir}`,
        );
      }

      fs.rmSync(destinationDir, { force: true, recursive: true });
    }

    if (mode === "link") {
      fs.symlinkSync(sourceDir, destinationDir, "dir");
    } else {
      fs.cpSync(sourceDir, destinationDir, { recursive: true });
    }

    installed.push(destinationDir);
  }

  return installed;
}

export function parseArgs(argv: string[]): CliOptions {
  let force = false;
  let mode: InstallMode = "copy";
  let scope: InstallScope = "user";
  let target: SkillTarget | undefined;
  const skillNames: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    }

    if (arg === "--force") {
      force = true;
      continue;
    }

    if (arg === "--target") {
      const value = argv[index + 1];
      if (!value || !isSkillTarget(value)) {
        throw new Error("Expected --target codex or --target claude.");
      }

      target = value;
      index += 1;
      continue;
    }

    if (arg === "--scope") {
      const value = argv[index + 1];
      if (!value || !isInstallScope(value)) {
        throw new Error("Expected --scope user or --scope project.");
      }

      scope = value;
      index += 1;
      continue;
    }

    if (arg === "--mode") {
      const value = argv[index + 1];
      if (!value || !isInstallMode(value)) {
        throw new Error("Expected --mode copy or --mode link.");
      }

      mode = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    skillNames.push(arg);
  }

  if (!target) {
    throw new Error("Missing required --target option.");
  }

  return {
    force,
    mode,
    scope,
    skillNames,
    target,
  };
}

export function main(argv: string[]): number {
  try {
    const options = parseArgs(argv);
    const availableSkills = listAvailableSkills();
    const skillNames =
      options.skillNames.length > 0 ? options.skillNames : availableSkills;
    const destinationRoot = resolveInstallRoot(
      options.target,
      options.scope,
    );

    installSkills({
      destinationRoot,
      force: options.force,
      mode: options.mode,
      skillNames,
    });

    console.log(`Installed ${skillNames.length} skill(s) to ${destinationRoot}`);
    for (const skillName of skillNames) {
      console.log(`- ${skillName}`);
    }

    return 0;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown install failure.";
    console.error(message);
    console.error("");
    console.error(usage());
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
