/**
 * Wanghai vertical surface helpers.
 * Portal **server** runs inside the workspace container on :9090.
 * Outer UI only resolves/opens the mapped URL (embed or new tab).
 */

export const WANGHAI_PORTAL_CONTAINER_PORT = 9090;

export interface WorkspaceServicePort {
  name?: string;
  containerPort: string | number;
  /** Host / node port published by polaris docker/pod backend. */
  nodePort?: string | number | null;
  host?: string | null;
}

export interface ResolveWanghaiPortalUrlInput {
  /** Hostname reachable from the browser (public IP or localhost). */
  publicHost: string;
  ports: readonly WorkspaceServicePort[];
  protocol?: "http" | "https";
}

export function findWanghaiPortalPort(
  ports: readonly WorkspaceServicePort[],
): WorkspaceServicePort | null {
  const byName = ports.find((port) => (port.name ?? "").toLowerCase() === "wanghai");
  if (byName) {
    return byName;
  }
  const byContainer = ports.find(
    (port) => String(port.containerPort) === String(WANGHAI_PORTAL_CONTAINER_PORT),
  );
  return byContainer ?? null;
}

export function resolveWanghaiPortalUrl(input: ResolveWanghaiPortalUrlInput): string | null {
  const port = findWanghaiPortalPort(input.ports);
  if (!port) {
    return null;
  }
  const published = port.nodePort ?? port.containerPort;
  const host = (port.host ?? input.publicHost).trim();
  if (!host || published === undefined || published === null || published === "") {
    return null;
  }
  const protocol = input.protocol ?? "http";
  return `${protocol}://${host}:${published}`;
}

export type WanghaiOpenMode = "embed" | "external";

export interface WanghaiOpenPlan {
  mode: WanghaiOpenMode;
  href: string;
  /** Suggested outer shell path for a thin embed wrapper (future). */
  shellEmbedPath: string;
}

export function planOpenWanghaiPortal(input: {
  serverId: string;
  portalUrl: string;
  mode?: WanghaiOpenMode;
}): WanghaiOpenPlan {
  const serverId = input.serverId.trim();
  const href = input.portalUrl.trim();
  if (!serverId || !href) {
    throw new Error("serverId and portalUrl are required");
  }
  const mode = input.mode ?? "external";
  return {
    mode,
    href,
    shellEmbedPath: `/v/${encodeURIComponent(serverId)}/wanghai`,
  };
}
