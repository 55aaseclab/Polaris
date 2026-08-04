import assert from "node:assert/strict";
import test from "node:test";
import {
  planOpenWanghaiPortal,
  isWanghaiPortalEmbedPath,
} from "./portal.js";

test("plans a gateway-owned shell embed route", () => {
  const plan = planOpenWanghaiPortal("srv_1");
  assert.equal(plan.shellEmbedPath, "/v/srv_1/wanghai");
  assert.equal(isWanghaiPortalEmbedPath(plan.shellEmbedPath), true);
  assert.equal(isWanghaiPortalEmbedPath("/h/srv_1"), false);
});
