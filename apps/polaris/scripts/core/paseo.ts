export interface PaseoDaemonStatusSnapshot {
  serverId: string;
  localDaemon: string;
  connectedDaemon: string;
}

export function evaluateDaemonStatusObservation(args: {
  status: PaseoDaemonStatusSnapshot | null;
  persistedServerId: string | null;
  readyFileDetail: string;
}): { observed: boolean; detail: string } {
  const { status, persistedServerId, readyFileDetail } = args;
  if (!status) {
    return {
      observed: false,
      detail: `${readyFileDetail} (daemon status unavailable)`,
    };
  }
  if (status.localDaemon !== "running" || status.connectedDaemon !== "reachable") {
    return {
      observed: false,
      detail: `${readyFileDetail} (daemon status ${status.localDaemon}/${status.connectedDaemon})`,
    };
  }
  if (!persistedServerId) {
    return {
      observed: false,
      detail: `${readyFileDetail} (persisted server-id missing)`,
    };
  }
  if (status.serverId !== persistedServerId) {
    return {
      observed: false,
      detail: `${readyFileDetail} (daemon serverId ${status.serverId} != persisted server-id ${persistedServerId})`,
    };
  }
  return {
    observed: true,
    detail: `daemon status ok (${status.serverId})`,
  };
}

function decodeBase64Url(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const base64 = trimmed.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export function parsePaseoDaemonStatus(raw: string): PaseoDaemonStatusSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const serverId = typeof parsed.serverId === "string" ? parsed.serverId.trim() : "";
    const localDaemon = typeof parsed.localDaemon === "string" ? parsed.localDaemon.trim() : "";
    const connectedDaemon = typeof parsed.connectedDaemon === "string"
      ? parsed.connectedDaemon.trim()
      : "";
    if (!serverId || !localDaemon || !connectedDaemon) {
      return null;
    }
    return { serverId, localDaemon, connectedDaemon };
  } catch {
    return null;
  }
}

export function parseConnectionOfferServerId(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  const fragment = "#offer=";
  const index = trimmed.indexOf(fragment);
  if (index === -1) {
    return undefined;
  }
  const encoded = trimmed.slice(index + fragment.length).trim();
  const decoded = decodeBase64Url(encoded);
  if (!decoded) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(decoded) as { serverId?: unknown };
    return typeof parsed.serverId === "string" && parsed.serverId.trim()
      ? parsed.serverId.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

export function evaluatePairingObservation(args: {
  expectedServerId: string | null;
  cachedServerId: string | null;
  pairingUrl?: string;
  pairingFileDetail: string;
}): { observed: boolean; detail: string; url?: string } {
  const { expectedServerId, cachedServerId, pairingUrl, pairingFileDetail } = args;
  if (!expectedServerId) {
    return {
      observed: false,
      detail: `${pairingFileDetail} (missing daemon serverId)`,
      ...(pairingUrl ? { url: pairingUrl } : {}),
    };
  }
  if (!cachedServerId) {
    return {
      observed: false,
      detail: `${pairingFileDetail} (pairing offer serverId missing)`,
      ...(pairingUrl ? { url: pairingUrl } : {}),
    };
  }
  if (cachedServerId !== expectedServerId) {
    return {
      observed: false,
      detail: `${pairingFileDetail} (pairing serverId ${cachedServerId} != daemon serverId ${expectedServerId})`,
      ...(pairingUrl ? { url: pairingUrl } : {}),
    };
  }
  return {
    observed: true,
    detail: pairingFileDetail,
    ...(pairingUrl ? { url: pairingUrl } : {}),
  };
}
