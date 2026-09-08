import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createWorkspace,
  listWorkspaces,
  resolveWorkspacePath,
  safeWorkspacePath,
  WorkspacePaths,
} from "../src/workspaces.js";
import { resetRepoRootCachesForTests } from "../src/repo.js";
import { readWorkspaceVersion } from "../src/workspace-version.js";

function writeWorkspace(
  root: string,
  name: string,
  metadata: Record<string, unknown>,
): void {
  const workspaceDir = path.join(root, name);
  fs.mkdirSync(path.join(workspaceDir, "产品管理"), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, "workspace.json"),
    `${JSON.stringify({ name, ...metadata }, null, 2)}\n`,
    "utf8",
  );
}

test("listWorkspaces reads workspace types and falls back when metadata is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-core-workspaces-"));
  try {
    writeWorkspace(root, "songjin", { type: "ecommerce" });
    writeWorkspace(root, "literature-review", { type: "research" });
    writeWorkspace(root, "token-exporting", {});

    const brokenWorkspaceDir = path.join(root, "broken-workspace");
    fs.mkdirSync(path.join(brokenWorkspaceDir, "产品管理"), { recursive: true });
    fs.writeFileSync(path.join(brokenWorkspaceDir, "workspace.json"), "{broken", "utf8");

    assert.deepEqual(
      listWorkspaces(root).map(({ name, type }) => ({ name, type })),
      [
        { name: "broken-workspace", type: "unclassified" },
        { name: "literature-review", type: "research" },
        { name: "songjin", type: "ecommerce" },
        { name: "token-exporting", type: "unclassified" },
      ],
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("listWorkspaces ignores directories without workspace.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-core-workspaces-no-meta-"));
  try {
    const assetOnlyDir = path.join(root, "asset-only");
    fs.mkdirSync(path.join(assetOnlyDir, "产品管理"), { recursive: true });

    assert.deepEqual(listWorkspaces(root), []);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("createWorkspace writes the expected v3 workspace structure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-core-workspaces-create-"));
  try {
    const created = createWorkspace({
      rootDir: root,
      type: "research",
      workspace: "rust-for-linux",
    });

    assert.equal(created.name, "rust-for-linux");
    assert.equal(created.type, "research");
    assert.ok(fs.existsSync(path.join(created.path, "workspace.json")));
    assert.ok(fs.existsSync(path.join(created.path, "workspace-layout.json")));
    assert.ok(fs.existsSync(path.join(created.path, "README.md")));
    assert.ok(fs.existsSync(path.join(created.path, "assets", "产品管理", "产品库")));
    assert.ok(fs.existsSync(path.join(created.path, "assets", "seo-ops", "sites")));
    assert.ok(fs.existsSync(path.join(created.path, "workflows")));
    assert.equal(readWorkspaceVersion(created.path), 1);

    const metadata = JSON.parse(
      fs.readFileSync(path.join(created.path, "workspace.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(metadata.name, "rust-for-linux");
    assert.equal(metadata.type, "research");

    const layout = JSON.parse(
      fs.readFileSync(path.join(created.path, "workspace-layout.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(layout.layout_version, 3);
    assert.deepEqual(layout.customer, { name: "rust-for-linux" });
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("workspace resolution rejects paths, repeated encoding, and symlink escape", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-core-workspaces-safe-"));
  const root = path.join(dataRoot, "workspaces");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-core-outside-"));
  const previousDataRoot = process.env.POLARIS_BUSINESS_DATA_ROOT;
  const previousMode = process.env.POLARIS_BUSINESS_RUNTIME_MODE;
  try {
    writeWorkspace(root, "tenant-a", { type: "ecommerce" });
    fs.symlinkSync(outside, path.join(root, "tenant-a", "escaped"));
    process.env.POLARIS_BUSINESS_DATA_ROOT = dataRoot;
    process.env.POLARIS_BUSINESS_RUNTIME_MODE = "standalone";
    resetRepoRootCachesForTests();

    assert.equal(resolveWorkspacePath("tenant-a"), path.join(root, "tenant-a"));
    assert.throws(() => resolveWorkspacePath("../tenant-a"), /workspace id/i);
    assert.throws(() => resolveWorkspacePath(path.join(root, "tenant-a")), /workspace id/i);
    assert.throws(() => resolveWorkspacePath("%252e%252e"), /workspace id/i);
    assert.throws(() => safeWorkspacePath(path.join(root, "tenant-a"), "../outside"), /outside/i);
    assert.throws(
      () => safeWorkspacePath(path.join(root, "tenant-a"), "escaped/private.json"),
      /symlink outside/i,
    );
    assert.throws(
      () => safeWorkspacePath(path.join(root, "tenant-a"), "%2e%2e/private.json"),
      /encoded/i,
    );
  } finally {
    if (previousDataRoot === undefined) delete process.env.POLARIS_BUSINESS_DATA_ROOT;
    else process.env.POLARIS_BUSINESS_DATA_ROOT = previousDataRoot;
    if (previousMode === undefined) delete process.env.POLARIS_BUSINESS_RUNTIME_MODE;
    else process.env.POLARIS_BUSINESS_RUNTIME_MODE = previousMode;
    resetRepoRootCachesForTests();
    fs.rmSync(dataRoot, { force: true, recursive: true });
    fs.rmSync(outside, { force: true, recursive: true });
  }
});

test("workspace path helpers reject symlinked module roots", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-core-workspace-paths-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-core-workspace-paths-outside-"));
  try {
    fs.symlinkSync(outside, path.join(workspace, "assets"));
    const paths = new WorkspacePaths(workspace);
    assert.throws(() => paths.productManagementDir, /symlink outside/i);
  } finally {
    fs.rmSync(workspace, { force: true, recursive: true });
    fs.rmSync(outside, { force: true, recursive: true });
  }
});
