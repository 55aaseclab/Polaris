import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRootEnv, resetRootEnvCacheForTests } from "../src/load-env.js";

test("loadRootEnv fills missing keys and never overrides existing ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-business-load-env-"));
  const envPath = path.join(dir, ".env.dev");
  fs.writeFileSync(
    envPath,
    [
      "# comment",
      "POLARIS_BUSINESS_WORKSPACES_ROOT=/from-file/workspaces",
      "POLARIS_BUSINESS_BACKUP_ROOT=/from-file/backups",
      "SHARED_KEY=from-file",
      "",
    ].join("\n"),
    "utf8",
  );

  const previousShared = process.env.SHARED_KEY;
  process.env.SHARED_KEY = "from-shell";
  delete process.env.POLARIS_BUSINESS_WORKSPACES_ROOT;
  delete process.env.POLARIS_BUSINESS_BACKUP_ROOT;
  resetRootEnvCacheForTests();

  try {
    const loaded = loadRootEnv(dir);
    assert.equal(loaded, envPath);
    assert.equal(process.env.POLARIS_BUSINESS_WORKSPACES_ROOT, "/from-file/workspaces");
    assert.equal(process.env.POLARIS_BUSINESS_BACKUP_ROOT, "/from-file/backups");
    assert.equal(process.env.SHARED_KEY, "from-shell");
  } finally {
    if (previousShared === undefined) delete process.env.SHARED_KEY;
    else process.env.SHARED_KEY = previousShared;
    delete process.env.POLARIS_BUSINESS_WORKSPACES_ROOT;
    delete process.env.POLARIS_BUSINESS_BACKUP_ROOT;
    resetRootEnvCacheForTests();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});
