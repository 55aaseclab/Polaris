/**
 * Wanghai vertical surface helpers.
 * This package owns only the shell entry route. Polaris owns vault lookup,
 * authorization, and private runtime target resolution.
 */

export interface WanghaiOpenPlan {
  /** Outer shell path for the thin embed wrapper. */
  shellEmbedPath: string;
}

export function planOpenWanghaiPortal(serverId: string): WanghaiOpenPlan {
  const normalizedServerId = serverId.trim();
  if (!normalizedServerId) {
    throw new Error("serverId is required");
  }
  return {
    shellEmbedPath: `/v/${encodeURIComponent(normalizedServerId)}/wanghai`,
  };
}

export function isWanghaiPortalEmbedPath(pathname: string): boolean {
  return /^\/v\/[^/]+\/wanghai\/?$/u.test(pathname.trim());
}
