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

test("local stack service does not start a standalone admin web app", () => {
  const script = fs.readFileSync("scripts/run-polaris-local-stack-service.sh", "utf8");
  assert.doesNotMatch(script, /POLARIS_ADMIN_WEB_PORT/);
  assert.doesNotMatch(script, /polaris-web-admin/);
  assert.doesNotMatch(script, /stack\.admin-web\.log/);
});

test("local stack service runs Paseo with Fast Refresh instead of a web artifact build", () => {
  const script = fs.readFileSync("scripts/run-polaris-local-stack-service.sh", "utf8");
  assert.match(script, /cd apps\/paseo\/source\/packages\/app/);
  assert.match(script, /npx expo start --web --host lan/);
  assert.match(script, /EXPO_PUBLIC_POLARIS_API_PORT/);
  assert.match(script, /npm run build:app-deps/);
  assert.doesNotMatch(script, /paseo_local_build_dist/);
  assert.doesNotMatch(script, /paseo_local_build_tool_bundle/);
});
