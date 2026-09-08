import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  defaultWorkspaceShellLayoutPrefs,
  readSelectedWorkspace,
  readWorkspaceShellLayoutPrefs,
  resolveInitialWorkspaceSelection,
  workspaceShellLayoutMountKey,
  workspaceShellStorage,
  workspaceShellLayoutGroupId,
  writeSelectedWorkspace,
  writeWorkspaceShellLayoutPrefs,
} from "../lib/workspace-layout-memory.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

test("workspaceShellLayoutGroupId scopes layouts by workspace and group", () => {
  assert.equal(
    workspaceShellLayoutGroupId("demo-workspace", "outer"),
    "wanghai.admin.workspace-shell:demo-workspace:outer",
  );
  assert.equal(
    workspaceShellLayoutGroupId("demo-workspace", "workflow-sidebar"),
    "wanghai.admin.workspace-shell:demo-workspace:workflow-sidebar",
  );
});

test("workspaceShellLayoutMountKey scopes remount keys by workspace, group, and panel set", () => {
  assert.equal(
    workspaceShellLayoutMountKey("demo-workspace", "outer", ["asset-sidebar", "main-pane"]),
    "wanghai.admin.workspace-shell:demo-workspace:outer:asset-sidebar,main-pane",
  );
  assert.equal(
    workspaceShellLayoutMountKey(
      "demo-workspace",
      "outer",
      ["asset-sidebar", "main-pane", "paseo-right-sidebar"],
    ),
    "wanghai.admin.workspace-shell:demo-workspace:outer:asset-sidebar,main-pane,paseo-right-sidebar",
  );
});

test("readWorkspaceShellLayoutPrefs falls back to defaults", () => {
  assert.deepEqual(
    readWorkspaceShellLayoutPrefs("demo-workspace", memoryStorage()),
    defaultWorkspaceShellLayoutPrefs(),
  );
});

test("writeWorkspaceShellLayoutPrefs round-trips valid values", () => {
  const storage = memoryStorage();
  writeWorkspaceShellLayoutPrefs(
    "demo-workspace",
    {
      lastContentSidebarTab: "assets",
      leftSidebarTab: "paseo",
      rightPaseoOpen: true,
    },
    storage,
  );

  assert.deepEqual(
    readWorkspaceShellLayoutPrefs("demo-workspace", storage),
    {
      lastContentSidebarTab: "assets",
      leftSidebarTab: "paseo",
      rightPaseoOpen: true,
    },
  );
});

test("readWorkspaceShellLayoutPrefs ignores invalid stored values", () => {
  const storage = memoryStorage({
    "wanghai.admin.workspace-shell:demo-workspace:prefs": JSON.stringify({
      lastContentSidebarTab: "invalid",
      leftSidebarTab: "invalid",
      rightPaseoOpen: "invalid",
    }),
  });

  assert.deepEqual(
    readWorkspaceShellLayoutPrefs("demo-workspace", storage),
    defaultWorkspaceShellLayoutPrefs(),
  );
});

test("workspaceShellStorage falls back to noop storage outside the browser", () => {
  const storage = workspaceShellStorage();
  assert.equal(storage.getItem("missing"), null);
  assert.doesNotThrow(() => {
    storage.setItem("demo", "value");
  });
});

test("resolveInitialWorkspaceSelection prefers request, then stored value, then first available", () => {
  assert.equal(
    resolveInitialWorkspaceSelection({
      availableWorkspaces: ["songjin", "test-vertical"],
      requestedWorkspace: "test-vertical",
      storedWorkspace: "songjin",
    }),
    "test-vertical",
  );
  assert.equal(
    resolveInitialWorkspaceSelection({
      availableWorkspaces: ["songjin", "test-vertical"],
      requestedWorkspace: "missing",
      storedWorkspace: "test-vertical",
    }),
    "test-vertical",
  );
  assert.equal(
    resolveInitialWorkspaceSelection({
      availableWorkspaces: ["songjin", "test-vertical"],
      requestedWorkspace: "missing",
      storedWorkspace: "missing",
    }),
    "songjin",
  );
});

test("selected workspace storage round-trips", () => {
  const storage = memoryStorage();
  writeSelectedWorkspace("test-vertical", storage);
  assert.equal(readSelectedWorkspace(storage), "test-vertical");
});

test("workspace shell binds resizable groups to workspace-specific mount keys", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../components/workspace-shell.tsx", import.meta.url)),
    "utf8",
  );

  assert.match(
    source,
    /key=\{workspaceShellLayoutMountKey\(workspace, "outer", outerPanelIds\)\}/,
  );
  assert.match(
    source,
    /key=\{workspaceShellLayoutMountKey\(workspace, "workflow-sidebar", workflowSidebarPanelIds\)\}/,
  );
  assert.match(source, /id=\{outerLayoutGroupId\}/);
  assert.match(source, /id=\{workflowSidebarLayoutGroupId\}/);
});
