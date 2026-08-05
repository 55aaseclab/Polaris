import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PASEO_LOCAL_SCRIPT = path.resolve("scripts/lib/paseo-local.sh");

function withSourceFixture(setup, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-paseo-source-"));
  const source = path.join(root, "apps", "paseo", "source");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), "{}\n", "utf8");
  try {
    setup(source);
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function ensureSuccessful(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function runEnsureSource(cwd) {
  return spawnSync("bash", ["-lc", `source ${JSON.stringify(PASEO_LOCAL_SCRIPT)}; paseo_local_ensure_source`], {
    cwd,
    encoding: "utf8",
  });
}

test("Paseo source validation rejects a package checkout without Git metadata", () => {
  withSourceFixture(() => {}, (root) => {
    const result = runEnsureSource(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Paseo source is incomplete or lacks usable Git metadata/);
  });
});

test("Paseo source validation rejects an unusable Git directory", () => {
  withSourceFixture((source) => {
    fs.mkdirSync(path.join(source, ".git"));
  }, (root) => {
    const result = runEnsureSource(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Paseo source is incomplete or lacks usable Git metadata/);
  });
});

test("Paseo source validation accepts a checkout with a resolvable Git HEAD", () => {
  withSourceFixture((source) => {
    ensureSuccessful("git", ["init", "--quiet"], source);
    ensureSuccessful("git", ["add", "package.json"], source);
    ensureSuccessful(
      "git",
      [
        "-c",
        "user.name=Polaris Test",
        "-c",
        "user.email=polaris-test@example.test",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
      source,
    );
  }, (root) => {
    const result = runEnsureSource(root);
    assert.equal(result.status, 0, result.stderr);
  });
});
