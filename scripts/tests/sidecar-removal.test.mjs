import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("deploy script no longer restarts executor sidecars", () => {
  const script = fs.readFileSync("scripts/deploy-polaris.sh", "utf8");
  assert.doesNotMatch(script, /polaris-executor\.service/);
  assert.doesNotMatch(script, /polaris-executor-bridge-proxy\.service/);
  assert.doesNotMatch(script, /restart_executor=/);
  assert.doesNotMatch(script, /restart_bridge=/);
});

test("remote provision no longer creates executor services or env entries", () => {
  const script = fs.readFileSync("scripts/provision-remote.sh", "utf8");
  assert.doesNotMatch(script, /run-polaris-executor-host\.sh/);
  assert.doesNotMatch(script, /run-polaris-executor-bridge-proxy\.sh/);
  assert.doesNotMatch(script, /POLARIS_EXECUTOR_SHARED_SECRET/);
  assert.doesNotMatch(script, /POLARIS_EXECUTOR_HOST/);
  assert.doesNotMatch(script, /polaris-executor\.service/);
  assert.doesNotMatch(script, /polaris-executor-bridge-proxy\.service/);
});
