import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  measureWorkspaceUsage,
  WorkspaceUsageError,
} from "../src/workspace-usage.js";

function temporaryWorkspaceRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-workspace-usage-"));
}

test("workspace usage counts vault-local files without following symlinks", () => {
  const root = temporaryWorkspaceRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-workspace-outside-"));
  try {
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "first.txt"), "abc", "utf8");
    fs.writeFileSync(path.join(root, "nested", "second.txt"), "12345", "utf8");
    fs.writeFileSync(path.join(outside, "outside.txt"), "this must not be counted", "utf8");
    fs.symlinkSync(path.join(outside, "outside.txt"), path.join(root, "outside-link"));

    const usage = measureWorkspaceUsage({ rootDir: root });
    assert.equal(usage.usageBytes, 8 + path.join(outside, "outside.txt").length);
    assert.equal(usage.fileCount, 2);
    assert.equal(usage.entryCount, 4);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
    fs.rmSync(outside, { force: true, recursive: true });
  }
});

test("workspace usage returns zero for a missing workspace root", () => {
  const root = path.join(os.tmpdir(), `wanghai-workspace-missing-${process.pid}-${Date.now()}`);
  assert.deepEqual(measureWorkspaceUsage({ rootDir: root }), {
    usageBytes: 0,
    fileCount: 0,
    entryCount: 0,
  });
});

test("workspace usage fails closed when traversal exceeds its bounded entry limit", () => {
  const root = temporaryWorkspaceRoot();
  try {
    fs.writeFileSync(path.join(root, "first.txt"), "first", "utf8");
    fs.writeFileSync(path.join(root, "second.txt"), "second", "utf8");
    assert.throws(
      () => measureWorkspaceUsage({ rootDir: root, maxEntries: 1 }),
      WorkspaceUsageError,
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
