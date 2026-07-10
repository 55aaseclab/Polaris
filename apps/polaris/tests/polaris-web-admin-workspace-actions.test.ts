import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveAdminWorkspaceButtonState,
  resolveAdminWorkspaceDisplayState,
  shouldClearAdminWorkspaceAction,
} from "../../polaris-web/src/lib/admin-workspace-actions";

test("admin workspace buttons disable while creating", () => {
  const state = resolveAdminWorkspaceButtonState({
    runtimeLifecycle: "stopped",
    driverStatus: "creating",
    localAction: null,
  });
  assert.equal(state.primaryLabel, "starting");
  assert.equal(state.primaryDisabled, true);
  assert.equal(state.archiveDisabled, true);
});

test("admin workspace buttons disable while starting", () => {
  const state = resolveAdminWorkspaceButtonState({
    runtimeLifecycle: "stopped",
    driverStatus: "starting",
    localAction: null,
  });
  assert.equal(state.primaryLabel, "starting");
  assert.equal(state.primaryDisabled, true);
  assert.equal(state.archiveDisabled, true);
});

test("admin workspace buttons disable while stopping", () => {
  const state = resolveAdminWorkspaceButtonState({
    runtimeLifecycle: "running",
    driverStatus: "stopping",
    localAction: null,
  });
  assert.equal(state.primaryLabel, "stopping");
  assert.equal(state.primaryDisabled, true);
  assert.equal(state.archiveDisabled, true);
});

test("admin workspace buttons disable while archiving", () => {
  const state = resolveAdminWorkspaceButtonState({
    runtimeLifecycle: "stopped",
    driverStatus: "archiving",
    localAction: null,
  });
  assert.equal(state.archiveLabel, "deleting");
  assert.equal(state.primaryDisabled, true);
  assert.equal(state.archiveDisabled, true);
});

test("admin workspace buttons stay enabled for stable running state", () => {
  const state = resolveAdminWorkspaceButtonState({
    runtimeLifecycle: "running",
    driverStatus: null,
    localAction: null,
  });
  assert.equal(state.primaryLabel, "stop_workspace");
  assert.equal(state.primaryDisabled, false);
  assert.equal(state.archiveDisabled, false);
});

test("admin workspace buttons stay enabled for stable stopped state", () => {
  const state = resolveAdminWorkspaceButtonState({
    runtimeLifecycle: "stopped",
    driverStatus: null,
    localAction: null,
  });
  assert.equal(state.primaryLabel, "start_workspace");
  assert.equal(state.primaryDisabled, false);
  assert.equal(state.archiveDisabled, false);
});

test("admin workspace stop action stays latched until queried state enters stopping", () => {
  assert.equal(
    shouldClearAdminWorkspaceAction({
      localAction: "stop",
      baselineRuntimeLifecycle: "running",
      runtimeLifecycle: "running",
      driverStatus: null,
      workspaceExists: true,
    }),
    false,
  );
  assert.equal(
    shouldClearAdminWorkspaceAction({
      localAction: "stop",
      baselineRuntimeLifecycle: "running",
      runtimeLifecycle: "running",
      driverStatus: "stopping",
      workspaceExists: true,
    }),
    true,
  );
});

test("admin workspace start action stays latched until queried state enters starting", () => {
  assert.equal(
    shouldClearAdminWorkspaceAction({
      localAction: "start",
      baselineRuntimeLifecycle: "stopped",
      runtimeLifecycle: "stopped",
      driverStatus: null,
      workspaceExists: true,
    }),
    false,
  );
  assert.equal(
    shouldClearAdminWorkspaceAction({
      localAction: "start",
      baselineRuntimeLifecycle: "stopped",
      runtimeLifecycle: "stopped",
      driverStatus: "starting",
      workspaceExists: true,
    }),
    true,
  );
});

test("admin workspace rebuild action stays latched until queried state enters starting", () => {
  assert.equal(
    shouldClearAdminWorkspaceAction({
      localAction: "rebuild",
      baselineRuntimeLifecycle: "running",
      runtimeLifecycle: "running",
      driverStatus: null,
      workspaceExists: true,
    }),
    false,
  );
  assert.equal(
    shouldClearAdminWorkspaceAction({
      localAction: "rebuild",
      baselineRuntimeLifecycle: "running",
      runtimeLifecycle: "running",
      driverStatus: "rebuilding",
      workspaceExists: true,
    }),
    true,
  );
});

test("admin workspace archive action stays latched until workspace disappears", () => {
  assert.equal(
    shouldClearAdminWorkspaceAction({
      localAction: "archive",
      baselineRuntimeLifecycle: "stopped",
      runtimeLifecycle: "stopped",
      driverStatus: null,
      workspaceExists: true,
    }),
    false,
  );
  assert.equal(
    shouldClearAdminWorkspaceAction({
      localAction: "archive",
      baselineRuntimeLifecycle: "stopped",
      runtimeLifecycle: null,
      driverStatus: null,
      workspaceExists: false,
    }),
    true,
  );
});

test("admin archived workspace delete action clears when archive disappears", () => {
  assert.equal(
    shouldClearAdminWorkspaceAction({
      localAction: "delete-archive",
      baselineRuntimeLifecycle: null,
      runtimeLifecycle: null,
      driverStatus: null,
      workspaceExists: true,
    }),
    false,
  );
  assert.equal(
    shouldClearAdminWorkspaceAction({
      localAction: "delete-archive",
      baselineRuntimeLifecycle: null,
      runtimeLifecycle: null,
      driverStatus: null,
      workspaceExists: false,
    }),
    true,
  );
});

test("admin display state shows starting and polls for local start action", () => {
  const state = resolveAdminWorkspaceDisplayState({
    driverStatus: null,
    localAction: "start",
  });
  assert.equal(state.statusLabel, null);
  assert.equal(state.shouldPoll, false);
});

test("admin display state shows stopping and polls for local stop action", () => {
  const state = resolveAdminWorkspaceDisplayState({
    driverStatus: null,
    localAction: "stop",
  });
  assert.equal(state.statusLabel, null);
  assert.equal(state.shouldPoll, false);
});

test("admin display state shows starting and polls for rebuild action", () => {
  const state = resolveAdminWorkspaceDisplayState({
    driverStatus: null,
    localAction: "rebuild",
  });
  assert.equal(state.statusLabel, null);
  assert.equal(state.shouldPoll, false);
  assert.equal(state.rebuildLabel, "rebuild_workspace");
});

test("admin display state shows deleting and polls for archive action", () => {
  const state = resolveAdminWorkspaceDisplayState({
    driverStatus: null,
    localAction: "archive",
  });
  assert.equal(state.statusLabel, null);
  assert.equal(state.shouldPoll, false);
});

test("admin display state keeps rebuild label while status operation shows rebuild", () => {
  const state = resolveAdminWorkspaceDisplayState({
    driverStatus: "rebuilding",
    localAction: null,
  });
  assert.equal(state.statusLabel, "workspace_starting");
  assert.equal(state.shouldPoll, false);
  assert.equal(state.rebuildLabel, "rebuilding_workspace");
  assert.equal(state.rebuildDisabled, true);
});

test("admin display state leaves rebuild label idle for ordinary start", () => {
  const state = resolveAdminWorkspaceDisplayState({
    driverStatus: "starting",
    localAction: "start",
  });
  assert.equal(state.statusLabel, "workspace_starting");
  assert.equal(state.shouldPoll, false);
  assert.equal(state.rebuildLabel, "rebuild_workspace");
  assert.equal(state.rebuildDisabled, true);
});

test("admin display state re-enables rebuild only after workspace leaves transitional states", () => {
  const state = resolveAdminWorkspaceDisplayState({
    driverStatus: null,
    localAction: null,
  });
  assert.equal(state.rebuildLabel, "rebuild_workspace");
  assert.equal(state.rebuildDisabled, false);
});

test("admin button label stays live-driven while a start request waits for stream", () => {
  const state = resolveAdminWorkspaceButtonState({
    runtimeLifecycle: "stopped",
    driverStatus: null,
    localAction: "start",
  });
  assert.equal(state.primaryLabel, "start_workspace");
  assert.equal(state.primaryDisabled, true);
});
