export type WorkspaceRouteScope = {
  adminScopedWorkspaceView: boolean;
  managerUserId: string;
  activeUserId: string;
  currentWorkspaceName: string;
  currentWorkspacePane: string;
  isWorkspaceRoute: boolean;
  workspaceLink: (workspaceName: string) => string;
  workspaceIndexLink: () => string;
};

export function resolveWorkspaceRouteScope(input: {
  pathname: string;
  userId?: string | null;
  targetUserId?: string | null;
  workspaceName?: string | null;
}): WorkspaceRouteScope {
  const managerUserId = String(input.userId ?? "").trim();
  const targetUserId = String(input.targetUserId ?? "").trim();
  const adminScopedWorkspaceView = Boolean(targetUserId);
  const activeUserId = targetUserId || managerUserId;
  const currentWorkspaceName = String(input.workspaceName ?? "").trim();
  const pathParts = input.pathname.split("/").filter(Boolean);
  const workspaceSegmentIndex = pathParts.indexOf("workspaces");
  const isWorkspaceRoute = pathParts[0] === "users" && workspaceSegmentIndex !== -1;
  const trailingSegment = pathParts[pathParts.length - 1] ?? "";
  const currentWorkspacePane =
    isWorkspaceRoute && currentWorkspaceName && trailingSegment !== currentWorkspaceName
      ? trailingSegment
      : "";

  function workspaceLink(workspaceName: string): string {
    if (adminScopedWorkspaceView) {
      return `/users/${encodeURIComponent(managerUserId)}/admin/users/${encodeURIComponent(activeUserId)}/workspaces/${encodeURIComponent(workspaceName)}`;
    }
    return `/users/${encodeURIComponent(activeUserId)}/workspaces/${encodeURIComponent(workspaceName)}`;
  }

  function workspaceIndexLink(): string {
    if (adminScopedWorkspaceView) {
      return `/users/${encodeURIComponent(managerUserId)}/admin/users/${encodeURIComponent(activeUserId)}/workspaces`;
    }
    return `/users/${encodeURIComponent(activeUserId)}/workspaces`;
  }

  return {
    adminScopedWorkspaceView,
    managerUserId,
    activeUserId,
    currentWorkspaceName,
    currentWorkspacePane,
    isWorkspaceRoute,
    workspaceLink,
    workspaceIndexLink,
  };
}
