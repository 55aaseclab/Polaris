import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("local stack service does not start a standalone executor or bridge proxy", () => {
  const script = fs.readFileSync("scripts/run-polaris-local-stack-service.sh", "utf8");
  assert.doesNotMatch(script, /scripts\/polaris\.ts executor/);
  assert.doesNotMatch(script, /run-polaris-executor-bridge-proxy\.sh/);
  assert.doesNotMatch(script, /executor_bridge_proxy_pid/);
  assert.doesNotMatch(script, /stack\.executor-bridge\.log/);
  assert.doesNotMatch(script, /stack\.executor\.log/);
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

test("local stack service binds the API to 0.0.0.0 by default", () => {
  const script = fs.readFileSync("scripts/run-polaris-local-stack-service.sh", "utf8");
  assert.match(script, /SERVER_HOST="\$\{POLARIS_SERVER_BIND_HOST:-0\.0\.0\.0\}"/);
  assert.doesNotMatch(script, /EXECUTOR_HOST=/);
  assert.doesNotMatch(script, /EXECUTOR_PORT=/);
});

test("local stack service builds shell and surface packages", () => {
  const script = fs.readFileSync("scripts/run-polaris-local-stack-service.sh", "utf8");
  assert.match(script, /pnpm run build:surfaces/);
  assert.match(script, /in-container \(per vault\): paseo daemon :6767/);
  assert.match(script, /wanghai portal :9090/);
  // Product flavor is per-user, not a single-stack env switch.
  assert.doesNotMatch(script, /EXPO_PUBLIC_POLARIS_PRODUCT/);
  assert.doesNotMatch(script, /POLARIS_PRODUCT=/);
});
