/**
 * Outer shell routes (paseo-web host process).
 * Auth, user management, host directory — not IDE panes.
 */

export const SHELL_ROUTE_PREFIXES = [
  "/welcome",
  "/auth",
  "/settings/user",
  "/hosts",
] as const;

export type ShellRouteId =
  | "home"
  | "welcome"
  | "auth-callback"
  | "settings-user"
  | "hosts"
  | "host-detail";

export function shellPath(id: ShellRouteId, params?: { hostKey?: string }): string {
  switch (id) {
    case "home":
      return "/";
    case "welcome":
      return "/welcome";
    case "auth-callback":
      return "/auth/callback";
    case "settings-user":
      return "/settings/user";
    case "hosts":
      return "/hosts";
    case "host-detail": {
      const hostKey = params?.hostKey?.trim();
      if (!hostKey) {
        throw new Error("shellPath(host-detail) requires hostKey");
      }
      return `/hosts/${encodeURIComponent(hostKey)}`;
    }
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
  if (path === "/settings" || path === "/settings/") {
    // Settings root is shared chrome; user page is shell, host IDE settings are not.
    return true;
  }
  if (path === "/settings/user" || path.startsWith("/settings/user/")) {
    return true;
  }
  if (path === "/welcome" || path.startsWith("/welcome/")) {
    return true;
  }
  if (path === "/auth" || path.startsWith("/auth/")) {
    return true;
  }
  if (path === "/hosts" || path.startsWith("/hosts/")) {
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
