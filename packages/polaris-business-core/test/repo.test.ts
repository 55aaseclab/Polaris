import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { resetRootEnvCacheForTests } from "../src/load-env.js";
import {
  DATA_ROOT_ENV,
  getCacheDir,
  getDataRoot,
  getNamedCacheDir,
  getWorkspacesDir,
  POLARIS_WORKSPACES_ROOT_ENV,
  resetRepoRootCachesForTests,
  RUNTIME_MODE_ENV,
} from "../src/repo.js";

function reset(): void {
  resetRepoRootCachesForTests();
  resetRootEnvCacheForTests();
}

test("standalone Polaris business requires one data root", () => {
  const previousDataRoot = process.env[DATA_ROOT_ENV];
  const previousMode = process.env[RUNTIME_MODE_ENV];
  process.env[RUNTIME_MODE_ENV] = "standalone";
  process.env[DATA_ROOT_ENV] = "";
  reset();
  try {
    assert.throws(
      () => getDataRoot(),
      /Missing required environment variable: POLARIS_BUSINESS_DATA_ROOT/u,
    );
  } finally {
    if (previousDataRoot === undefined) delete process.env[DATA_ROOT_ENV];
    else process.env[DATA_ROOT_ENV] = previousDataRoot;
    if (previousMode === undefined) delete process.env[RUNTIME_MODE_ENV];
    else process.env[RUNTIME_MODE_ENV] = previousMode;
    reset();
  }
});

test("standalone Polaris business derives all paths below POLARIS_BUSINESS_DATA_ROOT", () => {
  const root = mkdtempSync(join(tmpdir(), "wanghai-data-root-"));
  mkdirSync(root, { recursive: true });
  const previousDataRoot = process.env[DATA_ROOT_ENV];
  const previousMode = process.env[RUNTIME_MODE_ENV];
  process.env[RUNTIME_MODE_ENV] = "standalone";
  process.env[DATA_ROOT_ENV] = root;
  reset();
  try {
    assert.equal(getDataRoot(), root);
    assert.equal(getWorkspacesDir(), join(root, "workspaces"));
    assert.equal(getCacheDir(), join(root, "cache"));
    assert.equal(getNamedCacheDir("semantic-scholar"), join(root, "cache", "semantic-scholar"));
    assert.throws(() => getNamedCacheDir("../escape"), /Invalid cache directory name/u);
  } finally {
    if (previousDataRoot === undefined) delete process.env[DATA_ROOT_ENV];
    else process.env[DATA_ROOT_ENV] = previousDataRoot;
    if (previousMode === undefined) delete process.env[RUNTIME_MODE_ENV];
    else process.env[RUNTIME_MODE_ENV] = previousMode;
    reset();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Polaris mode uses the mounted vault without standalone data configuration", () => {
  const previousDataRoot = process.env[DATA_ROOT_ENV];
  const previousMode = process.env[RUNTIME_MODE_ENV];
  process.env[RUNTIME_MODE_ENV] = "polaris";
  delete process.env[DATA_ROOT_ENV];
  reset();
  try {
    assert.equal(getDataRoot(), "/vault");
    assert.equal(getWorkspacesDir(), "/vault/workspaces");
    assert.equal(getCacheDir(), "/vault/cache");
  } finally {
    if (previousDataRoot === undefined) delete process.env[DATA_ROOT_ENV];
    else process.env[DATA_ROOT_ENV] = previousDataRoot;
    if (previousMode === undefined) delete process.env[RUNTIME_MODE_ENV];
    else process.env[RUNTIME_MODE_ENV] = previousMode;
    reset();
  }
});

test("Polaris mode rejects an alternate vault root", () => {
  const previousMode = process.env[RUNTIME_MODE_ENV];
  const previousRoot = process.env[POLARIS_WORKSPACES_ROOT_ENV];
  process.env[RUNTIME_MODE_ENV] = "polaris";
  process.env[POLARIS_WORKSPACES_ROOT_ENV] = "/tmp/synthetic-escape";
  reset();
  try {
    assert.throws(
      () => getDataRoot(),
      /must use the fixed \/vault\/workspaces root/u,
    );
  } finally {
    if (previousMode === undefined) delete process.env[RUNTIME_MODE_ENV];
    else process.env[RUNTIME_MODE_ENV] = previousMode;
    if (previousRoot === undefined) delete process.env[POLARIS_WORKSPACES_ROOT_ENV];
    else process.env[POLARIS_WORKSPACES_ROOT_ENV] = previousRoot;
    reset();
  }
});
