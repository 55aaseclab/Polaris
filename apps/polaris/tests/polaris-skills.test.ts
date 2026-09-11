import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { runCli } from "../scripts/cli/main.js";
import { createUserCommand } from "../scripts/cli/commands/create-user.js";
import { listAvailableSkills } from "../scripts/install-skills.js";
import { runPipeline } from "polaris-workflow";
import { loadVaultFromConfigPath, resolveVaultConfigPath } from "../scripts/config/load.js";
import { vaultConfigPath } from "../scripts/config/scaffold.js";
import {
  addUserSkill,
  createSkillsCliDescriptor,
  listUserSkills,
  listInstalledVaultSkills,
  removeUserSkill,
  removeInstalledVaultSkill,
  resolveVaultSkillInstallRoot,
} from "../scripts/config/skills.js";
import {
  createPortalSkill,
  deletePortalSkill,
  listUserPortalSkills,
} from "../scripts/portal/service.js";
import { polarisUsersRoot } from "../scripts/utils/paths.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const USER_ROOT = polarisUsersRoot(import.meta.url);
const STDOUT_CAPTURE_QUEUE_KEY = "__polaris_skill_stdout_capture_queue__";
const DEMO_USER_PROFILE_ID = "100000000000000001";

test("built-in skill installer reads the repository skill tree", () => {
  const skills = listAvailableSkills();
  assert.ok(skills.includes("rc-draw"));
  assert.ok(skills.includes("polaris-business"));
  assert.ok(skills.includes("polaris-data-collection"));
});

test("migrated skill bundle and coursework pack are Polaris-owned", () => {
  const migratedSkills = [
    "polaris-business",
    "polaris-content-production",
    "polaris-data-collection",
    "polaris-intelligence-analysis",
    "polaris-order-ops",
    "polaris-outreach",
    "polaris-report-writing",
    "polaris-ads-system-setup",
  ];
  const skillRoots: Record<string, string> = {
    "polaris-business": path.join(REPO_ROOT, "packs", "business", "skills", "polaris-business"),
    "polaris-content-production": path.join(REPO_ROOT, "tools", "content-production", "skills", "polaris-content-production"),
    "polaris-data-collection": path.join(REPO_ROOT, "tools", "data-collection", "skills", "polaris-data-collection"),
    "polaris-intelligence-analysis": path.join(REPO_ROOT, "tools", "intelligence-analysis", "skills", "polaris-intelligence-analysis"),
    "polaris-order-ops": path.join(REPO_ROOT, "tools", "logistics-management", "skills", "polaris-order-ops"),
    "polaris-outreach": path.join(REPO_ROOT, "tools", "outreach", "skills", "polaris-outreach"),
    "polaris-report-writing": path.join(REPO_ROOT, "tools", "report-writing", "skills", "polaris-report-writing"),
    "polaris-ads-system-setup": path.join(REPO_ROOT, "packs", "business", "skills", "polaris-ads-system-setup"),
  };
  for (const skill of migratedSkills) {
    const skillPath = path.join(skillRoots[skill]!, "SKILL.md");
    assert.equal(fs.existsSync(skillPath), true, skillPath);
    const source = fs.readFileSync(skillPath, "utf8");
    assert.doesNotMatch(source, /@wanghai\/|apps\/wanghai|skills\/wanghai|pnpm wanghai/u, skillPath);
  }

  const courseworkPath = path.join(
    REPO_ROOT,
    "third_party",
    "coursework-vaults",
    "polaris-domain-pack",
    "main.ord",
  );
  const coursework = fs.readFileSync(courseworkPath, "utf8");
  const parsed = runPipeline(coursework);
  assert.equal(parsed.ok, true, parsed.parseErrors.map((error) => error.message).join("; "));
});

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

function getStdoutCaptureQueue(): Promise<void> {
  const existing = (globalThis as Record<string, unknown>)[STDOUT_CAPTURE_QUEUE_KEY];
  return existing instanceof Promise ? (existing as Promise<void>) : Promise.resolve();
}

function setStdoutCaptureQueue(queue: Promise<void>): void {
  (globalThis as Record<string, unknown>)[STDOUT_CAPTURE_QUEUE_KEY] = queue;
}

async function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const previous = getStdoutCaptureQueue();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  setStdoutCaptureQueue(next);
  await previous;
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    const callback = args.find((arg) => typeof arg === "function") as (() => void) | undefined;
    callback?.();
    return true;
  }) as typeof process.stdout.write;

  try {
    await fn();
    return chunks.join("");
  } finally {
    process.stdout.write = originalWrite;
    release();
  }
}

function parseJsonOutput<T>(stdout: string): T {
  const trimmed = stdout.trim();
  const end = trimmed.lastIndexOf("}");
  if (end === -1) {
    throw new Error(`No JSON object found in stdout: ${JSON.stringify(trimmed)}`);
  }
  for (let start = trimmed.lastIndexOf("{", end); start !== -1; start = trimmed.lastIndexOf("{", start - 1)) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    } catch {
      continue;
    }
  }
  throw new Error(`No JSON object found in stdout: ${JSON.stringify(trimmed)}`);
}

async function cleanupUser(userId: string): Promise<void> {
  try {
    await runCli(["user", "delete", userId]);
  } catch {
    // Best-effort cleanup for tests that intentionally leave state behind.
  }
  fs.rmSync(path.join(USER_ROOT, "profiles", `${userId}.yaml`), { force: true });
  fs.rmSync(path.join(USER_ROOT, userId), { recursive: true, force: true });
}

async function withFakeCommands(
  commands: Record<string, string>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-skills-test-"));
  const originalPath = process.env.PATH || "";
  for (const [commandName, scriptBody] of Object.entries(commands)) {
    const commandPath = path.join(tempDir, commandName);
    fs.writeFileSync(
      commandPath,
      `#!/usr/bin/env bash
${scriptBody}
`,
      { mode: 0o755 },
    );
  }
  process.env.PATH = `${tempDir}:${originalPath}`;
  try {
    await fn();
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("skill descriptor builder maps source and skill name to npx skills add args", () => {
  const codex = createSkillsCliDescriptor({
    source: "vercel-labs/agent-skills",
    harness: "codex",
    selectedSkillName: "use-polaris",
  });
  assert.equal(codex.packageName, "skills");
  assert.deepEqual(codex.args, [
    "add",
    "vercel-labs/agent-skills",
    "--copy",
    "-y",
    "--agent",
    "codex",
    "--skill",
    "use-polaris",
  ]);
  assert.equal(codex.suggestedSkillId, "use-polaris");

  const claude = createSkillsCliDescriptor({
    source: "github:owner/repo",
    harness: "claude",
    selectedSkillName: "claude-review",
  });
  assert.deepEqual(claude.args, [
    "add",
    "github:owner/repo",
    "--copy",
    "-y",
    "--agent",
    "claude-code",
    "--skill",
    "claude-review",
  ]);
});

test("skill descriptor builder rejects local sources", () => {
  assert.throws(
    () => createSkillsCliDescriptor({
      source: "./local-skill",
      harness: "codex",
      selectedSkillName: "use-polaris",
    }),
    /local skill sources are not supported/,
  );
});

test("user skill CLI add, list, and remove manage declarative registry entries", async () => {
  const userId = uniqueName("skills-cli");

  try {
    await createUserCommand([
      userId,
      "--name",
      "Skills CLI User",
      "--email",
      `${userId}@polaris.local`,
    ]);

    const addStdout = await captureStdout(async () => {
      await runCli([
        "user",
        "skill",
        "add",
        userId,
        "--source",
        "vercel-labs/agent-skills",
        "--skill",
        "use-polaris",
      ]);
    });
    const added = parseJsonOutput<{
      skill: {
        id: string;
        packageName: string;
        args: string[];
        command: string[];
        source?: string;
        selectedSkillName: string;
      };
    }>(addStdout);
    assert.equal(added.skill.id, "use-polaris");
    assert.equal(added.skill.packageName, "skills");
    assert.deepEqual(added.skill.args, [
      "add",
      "vercel-labs/agent-skills",
      "--copy",
      "-y",
      "--agent",
      "codex",
      "--skill",
      "use-polaris",
    ]);
    assert.deepEqual(added.skill.command, [
      "npx",
      "-y",
      "skills",
      "add",
      "vercel-labs/agent-skills",
      "--copy",
      "-y",
      "--agent",
      "codex",
      "--skill",
      "use-polaris",
    ]);
    assert.equal(added.skill.source, "vercel-labs/agent-skills");
    assert.equal(added.skill.selectedSkillName, "use-polaris");

    const listStdout = await captureStdout(async () => {
      await runCli(["user", "skill", "list", userId]);
    });
    const listed = parseJsonOutput<{
      skills: Array<{ id: string; label: string }>;
    }>(listStdout);
    assert.ok(listed.skills.some((skill) => skill.id === "use-polaris" && skill.label === "use-polaris"));

    const removeStdout = await captureStdout(async () => {
      await runCli(["user", "skill", "remove", userId, "use-polaris"]);
    });
    const removed = parseJsonOutput<{
      skill: { id: string; removed: boolean };
    }>(removeStdout);
    assert.equal(removed.skill.id, "use-polaris");
    assert.equal(removed.skill.removed, true);
  } finally {
    await cleanupUser(userId);
  }
});

test("user skill config helpers reject duplicates and missing users", async () => {
  const userId = uniqueName("skills-config");

  try {
    await createUserCommand([
      userId,
      "--name",
      "Skills Config User",
      "--email",
      `${userId}@polaris.local`,
    ]);

    const created = addUserSkill({
      userProfileId: userId,
      skillId: "use-polaris",
      harness: "codex",
      packageName: "skills",
      args: ["add", "vercel-labs/agent-skills", "--skill", "use-polaris"],
      source: "vercel-labs/agent-skills",
      selectedSkillName: "use-polaris",
    });
    assert.equal(created.id, "use-polaris");

    assert.throws(
      () =>
        addUserSkill({
          userProfileId: userId,
          skillId: "use-polaris",
          harness: "codex",
          packageName: "skills",
          selectedSkillName: "use-polaris",
        }),
      /already exists/,
    );

    assert.throws(
      () => listUserSkills("missing-user"),
      /was not found/,
    );

    const listed = listUserSkills(userId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, "use-polaris");

    const registry = (yaml.load(
      fs.readFileSync(
        path.join(USER_ROOT, userId, "skills", "use-polaris.yaml"),
        "utf8",
      ),
    ) ?? {}) as { packageName?: string; source?: string; selectedSkillName?: string };
    assert.equal(registry.packageName, "skills");
    assert.equal(registry.source, "vercel-labs/agent-skills");
    assert.equal(registry.selectedSkillName, "use-polaris");

    const removed = removeUserSkill({
      userProfileId: userId,
      skillId: "use-polaris",
    });
    assert.equal(removed.removed, true);
  } finally {
    await cleanupUser(userId);
  }
});

test("portal skill service creates, lists, and deletes registry entries", async () => {
  const userId = uniqueName("skills-portal");

  try {
    await createUserCommand([
      userId,
      "--name",
      "Skills Portal User",
      "--email",
      `${userId}@polaris.local`,
    ]);

    const created = await createPortalSkill({
      userId,
      harness: "codex",
      source: "vercel-labs/agent-skills",
      skillName: "use-polaris",
    });
    assert.equal(created.id, "use-polaris");
    assert.equal(created.packageName, "skills");
    assert.equal(created.source, "vercel-labs/agent-skills");
    assert.equal(created.selectedSkillName, "use-polaris");

    const listed = listUserPortalSkills(userId);
    assert.ok(listed.some((skill) => skill.id === "use-polaris"));

    const deleted = await deletePortalSkill(userId, "use-polaris");
    assert.equal(deleted.skill.id, "use-polaris");
    assert.equal(deleted.skill.removed, true);
  } finally {
    await cleanupUser(userId);
  }
});

test("skill registry supports claude harness entries", async () => {
  const userId = uniqueName("skills-claude");

  try {
    await createUserCommand([
      userId,
      "--name",
      "Skills Claude User",
      "--email",
      `${userId}@polaris.local`,
    ]);

    const created = addUserSkill({
      userProfileId: userId,
      skillId: "claude-review",
      harness: "claude",
      packageName: "skills",
      args: ["add", "vercel-labs/agent-skills", "--skill", "claude-review"],
      source: "vercel-labs/agent-skills",
      selectedSkillName: "claude-review",
    });
    assert.equal(created.harness, "claude");

    const listed = listUserSkills(userId);
    assert.ok(listed.some((skill) => skill.id === "claude-review" && skill.harness === "claude"));
  } finally {
    await cleanupUser(userId);
  }
});

test("vault skill helpers list and remove installed codex and claude skills", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-skill-root-"));
  const fakeVault = {
    attachments: {
      userIdentityState: {
        mountRoot: root,
      },
    },
  } as any;

  try {
    fs.mkdirSync(path.join(root, "codex", "skills", "use-polaris"), { recursive: true });
    fs.mkdirSync(path.join(root, "claude", "skills", "claude-review"), { recursive: true });

    assert.equal(
      resolveVaultSkillInstallRoot(fakeVault, "codex"),
      path.join(root, "codex", "skills"),
    );
    assert.equal(
      resolveVaultSkillInstallRoot(fakeVault, "claude"),
      path.join(root, "claude", "skills"),
    );

    const listed = listInstalledVaultSkills({ vault: fakeVault });
    assert.ok(listed.some((entry) => entry.harness === "codex" && entry.skills.includes("use-polaris")));
    assert.ok(listed.some((entry) => entry.harness === "claude" && entry.skills.includes("claude-review")));

    const removed = removeInstalledVaultSkill({
      vault: fakeVault,
      harness: "claude",
      skillId: "claude-review",
    });
    assert.equal(removed.removed, true);
    assert.equal(fs.existsSync(path.join(root, "claude", "skills", "claude-review")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
