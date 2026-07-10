import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeWorkspaceStaticAndLive,
  resolveWorkspaceDetailDriverState,
} from "../../polaris-web/src/lib/workspace-view-state";
import type {
  PortalWorkspaceLiveSummary,
  PortalWorkspaceStaticSummary,
} from "../../polaris-web/src/lib/api";

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

test("mergeWorkspaceStaticAndLive keeps sidebar inventory static-driven", () => {
  const merged = mergeWorkspaceStaticAndLive(
    [staticWorkspace("visible")],
    {
      visible: liveWorkspace("visible", {
        driver: {
          selected: { backend: "docker" },
          status: "running",
        },
        paseo: {
          daemon: "ready",
          web: "connectable",
          reconnectMode: "reconnectable",
          liveTarget: "http://127.0.0.1:6767/h/visible",
          reconnectTarget: null,
        },
      }),
      hidden: liveWorkspace("hidden", {
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
    },
  );

  assert.deepEqual(merged.map((workspace) => workspace.name), ["visible"]);
  assert.equal(merged[0]?.status?.driver?.status, "running");
});

test("resolveWorkspaceDetailDriverState does not fake starting before live status arrives", () => {
  const state = resolveWorkspaceDetailDriverState({
    driverStatus: null,
    requestPending: "start",
  });

  assert.equal(state.running, false);
  assert.equal(state.starting, false);
  assert.equal(state.stopping, false);
  assert.equal(state.deleting, false);
  assert.equal(state.transitionActive, false);
  assert.equal(state.actionLocked, true);
});

test("resolveWorkspaceDetailDriverState reflects live stopping and deleting states directly", () => {
  const stopping = resolveWorkspaceDetailDriverState({
    driverStatus: "stopping",
    requestPending: null,
  });
  const deleting = resolveWorkspaceDetailDriverState({
    driverStatus: "archiving",
    requestPending: null,
  });

  assert.equal(stopping.stopping, true);
  assert.equal(stopping.actionLocked, true);
  assert.equal(deleting.deleting, true);
  assert.equal(deleting.actionLocked, true);
});
