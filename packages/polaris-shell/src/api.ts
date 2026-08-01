import {
  planOpenWanghaiPortal,
  resolveWanghaiPortalUrl,
  type WorkspaceServicePort,
} from "@qingniao/surface-wanghai";
import { codingEmbedPath } from "./routes.js";
import {
  resolveAllowedWorkspaceLines,
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

/** Workspace projection consumed by the shell host directory. */
export interface ShellHostSummary {
  name: string;
  /** Available after the in-container Paseo daemon has paired. */
  serverId: string | null;
  surfaces: readonly string[];
  ports: readonly WorkspaceServicePort[];
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
      portalUrl: string;
    };

/**
 * Resolve the actions a host card may expose for the current user's product.
 * The subscription line is authoritative; a legacy workspace never enables a
 * vertical portal for a coding subscriber by itself.
 */
export function resolveShellHostActions(input: {
  session: Pick<ShellSession, "line" | "plan">;
  host: ShellHostSummary;
  publicHost: string;
}): ShellHostSurfaceAction[] {
  const actions: ShellHostSurfaceAction[] = [];
  const allowedLines = resolveAllowedWorkspaceLines(input.session.line);
  const hostLine = resolveHostWorkspaceLine(input.host);
  const isRunning = input.host.status?.driver?.status === "running";

  if (hostLine === "coding" && allowedLines.includes("coding") && input.host.serverId && isRunning) {
    actions.push({
      kind: "open-coding",
      href: codingEmbedPath(input.host.serverId),
    });
    return actions;
  }

  const portalUrl = resolveHostWanghaiPortalUrl({
    host: input.host,
    publicHost: input.publicHost,
  });
  if (hostLine === "vertical" && allowedLines.includes("vertical") && portalUrl && input.host.serverId) {
    actions.push({
      kind: "open-wanghai",
      href: planOpenWanghaiPortal({
        serverId: input.host.serverId,
        portalUrl,
      }).shellEmbedPath,
      portalUrl,
    });
  }

  return actions;
}

function resolveHostWorkspaceLine(host: ShellHostSummary): "coding" | "vertical" {
  if (host.surfaces.some((surface) => surface.trim().toLowerCase() === "wanghai")) {
    return "vertical";
  }
  return "coding";
}

function resolveHostWanghaiPortalUrl(input: {
  host: ShellHostSummary;
  publicHost: string;
}): string | null {
  if (resolveHostWorkspaceLine(input.host) !== "vertical") {
    return null;
  }
  return resolveWanghaiPortalUrl({
    publicHost: input.publicHost,
    ports: input.host.ports,
  });
}
