import assert from "node:assert/strict";
import test from "node:test";
import {
  isPaseoSurfacePath,
  PASEO_APP_SHELL_ROUTES_TO_REMOVE,
  paseoSurfacePath,
} from "./routes.js";

test("paseo surface owns /h only", () => {
  assert.equal(isPaseoSurfacePath("/h/srv_1"), true);
  assert.equal(isPaseoSurfacePath("/h/srv_1/workspace/w1"), true);
  assert.equal(isPaseoSurfacePath("/settings/user"), false);
  assert.equal(isPaseoSurfacePath("/welcome"), false);
  assert.equal(isPaseoSurfacePath("/hosts"), false);
  assert.equal(isPaseoSurfacePath("/v/srv_1/wanghai"), false);
  assert.equal(isPaseoSurfacePath("/"), false);
});

test("paseoSurfacePath builds left-right host routes", () => {
  assert.equal(paseoSurfacePath("host-root", { serverId: "srv_a" }), "/h/srv_a");
  assert.equal(
    paseoSurfacePath("workspace", { serverId: "srv_a", workspaceId: "demo" }),
    "/h/srv_a/workspace/demo",
  );
  assert.equal(
    paseoSurfacePath("agent", { serverId: "srv_a", agentId: "ag_1" }),
    "/h/srv_a/agent/ag_1",
  );
});

test("surface-coding no longer tracks welcome as a shell route to strip", () => {
  assert.deepEqual(
    [...PASEO_APP_SHELL_ROUTES_TO_REMOVE],
    ["/", "/auth/callback", "/settings", "/settings/user", "/hosts", "/v"],
  );
});
