import assert from "node:assert/strict";
import test from "node:test";
import {
  findWanghaiPortalPort,
  planOpenWanghaiPortal,
  resolveWanghaiPortalUrl,
  WANGHAI_PORTAL_CONTAINER_PORT,
} from "./portal.js";

test("finds wanghai port by name or container port", () => {
  assert.equal(
    findWanghaiPortalPort([{ name: "paseo", containerPort: 6767, nodePort: 32001 }]),
    null,
  );
  const named = findWanghaiPortalPort([
    { name: "paseo", containerPort: 6767, nodePort: 32001 },
    { name: "wanghai", containerPort: 9090, nodePort: 32002 },
  ]);
  assert.equal(named?.nodePort, 32002);
  const byPort = findWanghaiPortalPort([
    { containerPort: WANGHAI_PORTAL_CONTAINER_PORT, nodePort: 32100 },
  ]);
  assert.equal(byPort?.nodePort, 32100);
});

test("resolves browser URL from public host and node port", () => {
  const url = resolveWanghaiPortalUrl({
    publicHost: "128.0.0.1",
    ports: [
      { name: "paseo", containerPort: 6767, nodePort: 32001 },
      { name: "wanghai", containerPort: 9090, nodePort: 32099 },
    ],
  });
  assert.equal(url, "http://128.0.0.1:32099");
});

test("plans external open by default", () => {
  const plan = planOpenWanghaiPortal({
    serverId: "srv_1",
    portalUrl: "http://example:32099",
  });
  assert.equal(plan.mode, "external");
  assert.equal(plan.href, "http://example:32099");
  assert.equal(plan.shellEmbedPath, "/v/srv_1/wanghai");
});
