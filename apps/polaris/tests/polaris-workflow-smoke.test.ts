import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { closePolarisControlStore } from "../scripts/portal/control-store.js";

test("workflow smoke command exercises the mock-only path end to end", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-workflow-smoke-test-"));
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    POLARIS_DATA_ROOT: process.env.POLARIS_DATA_ROOT,
    POLARIS_CONTROL_STORE_PATH: process.env.POLARIS_CONTROL_STORE_PATH,
  };
  process.env.NODE_ENV = "test";
  process.env.POLARIS_DATA_ROOT = path.join(root, "data");
  process.env.POLARIS_CONTROL_STORE_PATH = path.join(root, "control.sqlite");
  closePolarisControlStore();

  try {
    const result = spawnSync(
      "pnpm",
      ["--filter", "polaris", "exec", "tsx", "scripts/polaris.ts", "ops", "workflow-smoke", "--json"],
      {
        cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
        encoding: "utf8",
        env: process.env,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout;
    const parsed = JSON.parse(output) as {
      mode: string;
      ffi: string;
      tools: string;
      tenantId: string;
      packId: string;
      packVersion: string;
      packDigest: string;
      vaultId: string;
      runId: string;
      approvalRunId: string;
      summaryRunId: string;
      suggestionId: string;
      receipts: number;
      artifacts: number;
      events: number;
    };
    assert.equal(parsed.mode, "mock");
    assert.equal(parsed.ffi, "mocked");
    assert.equal(parsed.tools, "mocked");
    assert.match(parsed.tenantId, /^tenant-/u);
    assert.match(parsed.vaultId, /^vault-/u);
    assert.match(parsed.packDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.match(parsed.runId, /^run-/u);
    assert.match(parsed.approvalRunId, /^run-/u);
    assert.match(parsed.summaryRunId, /^run-/u);
    assert.match(parsed.suggestionId, /^suggestion-/u);
    assert.equal(parsed.receipts, 1);
    assert.equal(parsed.artifacts, 1);
    assert.equal(parsed.events >= 2, true);
  } finally {
    closePolarisControlStore();
    if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.NODE_ENV;
    if (previous.POLARIS_DATA_ROOT === undefined) delete process.env.POLARIS_DATA_ROOT;
    else process.env.POLARIS_DATA_ROOT = previous.POLARIS_DATA_ROOT;
    if (previous.POLARIS_CONTROL_STORE_PATH === undefined) delete process.env.POLARIS_CONTROL_STORE_PATH;
    else process.env.POLARIS_CONTROL_STORE_PATH = previous.POLARIS_CONTROL_STORE_PATH;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
