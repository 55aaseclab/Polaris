import test from "node:test";
import assert from "node:assert/strict";
import { resolveWorkspaceRouteScope } from "../../polaris-web/src/lib/admin-scoped-workspace-route";

test("admin scoped workspace detail route keeps scoped workspace links", () => {
  const scope = resolveWorkspaceRouteScope({
    pathname: "/users/cyruscyliu/admin/users/test/workspaces/test",
    userId: "cyruscyliu",
    targetUserId: "test",
    workspaceName: "test",
  });

  assert.equal(scope.adminScopedWorkspaceView, true);
  assert.equal(scope.activeUserId, "test");
  assert.equal(scope.currentWorkspaceName, "test");
  assert.equal(scope.currentWorkspacePane, "");
  assert.equal(
    scope.workspaceIndexLink(),
    "/users/cyruscyliu/admin/users/test/workspaces",
  );
  assert.equal(
    scope.workspaceLink("test"),
    "/users/cyruscyliu/admin/users/test/workspaces/test",
  );
  assert.notEqual(
    scope.workspaceLink("test"),
    "/users/test/workspaces/test",
  );
});

test("admin scoped workspace pane route keeps pane inside scoped route", () => {
  const scope = resolveWorkspaceRouteScope({
    pathname: "/users/cyruscyliu/admin/users/test/workspaces/test/paseo",
    userId: "cyruscyliu",
    targetUserId: "test",
    workspaceName: "test",
  });

  assert.equal(scope.currentWorkspacePane, "paseo");
  assert.equal(
    scope.workspaceLink("test"),
    "/users/cyruscyliu/admin/users/test/workspaces/test",
  );
});
