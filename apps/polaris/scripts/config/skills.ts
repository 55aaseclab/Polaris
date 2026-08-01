import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { WorkspaceSpec } from "../core/workspace.js";
import { polarisUsersRoot, repoRelativePath } from "../utils/paths.js";

export const SKILL_HARNESSES = [
  "codex",
  "claude",
] as const;

export type SkillHarness = typeof SKILL_HARNESSES[number];

export interface UserSkillSummary {
  id: string;
  userId: string;
  harness: SkillHarness;
  packageName: string;
  args: string[];
  command: string[];
  label: string;
  source?: string;
  selectedSkillName: string;
  registryPath: string;
  createdAt?: string;
}

export interface DeletedUserSkillSummary {
  id: string;
  userId: string;
  removed: boolean;
  registryPath: string;
}

function userRootFor(userProfileId: string): string {
  return path.join(USER_ROOT, userProfileId);
}

function skillsRootFor(userProfileId: string): string {
  return path.join(userRootFor(userProfileId), "skills");
}

function skillRegistryPathFor(userProfileId: string, skillId: string): string {
  return path.join(skillsRootFor(userProfileId), `${skillId}.yaml`);
}

function readYamlRecord(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return (yaml.load(fs.readFileSync(filePath, "utf8")) ?? {}) as Record<string, unknown>;
}

function writeYamlRecord(filePath: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    yaml.dump(value, { lineWidth: 120, noRefs: true }),
    "utf8",
  );
}

function commandFromDocument(document: Record<string, unknown>): string[] {
  const packageName = String(document.packageName ?? "").trim();
  const args = Array.isArray(document.args)
    ? document.args.map((value) => String(value)).filter(Boolean)
    : [];
  return packageName ? ["npx", "-y", packageName, ...args] : [];
}

function summarizeSkillDocument(
  userProfileId: string,
  fallbackId: string,
  document: Record<string, unknown>,
): UserSkillSummary {
  const id = String(document.id ?? fallbackId).trim() || fallbackId;
  const harnessValue = String(document.harness ?? "codex").trim().toLowerCase();
  const harness = isSkillHarness(harnessValue) ? harnessValue : "codex";
  const packageName = String(document.packageName ?? "").trim();
  const args = Array.isArray(document.args)
    ? document.args.map((value) => String(value)).filter(Boolean)
    : [];
  const selectedSkillName = String(document.selectedSkillName ?? "").trim() || id;
  return {
    id,
    userId: userProfileId,
    harness,
    packageName,
    args,
    command: commandFromDocument(document),
    label: selectedSkillName,
    source: typeof document.source === "string"
      ? document.source
      : undefined,
    selectedSkillName,
    registryPath: repoRelativePath(import.meta.url, skillRegistryPathFor(userProfileId, id)),
    createdAt: typeof document.createdAt === "string"
      ? document.createdAt
      : undefined,
  };
}

function workspaceSkillDir(
  workspace: WorkspaceSpec,
  harness: SkillHarness,
): string {
  const base =
    harness === "codex"
      ? "codex"
      : "claude";
  return path.join(workspace.attachments.userIdentityState.mountRoot, base, "skills");
}

const USER_ROOT = polarisUsersRoot(import.meta.url);

export function isSkillHarness(value: string): value is SkillHarness {
  return (SKILL_HARNESSES as readonly string[]).includes(value);
}

export function sanitizeSkillId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function lastSourceSegment(source: string): string {
  const normalized = source.trim().replace(/\/+$/u, "");
  if (!normalized) {
    return "";
  }
  const withoutTree = normalized.replace(/\/tree\/[^/]+\/?/u, "/");
  const segments = withoutTree.split(/[/:]/u).filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

function isLocalSkillSource(source: string): boolean {
  const trimmed = source.trim();
  return (
    trimmed.startsWith(".") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith("file:") ||
    /^[A-Za-z]:[\\/]/u.test(trimmed)
  );
}

export function agentNameForSkillHarness(harness: SkillHarness): string {
  if (harness === "claude") {
    return "claude-code";
  }
  return "codex";
}

export function createSkillsCliDescriptor(input: {
  source: string;
  harness: SkillHarness;
  selectedSkillName: string;
}): {
  packageName: string;
  args: string[];
  source: string;
  selectedSkillName: string;
  suggestedSkillId: string;
} {
  const source = input.source.trim();
  if (!source) {
    throw new Error("source is required");
  }
  if (isLocalSkillSource(source)) {
    throw new Error("local skill sources are not supported");
  }
  const selectedSkillName = input.selectedSkillName.trim();
  if (!selectedSkillName) {
    throw new Error("skill name is required");
  }
  const suggestedSkillId = sanitizeSkillId(
    selectedSkillName || lastSourceSegment(source) || source,
  );
  return {
    packageName: "skills",
    args: [
      "add",
      source,
      "--copy",
      "-y",
      "--agent",
      agentNameForSkillHarness(input.harness),
      "--skill",
      selectedSkillName,
    ],
    source,
    selectedSkillName,
    suggestedSkillId,
  };
}

export function ensureUserProfileExists(userProfileId: string): void {
  const profilePath = path.join(USER_ROOT, "profiles", `${userProfileId}.yaml`);
  if (!fs.existsSync(profilePath)) {
    throw new Error(`User profile '${userProfileId}' was not found`);
  }
}

export function listUserSkills(userProfileId: string): UserSkillSummary[] {
  ensureUserProfileExists(userProfileId);
  const registryRoot = skillsRootFor(userProfileId);
  if (!fs.existsSync(registryRoot)) {
    return [];
  }
  return fs
    .readdirSync(registryRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => {
      const fallbackId = entry.name.replace(/\.ya?ml$/u, "");
      const document = readYamlRecord(path.join(registryRoot, entry.name)) ?? {};
      return summarizeSkillDocument(userProfileId, fallbackId, document);
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function readUserSkill(
  userProfileId: string,
  skillId: string,
): UserSkillSummary {
  ensureUserProfileExists(userProfileId);
  const document = readYamlRecord(skillRegistryPathFor(userProfileId, skillId));
  if (!document) {
    throw new Error(`Skill '${skillId}' was not found for user '${userProfileId}'`);
  }
  return summarizeSkillDocument(userProfileId, skillId, document);
}

export function addUserSkill(args: {
  userProfileId: string;
  skillId: string;
  harness: SkillHarness;
  packageName: string;
  args?: string[];
  source?: string;
  selectedSkillName: string;
}): UserSkillSummary {
  ensureUserProfileExists(args.userProfileId);
  const skillId = sanitizeSkillId(args.skillId);
  if (!skillId) {
    throw new Error("Skill id is required");
  }
  const packageName = args.packageName.trim();
  if (!packageName) {
    throw new Error("packageName is required");
  }
  const registryPath = skillRegistryPathFor(args.userProfileId, skillId);
  if (fs.existsSync(registryPath)) {
    throw new Error(`Skill '${skillId}' already exists for user '${args.userProfileId}'`);
  }
  const normalizedArgs = (args.args ?? []).map((value) => value.trim()).filter(Boolean);
  const selectedSkillName = args.selectedSkillName.trim();
  if (!selectedSkillName) {
    throw new Error("selectedSkillName is required");
  }
  const document: Record<string, unknown> = {
    id: skillId,
    userId: args.userProfileId,
    harness: args.harness,
    packageName,
    args: normalizedArgs,
    ...(args.source?.trim() ? { source: args.source.trim() } : {}),
    selectedSkillName,
    createdAt: new Date().toISOString(),
  };
  writeYamlRecord(registryPath, document);
  return summarizeSkillDocument(args.userProfileId, skillId, document);
}

export function removeUserSkill(args: {
  userProfileId: string;
  skillId: string;
}): DeletedUserSkillSummary {
  ensureUserProfileExists(args.userProfileId);
  const registryPath = skillRegistryPathFor(args.userProfileId, args.skillId);
  const removed = fs.existsSync(registryPath);
  if (!removed) {
    throw new Error(`Skill '${args.skillId}' was not found for user '${args.userProfileId}'`);
  }
  fs.rmSync(registryPath, { force: true });
  return {
    id: args.skillId,
    userId: args.userProfileId,
    removed: true,
    registryPath: repoRelativePath(
      import.meta.url,
      skillRegistryPathFor(args.userProfileId, args.skillId),
    ),
  };
}

export function listInstalledWorkspaceSkills(args: {
  workspace: WorkspaceSpec;
  harness?: SkillHarness;
}): Array<{ harness: SkillHarness; skills: string[] }> {
  const harnesses = args.harness ? [args.harness] : [...SKILL_HARNESSES];
  return harnesses.map((harness) => {
    const root = workspaceSkillDir(args.workspace, harness);
    const skills = fs.existsSync(root)
      ? fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort()
      : [];
    return { harness, skills };
  });
}

export function resolveWorkspaceSkillInstallRoot(
  workspace: WorkspaceSpec,
  harness: SkillHarness,
): string {
  return workspaceSkillDir(workspace, harness);
}

export function removeInstalledWorkspaceSkill(args: {
  workspace: WorkspaceSpec;
  harness: SkillHarness;
  skillId: string;
}): { harness: SkillHarness; skillId: string; removed: boolean } {
  const root = workspaceSkillDir(args.workspace, args.harness);
  const target = path.join(root, args.skillId);
  const removed = fs.existsSync(target);
  fs.rmSync(target, { recursive: true, force: true });
  return {
    harness: args.harness,
    skillId: args.skillId,
    removed,
  };
}
