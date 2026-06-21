import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installSkills,
  listAvailableSkills,
  resolveInstallRoot,
} from "../scripts/install-skills.js";

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-skills-"));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

function makeSkill(sourceRoot: string, name: string): void {
  const skillDir = path.join(sourceRoot, name);
  fs.mkdirSync(path.join(skillDir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `# ${name}\n`, "utf8");
  fs.writeFileSync(
    path.join(skillDir, "agents", "openai.yaml"),
    'interface:\n  display_name: "Test"\n',
    "utf8",
  );
}

test("listAvailableSkills returns skill directories with SKILL.md", () => {
  withTempDir((dir) => {
    const sourceRoot = path.join(dir, "skills");
    fs.mkdirSync(sourceRoot, { recursive: true });
    makeSkill(sourceRoot, "alpha");
    fs.mkdirSync(path.join(sourceRoot, "not-a-skill"), { recursive: true });

    assert.deepEqual(listAvailableSkills(sourceRoot), ["alpha"]);
  });
});

test("installSkills copies a skill tree", () => {
  withTempDir((dir) => {
    const sourceRoot = path.join(dir, "skills");
    const destinationRoot = path.join(dir, "dest");
    fs.mkdirSync(sourceRoot, { recursive: true });
    makeSkill(sourceRoot, "use-polaris");

    installSkills({
      destinationRoot,
      mode: "copy",
      skillNames: ["use-polaris"],
      sourceRoot,
    });

    const installedDir = path.join(destinationRoot, "use-polaris");
    assert.equal(fs.existsSync(path.join(installedDir, "SKILL.md")), true);
    assert.equal(
      fs.existsSync(path.join(installedDir, "agents", "openai.yaml")),
      true,
    );
    assert.equal(fs.lstatSync(installedDir).isSymbolicLink(), false);
  });
});

test("installSkills links a skill tree when requested", () => {
  withTempDir((dir) => {
    const sourceRoot = path.join(dir, "skills");
    const destinationRoot = path.join(dir, "dest");
    fs.mkdirSync(sourceRoot, { recursive: true });
    makeSkill(sourceRoot, "use-polaris");

    installSkills({
      destinationRoot,
      mode: "link",
      skillNames: ["use-polaris"],
      sourceRoot,
    });

    const installedDir = path.join(destinationRoot, "use-polaris");
    assert.equal(fs.lstatSync(installedDir).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(installedDir, "SKILL.md"), "utf8"), "# use-polaris\n");
  });
});

test("installSkills refuses to overwrite without force", () => {
  withTempDir((dir) => {
    const sourceRoot = path.join(dir, "skills");
    const destinationRoot = path.join(dir, "dest");
    fs.mkdirSync(sourceRoot, { recursive: true });
    makeSkill(sourceRoot, "use-polaris");

    installSkills({
      destinationRoot,
      skillNames: ["use-polaris"],
      sourceRoot,
    });

    assert.throws(
      () =>
        installSkills({
          destinationRoot,
          skillNames: ["use-polaris"],
          sourceRoot,
        }),
      /Destination already exists/,
    );
  });
});

test("resolveInstallRoot supports user and project scopes", () => {
  const repoRoot = "/repo";
  const homeDir = "/home/tester";

  assert.equal(
    resolveInstallRoot("codex", "user", repoRoot, homeDir),
    "/home/tester/.codex/skills",
  );
  assert.equal(
    resolveInstallRoot("claude", "project", repoRoot, homeDir),
    "/repo/.claude/skills",
  );
});
