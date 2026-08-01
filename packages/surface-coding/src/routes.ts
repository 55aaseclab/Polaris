/**
 * Paseo coding surface routes — left/right IDE after a host is selected.
 * Outer paseo-web process; talks to in-container paseo daemon.
 */

export const PASEO_SURFACE_ROUTE_PREFIX = "/h" as const;

export type PaseoSurfaceRouteId =
  | "host-root"
  | "workspace"
  | "agent"
  | "open-project"
  | "sessions"
  | "new"
  | "host-settings";

export function isPaseoSurfacePath(pathname: string): boolean {
  const path = normalizePath(pathname);
  return path === "/h" || path.startsWith("/h/");
}

export function paseoSurfacePath(
  id: PaseoSurfaceRouteId,
  params: { serverId: string; workspaceId?: string; agentId?: string },
): string {
  const serverId = requireId(params.serverId, "serverId");
  const base = `/h/${encodeURIComponent(serverId)}`;
  switch (id) {
    case "host-root":
      return base;
    case "workspace": {
      const workspaceId = requireId(params.workspaceId, "workspaceId");
      return `${base}/workspace/${encodeURIComponent(workspaceId)}`;
    }
    case "agent": {
      const agentId = requireId(params.agentId, "agentId");
      return `${base}/agent/${encodeURIComponent(agentId)}`;
    }
    case "open-project":
      return `${base}/open-project`;
    case "sessions":
      return `${base}/sessions`;
    case "new":
      return `${base}/new`;
    case "host-settings":
      return `${base}/settings`;
    default: {
      const _exhaustive: never = id;
      return _exhaustive;
    }
  }
}

/**
 * Paths that still live under the Paseo app tree today but belong to shell.
 * Use when stripping shell routes out of the Expo app.
 */
export const PASEO_APP_SHELL_ROUTES_TO_REMOVE = [
  "/",
  "/auth/callback",
  "/settings",
  "/settings/user",
  "/hosts",
  "/v",
] as const;

function requireId(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function normalizePath(pathname: string): string {
  const raw = pathname.trim() || "/";
  if (raw.length > 1 && raw.endsWith("/")) {
    return raw.slice(0, -1);
  }
  return raw;
}
