/**
 * Wanghai vertical surface helpers.
 * Portal **server** runs inside the vault container on :9090.
 * Outer UI only resolves the mapped URL and serves the embed route.
 */

export const WANGHAI_PORTAL_CONTAINER_PORT = 9090;

export interface VaultServicePort {
  name?: string;
  containerPort: string | number;
  /** Host / node port published by polaris docker/pod backend. */
  nodePort?: string | number | null;
  host?: string | null;
}

export interface ResolveWanghaiPortalUrlInput {
  /** Hostname reachable from the browser (public IP or localhost). */
  publicHost: string;
  ports: readonly VaultServicePort[];
  protocol?: "http" | "https";
}

export function findWanghaiPortalPort(
  ports: readonly VaultServicePort[],
): VaultServicePort | null {
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

export interface WanghaiOpenPlan {
  href: string;
  /** Outer shell path for the thin embed wrapper. */
  shellEmbedPath: string;
}

export function planOpenWanghaiPortal(input: {
  serverId: string;
  portalUrl: string;
}): WanghaiOpenPlan {
  const serverId = input.serverId.trim();
  const href = input.portalUrl.trim();
  if (!serverId || !href) {
    throw new Error("serverId and portalUrl are required");
  }
  return {
    href,
    shellEmbedPath: `/v/${encodeURIComponent(serverId)}/wanghai`,
  };
}

export function isWanghaiPortalEmbedPath(pathname: string): boolean {
  return /^\/v\/[^/]+\/wanghai\/?$/u.test(pathname.trim());
}
