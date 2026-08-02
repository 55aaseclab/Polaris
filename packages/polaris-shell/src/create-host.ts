import { paseoSurfacePath } from "@qingniao/surface-paseo";
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
}): string {
  const href = input.href.trim();
  if (!href) {
    throw new Error("href is required");
  }
  const shellCodingMatch = href.match(/^\/v\/([^/]+)\/coding$/);
  const targetHref = shellCodingMatch
    ? paseoSurfacePath("host-root", { serverId: decodeURIComponent(shellCodingMatch[1] ?? "") })
    : href;
  const baseUrl = input.paseoAppBaseUrl?.trim() || input.currentOrigin.trim();
  if (!baseUrl) {
    throw new Error("a base URL is required");
  }
  return new URL(targetHref, baseUrl).toString();
}
