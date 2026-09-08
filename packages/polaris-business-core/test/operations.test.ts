import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  ensureOrderDirs,
  orderDirPath,
  orderManagementDir,
  readOrderMeta,
  safeOrderPath,
  validateOrderIdentifier,
} from "../src/operations.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { force: true, recursive: true });
  }
});

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-operations-"));
  fs.mkdirSync(path.join(root, "assets", "订单管理"), { recursive: true });
  tempDirs.push(root);
  return root;
}

describe("order paths", () => {
  it("accepts opaque order identifiers and rejects traversal variants", () => {
    const workspace = makeWorkspace();
    assert.equal(validateOrderIdentifier("ORDER-2026-001"), "ORDER-2026-001");
    assert.equal(
      ensureOrderDirs(workspace, "ORDER-2026-001"),
      path.join(orderManagementDir(workspace), "ORDER-2026-001"),
    );

    for (const value of ["../outside", "/tmp/outside", "nested/order", "%252e%252e", ".", ""]) {
      assert.throws(() => orderDirPath(workspace, value), /opaque path segment/i);
    }
    assert.throws(
      () => safeOrderPath(workspace, "ORDER-2026-001", "../outside"),
      /within its order directory/i,
    );
  });

  it("does not follow a symlinked order directory outside the workspace", () => {
    const workspace = makeWorkspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-operations-outside-"));
    tempDirs.push(outside);
    fs.writeFileSync(path.join(outside, "meta.json"), "{}\n", "utf8");
    fs.symlinkSync(outside, path.join(orderManagementDir(workspace), "linked-order"));

    assert.throws(() => readOrderMeta(workspace, "linked-order"), /symlink outside/i);
  });

  it("does not follow symlinked metadata outside the workspace", () => {
    const workspace = makeWorkspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-operations-outside-"));
    tempDirs.push(outside);
    const orderDir = ensureOrderDirs(workspace, "ORDER-2026-001");
    const outsideMeta = path.join(outside, "meta.json");
    fs.writeFileSync(outsideMeta, "{\"synthetic\":true}\n", "utf8");
    fs.symlinkSync(outsideMeta, path.join(orderDir, "meta.json"));

    assert.throws(() => readOrderMeta(workspace, "ORDER-2026-001"), /symlink outside/i);
  });
});
