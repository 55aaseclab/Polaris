import { createHash } from "node:crypto";

const PROJECT_NAME_PATTERN =
  /^(?=.{1,63}$)(?=.*[a-z])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function isValidProjectName(value: string): boolean {
  return PROJECT_NAME_PATTERN.test(value.trim());
}

export function assertValidProjectName(value: string): void {
  if (isValidProjectName(value)) {
    return;
  }
  throw new Error(
    "Vault name must be 1-63 characters, use lowercase letters, numbers, or hyphens, start and end with a letter or number, and include at least one letter.",
  );
}

function sanitizeToken(value: string, fallback: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || fallback;
}

function truncateWithHash(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const hash = createHash("sha1").update(value).digest("hex").slice(0, 8);
  const headLength = Math.max(1, maxLength - hash.length - 1);
  return `${value.slice(0, headLength).replace(/-+$/g, "")}-${hash}`;
}

export function vaultRuntimeScopeName(ownerId: string, projectName: string): string {
  const ownerToken = sanitizeToken(ownerId, "owner");
  const projectToken = sanitizeToken(projectName, "vault");
  return truncateWithHash(`${ownerToken}-${projectToken}`, 63);
}

export function vaultRuntimeResourceName(
  ownerId: string,
  projectName: string,
  suffix: string,
  maxLength = 63,
): string {
  return truncateWithHash(
    `${vaultRuntimeScopeName(ownerId, projectName)}-${sanitizeToken(suffix, "resource")}`,
    maxLength,
  );
}
