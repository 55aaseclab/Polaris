import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("local stack service starts the executor bridge proxy for docker callbacks", () => {
  const script = fs.readFileSync("scripts/run-polaris-local-stack-service.sh", "utf8");
  assert.match(script, /run-polaris-executor-bridge-proxy\.sh/);
  assert.match(script, /executor_bridge_proxy_pid/);
  assert.match(script, /stack\.executor-bridge\.log/);
  assert.match(script, /docker workspaces may not report Paseo pairing metadata back to the host executor/);
});
