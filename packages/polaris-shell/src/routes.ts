/**
 * Outer shell routes (paseo-web host process).
 * The workspace, workflow settings and host directory.
 */

export const SHELL_ROUTE_PREFIXES = [
  "/work",
  "/setup",
  "/settings/workflows",
  "/settings/tools",
  "/hosts",
] as const;

export type ShellRouteId =
  | "home"
  | "hosts";

export const WANGHAI_EMBED_ROUTE_PREFIX = "/v" as const;

export function codingEmbedPath(serverId: string): string {
  const trimmed = serverId.trim();
  if (!trimmed) {
    throw new Error("codingEmbedPath requires serverId");
  }
  return `${WANGHAI_EMBED_ROUTE_PREFIX}/${encodeURIComponent(trimmed)}/coding`;
}

export function wanghaiEmbedPath(serverId: string): string {
  const trimmed = serverId.trim();
  if (!trimmed) {
    throw new Error("wanghaiEmbedPath requires serverId");
  }
  return `${WANGHAI_EMBED_ROUTE_PREFIX}/${encodeURIComponent(trimmed)}/wanghai`;
}

export function shellPath(id: ShellRouteId): string {
  switch (id) {
    case "home":
      return "/";
    case "hosts":
      return "/hosts";
    default: {
      const _exhaustive: never = id;
      return _exhaustive;
    }
  }
}

/** True when pathname is owned by polaris-shell (not paseo/wanghai surfaces). */
export function isShellPath(pathname: string): boolean {
  const path = normalizePath(pathname);
  if (path === "/" || path === "") {
    return true;
  }
  if (path === "/work" || path.startsWith("/work/")) {
    return true;
  }
  if (path === "/setup" || path.startsWith("/setup/")) {
    return true;
  }
  if (path === "/settings" || path === "/settings/") {
    // Host IDE settings use surface routes.
    return true;
  }
  if (path === "/settings/workflows" || path.startsWith("/settings/workflows/")) {
    return true;
  }
  if (path === "/settings/tools" || path.startsWith("/settings/tools/")) {
    return true;
  }
  if (path === "/hosts" || path.startsWith("/hosts/")) {
    return true;
  }
  if (path === "/debug" || path.startsWith("/debug/")) {
    return true;
  }
  if (path === "/v" || path.startsWith("/v/")) {
    return true;
  }
  return false;
}

function normalizePath(pathname: string): string {
  const raw = pathname.trim() || "/";
  if (raw.length > 1 && raw.endsWith("/")) {
    return raw.slice(0, -1);
  }
  return raw;
}
