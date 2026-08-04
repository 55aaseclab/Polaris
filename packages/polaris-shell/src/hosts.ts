import { codingEmbedPath } from "./routes.js";

/**
 * Host directory actions for the shell.
 * Coding opens a shell-owned surface that embeds outer paseo-web against an
 * in-container daemon.
 * Wanghai opens the shell-owned authenticated gateway route.
 */

export type HostSurfaceAction = "open-coding" | "open-wanghai-portal";

export interface HostOpenTarget {
  action: HostSurfaceAction;
  /** Path on polaris-shell. */
  href: string;
  kind: "shell-route";
}

export function buildOpenCodingHref(serverId: string): HostOpenTarget {
  const id = serverId.trim();
  if (!id) {
    throw new Error("serverId is required");
  }
  return {
    action: "open-coding",
    kind: "shell-route",
    href: codingEmbedPath(id),
  };
}

export function buildOpenWanghaiPortalHref(serverId: string): HostOpenTarget {
  const id = serverId.trim();
  if (!id) {
    throw new Error("serverId is required for open-wanghai-portal");
  }
  return {
    action: "open-wanghai-portal",
    kind: "shell-route",
    href: `/v/${encodeURIComponent(id)}/wanghai`,
  };
}

/** Shell host APIs used by the directory (paths relative to polaris API /api). */
export const SHELL_HOST_API = {
  listHosts: "/polaris-hosts",
  createHost: "/polaris-hosts",
  hostAction: (name: string) => `/polaris-hosts/${encodeURIComponent(name)}`,
  launchWanghai: (serverId: string) => `/wanghai/${encodeURIComponent(serverId)}/launch`,
  currentUser: "/polaris-user",
} as const;
