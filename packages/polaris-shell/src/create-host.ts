import { paseoSurfacePath } from "@polaris/surface-paseo";
import { codingEmbedPath, wanghaiEmbedPath } from "./routes.js";
import type { PolarisVaultLine } from "./product.js";

export const DEFAULT_POLARIS_VAULT_PATH = "/root/vault";

export const HOST_NAME_VALIDATION_MESSAGE =
  "名称需为 1–63 位小写字母、数字或连字符，并且包含字母";

const HOST_NAME_PATTERN =
  /^(?=.{1,63}$)(?=.*[a-z])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

export function isValidPolarisHostName(value: string): boolean {
  return HOST_NAME_PATTERN.test(value.trim());
}

export function validatePolarisHostName(value: string): {
  hostName: string;
  error: string | null;
} {
  const hostName = value.trim();
  if (!hostName) {
    return { hostName, error: null };
  }
  return {
    hostName,
    error: isValidPolarisHostName(hostName) ? null : HOST_NAME_VALIDATION_MESSAGE,
  };
}

export function buildCreatedHostSurfaceHref(
  serverId: string,
  line: PolarisVaultLine,
): string {
  const id = serverId.trim();
  if (!id) {
    throw new Error("serverId is required");
  }
  if (line === "vertical") {
    return wanghaiEmbedPath(id);
  }
  return codingEmbedPath(id);
}

export function resolveCodingSurfaceUrl(input: {
  href: string;
  paseoAppBaseUrl?: string | null;
  currentOrigin: string;
  reconnectTarget?: string | null;
}): string {
  const href = input.href.trim();
  if (!href) {
    throw new Error("href is required");
  }
  const shellCodingMatch = href.match(/^\/v\/([^/]+)\/coding$/);
  const serverId = shellCodingMatch
    ? decodeURIComponent(shellCodingMatch[1] ?? "")
    : "";
  const targetHref = shellCodingMatch
    ? paseoSurfacePath("host-root", { serverId })
    : href;
  const baseUrl = input.paseoAppBaseUrl?.trim() || input.currentOrigin.trim();
  if (!baseUrl) {
    throw new Error("a base URL is required");
  }
  const reconnectTarget = serverId
    ? resolveReconnectCodingSurfaceTarget({
        serverId,
        reconnectTarget: input.reconnectTarget,
        paseoAppBaseUrl: input.paseoAppBaseUrl,
        currentOrigin: input.currentOrigin,
      })
    : null;
  if (reconnectTarget) {
    return reconnectTarget;
  }
  return new URL(targetHref, baseUrl).toString();
}

function resolveReconnectCodingSurfaceTarget(input: {
  serverId: string;
  reconnectTarget?: string | null;
  paseoAppBaseUrl?: string | null;
  currentOrigin: string;
}): string | null {
  const reconnectTarget = input.reconnectTarget?.trim() || "";
  if (!reconnectTarget) {
    return null;
  }
  const reconnectUrl = safeUrl(reconnectTarget, input.currentOrigin.trim());
  if (!reconnectUrl) {
    return null;
  }
  const baseUrl = selectReconnectSurfaceBaseUrl({
    paseoAppBaseUrl: input.paseoAppBaseUrl,
    currentOrigin: input.currentOrigin,
  });
  const targetUrl = new URL(
    paseoSurfacePath("host-root", { serverId: input.serverId }),
    baseUrl,
  );
  targetUrl.search = reconnectUrl.search;
  targetUrl.hash = reconnectUrl.hash;
  return targetUrl.toString();
}

function selectReconnectSurfaceBaseUrl(input: {
  paseoAppBaseUrl?: string | null;
  currentOrigin: string;
}): string {
  const currentOrigin = input.currentOrigin.trim();
  const configured = input.paseoAppBaseUrl?.trim() || "";
  const currentUrl = safeUrl(currentOrigin);
  const configuredUrl = safeUrl(configured);
  if (!configuredUrl || !currentUrl) {
    return currentOrigin;
  }
  const configuredPath = configuredUrl.pathname.replace(/\/+$/, "") || "/";
  if (configuredPath !== "/") {
    return currentOrigin;
  }
  if (
    configuredUrl.protocol === currentUrl.protocol
    && configuredUrl.hostname === currentUrl.hostname
  ) {
    return configuredUrl.toString();
  }
  return currentOrigin;
}

function safeUrl(value: string, base?: string): URL | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return base ? new URL(trimmed, base) : new URL(trimmed);
  } catch {
    return null;
  }
}
