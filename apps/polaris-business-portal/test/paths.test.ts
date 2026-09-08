import assert from "node:assert/strict";
import test from "node:test";
import { stripWanghaiBasePath, wanghaiPath } from "../lib/paths.js";

test("wanghaiPath mounts browser-relative URLs below the fixed surface path", () => {
  assert.equal(wanghaiPath("/api/workspaces"), "/wanghai/api/workspaces");
  assert.equal(wanghaiPath("/api/workspaces?all=1"), "/wanghai/api/workspaces?all=1");
  assert.equal(wanghaiPath("/wanghai/api/workspaces"), "/wanghai/api/workspaces");
  assert.equal(wanghaiPath("/"), "/wanghai/");
  assert.equal(wanghaiPath("https://example.test/assets/app.js"), "https://example.test/assets/app.js");
});

test("stripWanghaiBasePath exposes the route shape used by surface contracts", () => {
  assert.equal(stripWanghaiBasePath("/wanghai"), "/");
  assert.equal(stripWanghaiBasePath("/wanghai/"), "/");
  assert.equal(stripWanghaiBasePath("/wanghai/api/workspaces"), "/api/workspaces");
  assert.equal(stripWanghaiBasePath("/api/workspaces"), "/api/workspaces");
});
