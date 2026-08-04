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
  const allowedLines = resolveAllowedVaultLines(input.session.line);
  const hostLine = resolveHostVaultLine(input.host);
  const isRunning = input.host.status?.driver?.status === "running";

  if (hostLine === "coding" && allowedLines.includes("coding") && input.host.serverId && isRunning) {
    actions.push({
      kind: "open-coding",
      href: codingEmbedPath(input.host.serverId),
    });
    return actions;
  }

  if (hostLine === "vertical" && allowedLines.includes("vertical") && input.host.serverId) {
    actions.push({
      kind: "open-wanghai",
      href: planOpenWanghaiPortal(input.host.serverId).shellEmbedPath,
    });
  }

  return actions;
}

function resolveHostVaultLine(host: ShellHostSummary): "coding" | "vertical" {
  if (host.surfaces.some((surface) => surface.trim().toLowerCase() === "wanghai")) {
    return "vertical";
  }
  return "coding";
}
