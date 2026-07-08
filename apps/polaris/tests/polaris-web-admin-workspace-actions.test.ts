import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveAdminWorkspaceButtonState,
  resolveAdminWorkspaceDisplayState,
  shouldClearAdminWorkspaceAction,
} from "../../polaris-web/src/lib/admin-workspace-actions";

test("admin workspace buttons disable while creating", () => {
  const state = resolveAdminWorkspaceButtonState({
    backendLiveness: "missing",
    operation: "create",
    localAction: null,
  });
  assert.equal(state.primaryLabel, "starting");
  assert.equal(state.primaryDisabled, true);
  assert.equal(state.archiveDisabled, true);
});

test("admin workspace buttons disable while starting", () => {
  const state = resolveAdminWorkspaceButtonState({
    backendLiveness: "missing",
    operation: "start",
    localAction: null,
  });
  assert.equal(state.primaryLabel, "starting");
  assert.equal(state.primaryDisabled, true);
  assert.equal(state.archiveDisabled, true);
});

test("admin workspace buttons disable while stopping", () => {
  const state = resolveAdminWorkspaceButtonState({
    backendLiveness: "running",
    operation: "stop",
    localAction: null,
  });
  assert.equal(state.primaryLabel, "stopping");
  assert.equal(state.primaryDisabled, true);
  assert.equal(state.archiveDisabled, true);
});

test("admin workspace buttons disable while archiving", () => {
  const state = resolveAdminWorkspaceButtonState({
    backendLiveness: "missing",
    operation: "archive",
    localAction: null,
  });
  assert.equal(state.archiveLabel, "deleting");
  assert.equal(state.primaryDisabled, true);
  assert.equal(state.archiveDisabled, true);
});

test("admin workspace buttons stay enabled for stable running state", () => {
  const state = resolveAdminWorkspaceButtonState({
    backendLiveness: "running",
    operation: null,
    localAction: null,
  });
  assert.equal(state.primaryLabel, "stop_workspace");
  assert.equal(state.primaryDisabled, false);
  assert.equal(state.archiveDisabled, false);
});

test("admin workspace buttons stay enabled for stable stopped state", () => {
  const state = resolveAdminWorkspaceButtonState({
    backendLiveness: "missing",
    operation: null,
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
      baselineLiveness: "running",
      backendLiveness: "running",
      operation: null,
      backendReason: "workspace is healthy",
      workspaceExists: true,
    }),
    false,
  );
  assert.equal(
    shouldClearAdminWorkspaceAction({
      localAction: "stop",
      baselineLiveness: "running",
      backendLiveness: "running",
      operation: "stop",
      backendReason: "workspace stop requested",
      workspaceExists: true,
    }),
    true,
  );
});

test("admin workspace start action stays latched until queried state enters starting", () => {
  assert.equal(
    shouldClearAdminWorkspaceAction({
      localAction: "start",
      baselineLiveness: "missing",
      backendLiveness: "missing",
      operation: null,
      backendReason: "workspace is stopped",
      workspaceExists: true,
    }),
    false,
  );
  assert.equal(
    shouldClearAdminWorkspaceAction({
      localAction: "start",
      baselineLiveness: "missing",
      backendLiveness: "missing",
      operation: "start",
      backendReason: "workspace start requested",
      workspaceExists: true,
    }),
    true,
  );
});

test("admin workspace rebuild action stays latched until queried state enters starting", () => {
  assert.equal(
    shouldClearAdminWorkspaceAction({
      localAction: "rebuild",
      baselineLiveness: "running",
      backendLiveness: "running",
      operation: null,
      backendReason: "workspace is healthy",
      workspaceExists: true,
    }),
    false,
  );
  assert.equal(
    shouldClearAdminWorkspaceAction({
      localAction: "rebuild",
      baselineLiveness: "running",
      backendLiveness: "running",
      operation: "rebuild",
      backendReason: "workspace rebuild requested",
      workspaceExists: true,
    }),
    true,
  );
});

test("admin workspace archive action stays latched until workspace disappears", () => {
  assert.equal(
    shouldClearAdminWorkspaceAction({
      localAction: "archive",
      baselineLiveness: "missing",
      backendLiveness: "missing",
      operation: null,
      backendReason: "workspace is stopped",
      workspaceExists: true,
    }),
    false,
  );
  assert.equal(
    shouldClearAdminWorkspaceAction({
      localAction: "archive",
      baselineLiveness: "missing",
      backendLiveness: null,
      operation: null,
      backendReason: null,
      workspaceExists: false,
    }),
    true,
  );
});

test("admin archived workspace delete action clears when archive disappears", () => {
  assert.equal(
    shouldClearAdminWorkspaceAction({
      localAction: "delete-archive",
      baselineLiveness: null,
      backendLiveness: null,
      operation: null,
      backendReason: null,
      workspaceExists: true,
    }),
    false,
  );
  assert.equal(
    shouldClearAdminWorkspaceAction({
      localAction: "delete-archive",
      baselineLiveness: null,
      backendLiveness: null,
      operation: null,
      backendReason: null,
      workspaceExists: false,
    }),
    true,
  );
});

test("admin display state shows starting and polls for local start action", () => {
  const state = resolveAdminWorkspaceDisplayState({
    backendLiveness: "missing",
    operation: null,
    localAction: "start",
  });
  assert.equal(state.statusLabel, "workspace_starting");
  assert.equal(state.shouldPoll, true);
});

test("admin display state shows stopping and polls for local stop action", () => {
  const state = resolveAdminWorkspaceDisplayState({
    backendLiveness: "running",
    operation: null,
    localAction: "stop",
  });
  assert.equal(state.statusLabel, "stopping");
  assert.equal(state.shouldPoll, true);
});

test("admin display state shows starting and polls for rebuild action", () => {
  const state = resolveAdminWorkspaceDisplayState({
    backendLiveness: "running",
    operation: null,
    localAction: "rebuild",
    backendReason: null,
  });
  assert.equal(state.statusLabel, "workspace_starting");
  assert.equal(state.shouldPoll, true);
  assert.equal(state.rebuildLabel, "rebuilding_workspace");
});

test("admin display state shows deleting and polls for archive action", () => {
  const state = resolveAdminWorkspaceDisplayState({
    backendLiveness: "missing",
    operation: null,
    localAction: "archive",
    backendReason: null,
  });
  assert.equal(state.statusLabel, "deleting");
  assert.equal(state.shouldPoll, true);
});

test("admin display state keeps rebuild label while status operation shows rebuild", () => {
  const state = resolveAdminWorkspaceDisplayState({
    backendLiveness: "running",
    operation: "rebuild",
    localAction: null,
    backendReason: "workspace rebuild requested",
  });
  assert.equal(state.statusLabel, "workspace_starting");
  assert.equal(state.shouldPoll, true);
  assert.equal(state.rebuildLabel, "rebuilding_workspace");
  assert.equal(state.rebuildDisabled, true);
});

test("admin display state leaves rebuild label idle for ordinary start", () => {
  const state = resolveAdminWorkspaceDisplayState({
    backendLiveness: "missing",
    operation: "start",
    localAction: "start",
    backendReason: "workspace start requested",
  });
  assert.equal(state.statusLabel, "workspace_starting");
  assert.equal(state.shouldPoll, true);
  assert.equal(state.rebuildLabel, "rebuild_workspace");
  assert.equal(state.rebuildDisabled, true);
});

test("admin display state re-enables rebuild only after workspace leaves transitional states", () => {
  const state = resolveAdminWorkspaceDisplayState({
    backendLiveness: "running",
    operation: null,
    localAction: null,
    backendReason: "workspace is healthy",
  });
  assert.equal(state.rebuildLabel, "rebuild_workspace");
  assert.equal(state.rebuildDisabled, false);
});
