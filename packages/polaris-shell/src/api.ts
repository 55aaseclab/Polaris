import { planOpenWanghaiPortal } from "@polaris/surface-wanghai";
import { codingEmbedPath } from "./routes.js";
import {
  resolveAllowedVaultLines,
} from "./product.js";

/** Session shape returned by Polaris `/api/session`. */
export interface ShellSession {
  authMode: "authing-browser-session" | "oauth2-proxy" | "disabled";
  authenticated: boolean;
  authingUserId: string;
  authingUsername: string | null;
  polarisUserId: string | null;
  role: "admin" | "user" | null;
  plan: "free" | "pro" | null;
  line: "coding" | "vertical" | "both" | null;
}

/** Vault projection consumed by the shell host directory. */
export interface ShellHostSummary {
  name: string;
  /** Available after the in-container Paseo daemon has paired. */
  serverId: string | null;
  /** Stable private Wanghai gateway route identity. */
  wanghaiId: string | null;
  surfaces: readonly string[];
  status: {
    driver?: {
      status?: string;
    };
    paseo?: {
      daemon?: string;
      web?: string;
      reconnectTarget?: string | null;
    };
  } | null;
}

export type ShellHostSurfaceAction =
  | {
      kind: "open-coding";
      href: string;
    }
  | {
      kind: "open-wanghai";
      href: string;
    };

/**
 * Resolve the actions a host card may expose for the current user's product.
 * The subscription line is authoritative; a legacy vault never enables a
 * vertical portal for a coding subscriber by itself.
 */
export function resolveShellHostActions(input: {
  session: Pick<ShellSession, "line" | "plan">;
  host: ShellHostSummary;
}): ShellHostSurfaceAction[] {
  const actions: ShellHostSurfaceAction[] = [];
  const isRunning = input.host.status?.driver?.status === "running";

  const codingAction = resolveCodingHostAction(input);
  if (codingAction && isRunning) {
    actions.push(codingAction);
    return actions;
  }

  const wanghaiAction = resolveWanghaiPortalAction(input);
  if (wanghaiAction && isRunning) {
    actions.push(wanghaiAction);
  }

  return actions;
}

export function resolveCodingHostAction(input: {
  session: Pick<ShellSession, "line" | "plan">;
  host: ShellHostSummary;
}): ShellHostSurfaceAction | null {
  const allowedLines = resolveAllowedVaultLines(input.session.line);
  const hostLine = resolveHostVaultLine(input.host);
  const serverId = input.host.serverId?.trim();
  if (hostLine !== "coding" || !allowedLines.includes("coding") || !serverId) {
    return null;
  }
  return {
    kind: "open-coding",
    href: codingEmbedPath(serverId),
  };
}

export function resolveWanghaiPortalAction(input: {
  session: Pick<ShellSession, "line" | "plan">;
  host: ShellHostSummary;
}): ShellHostSurfaceAction | null {
  const allowedLines = resolveAllowedVaultLines(input.session.line);
  const hostLine = resolveHostVaultLine(input.host);
  const wanghaiId = input.host.wanghaiId?.trim();
  if (hostLine !== "vertical" || !allowedLines.includes("vertical") || !wanghaiId) {
    return null;
  }
  return {
    kind: "open-wanghai",
    href: planOpenWanghaiPortal(wanghaiId).shellEmbedPath,
  };
}

function resolveHostVaultLine(host: ShellHostSummary): "coding" | "vertical" {
  if (host.surfaces.some((surface) => surface.trim().toLowerCase() === "wanghai")) {
    return "vertical";
  }
  return "coding";
}
