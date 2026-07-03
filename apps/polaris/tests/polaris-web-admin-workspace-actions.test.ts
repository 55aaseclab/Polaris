import test from "node:test";
import assert from "node:assert/strict";
import { resolveAdminWorkspaceButtonState } from "../../polaris-web/src/lib/admin-workspace-actions";

test("admin workspace buttons disable while creating", () => {
  const state = resolveAdminWorkspaceButtonState({
    backendLiveness: "creating",
    localAction: null,
  });
  assert.equal(state.primaryLabel, "starting");
  assert.equal(state.primaryDisabled, true);
  assert.equal(state.archiveDisabled, true);
});

test("admin workspace buttons disable while starting", () => {
  const state = resolveAdminWorkspaceButtonState({
    backendLiveness: "starting",
    localAction: null,
  });
  assert.equal(state.primaryLabel, "starting");
  assert.equal(state.primaryDisabled, true);
  assert.equal(state.archiveDisabled, true);
});

test("admin workspace buttons disable while stopping", () => {
  const state = resolveAdminWorkspaceButtonState({
    backendLiveness: "stopping",
    localAction: null,
  });
  assert.equal(state.primaryLabel, "stopping");
  assert.equal(state.primaryDisabled, true);
  assert.equal(state.archiveDisabled, true);
});

test("admin workspace buttons disable while archiving", () => {
  const state = resolveAdminWorkspaceButtonState({
    backendLiveness: "archiving",
    localAction: null,
  });
  assert.equal(state.archiveLabel, "deleting");
  assert.equal(state.primaryDisabled, true);
  assert.equal(state.archiveDisabled, true);
});

test("admin workspace buttons stay enabled for stable running state", () => {
  const state = resolveAdminWorkspaceButtonState({
    backendLiveness: "running",
    localAction: null,
  });
  assert.equal(state.primaryLabel, "stop_workspace");
  assert.equal(state.primaryDisabled, false);
  assert.equal(state.archiveDisabled, false);
});

test("admin workspace buttons stay enabled for stable stopped state", () => {
  const state = resolveAdminWorkspaceButtonState({
    backendLiveness: "missing",
    localAction: null,
  });
  assert.equal(state.primaryLabel, "start_workspace");
  assert.equal(state.primaryDisabled, false);
  assert.equal(state.archiveDisabled, false);
});
