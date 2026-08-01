/**
 * Host directory actions for the shell.
 * Coding opens outer paseo-web against an in-container daemon.
 * Wanghai opens the in-container portal URL (never a global host process).
 */

export type HostSurfaceAction = "open-coding" | "open-wanghai-portal";

export interface HostOpenTarget {
  action: HostSurfaceAction;
  /** Path on outer paseo-web, or absolute portal URL for wanghai. */
  href: string;
  kind: "paseo-route" | "wanghai-portal-url";
}

export function buildOpenCodingHref(serverId: string): HostOpenTarget {
  const id = serverId.trim();
  if (!id) {
    throw new Error("serverId is required");
  }
  return {
    action: "open-coding",
    kind: "paseo-route",
    href: `/h/${encodeURIComponent(id)}`,
  };
}

export function buildOpenWanghaiPortalHref(portalBaseUrl: string): HostOpenTarget {
  const href = portalBaseUrl.trim().replace(/\/+$/, "");
  if (!href) {
    throw new Error("portalBaseUrl is required for open-wanghai-portal");
  }
  return {
    action: "open-wanghai-portal",
    kind: "wanghai-portal-url",
    href,
  };
}

/** Shell host APIs used by the directory (paths relative to polaris API /api). */
export const SHELL_HOST_API = {
  listHosts: "/polaris-hosts",
  createHost: "/polaris-hosts",
  hostAction: (name: string) => `/polaris-hosts/${encodeURIComponent(name)}`,
  currentUser: "/polaris-user",
} as const;
