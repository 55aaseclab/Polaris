import test from "node:test";
import assert from "node:assert/strict";
import {
  applyWorkspaceStreamEvent,
  type UserWorkspaceStoreState,
} from "../../polaris-web/src/lib/user-workspace-store";
import type {
  PortalWorkspaceLiveSummary,
  PortalWorkspaceStaticSummary,
} from "../../polaris-web/src/lib/api";

function baseState(): Pick<UserWorkspaceStoreState, "staticWorkspaces" | "liveByWorkspace"> {
  return {
    staticWorkspaces: [],
    liveByWorkspace: {},
  };
}

function staticWorkspace(name: string): PortalWorkspaceStaticSummary {
  return {
    name,
    availableDrivers: [
      { backend: "docker", available: true },
    ],
  };
}

function liveWorkspace(
  name: string,
  status: PortalWorkspaceLiveSummary["status"],
): PortalWorkspaceLiveSummary {
  return {
    name,
    status,
  };
}

test("workspace store snapshot replaces static and live state", () => {
  const next = applyWorkspaceStreamEvent(baseState(), {
    type: "snapshot",
    staticWorkspaces: [staticWorkspace("b"), staticWorkspace("a")],
    liveWorkspaces: [
      liveWorkspace("a", {
        driver: {
          selected: { backend: "docker" },
          status: "running",
        },
        paseo: {
          daemon: "ready",
          web: "connectable",
          reconnectMode: "reconnectable",
          liveTarget: "http://127.0.0.1:6767/h/a",
          reconnectTarget: null,
        },
      }),
    ],
  });

  assert.deepEqual(next.staticWorkspaces.map((workspace) => workspace.name), ["a", "b"]);
  assert.equal(next.liveByWorkspace.a?.status?.driver?.status, "running");
});

test("workspace store applies static and live upserts independently", () => {
  const afterStatic = applyWorkspaceStreamEvent(baseState(), {
    type: "static-upsert",
    workspace: staticWorkspace("demo"),
  });
  const afterLive = applyWorkspaceStreamEvent(afterStatic, {
    type: "live-upsert",
    workspace: liveWorkspace("demo", {
      driver: {
        selected: { backend: "docker" },
        status: "starting",
      },
      paseo: {
        daemon: "pending",
        web: "unavailable",
        reconnectMode: "unknown",
        liveTarget: null,
        reconnectTarget: null,
      },
    }),
  });

  assert.deepEqual(afterLive.staticWorkspaces.map((workspace) => workspace.name), ["demo"]);
  assert.equal(afterLive.liveByWorkspace.demo?.status?.driver?.status, "starting");
});

test("workspace store removes static and live state together when a workspace disappears", () => {
  const current = {
    staticWorkspaces: [staticWorkspace("demo")],
    liveByWorkspace: {
      demo: liveWorkspace("demo", {
        driver: {
          selected: { backend: "docker" },
          status: "running",
        },
        paseo: {
          daemon: "ready",
          web: "connectable",
          reconnectMode: "reconnectable",
          liveTarget: "http://127.0.0.1:6767/h/demo",
          reconnectTarget: null,
        },
      }),
    },
  };

  const next = applyWorkspaceStreamEvent(current, {
    type: "static-remove",
    workspace: "demo",
  });

  assert.deepEqual(next.staticWorkspaces, []);
  assert.equal(next.liveByWorkspace.demo, undefined);
});
