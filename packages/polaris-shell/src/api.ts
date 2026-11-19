import { planOpenWanghaiPortal } from "@polaris/surface-wanghai";
import {
  resolveAllowedVaultLines,
} from "./product.js";

export const PASEO_WEB_URL = "https://app.paseo.sh/";

/** Workspace settings returned by Polaris `/api/workspace`. */
export interface ShellWorkspace {
  workspaceId: string;
  vaultMode: "host" | "vault";
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
 * Resolve the actions a host card may expose for the configured workspace product line.
 * Only configured product lines expose launch actions.
 */
export function resolveShellHostActions(input: {
  workspace: Pick<ShellWorkspace, "line">;
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
  workspace: Pick<ShellWorkspace, "line">;
  host: ShellHostSummary;
}): ShellHostSurfaceAction | null {
  const allowedLines = resolveAllowedVaultLines(input.workspace.line);
  const hostLine = resolveHostVaultLine(input.host);
  const serverId = input.host.serverId?.trim();
  if (hostLine !== "coding" || !allowedLines.includes("coding") || !serverId) {
    return null;
  }
  return {
    kind: "open-coding",
    href: PASEO_WEB_URL,
  };
}

export function resolveWanghaiPortalAction(input: {
  workspace: Pick<ShellWorkspace, "line">;
  host: ShellHostSummary;
}): ShellHostSurfaceAction | null {
  const allowedLines = resolveAllowedVaultLines(input.workspace.line);
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
