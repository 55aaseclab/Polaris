import { paseoSurfacePath } from "@qingniao/surface-paseo";

export const DEFAULT_POLARIS_PROJECT_PATH = "/root/workspace";

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

export function buildCreatedHostSurfaceHref(serverId: string): string {
  const id = serverId.trim();
  if (!id) {
    throw new Error("serverId is required");
  }
  return paseoSurfacePath("host-root", { serverId: id });
}
