import { createHash } from "node:crypto";

const VAULT_PROJECT_NAME_PATTERN =
  /^(?=.{1,63}$)(?=.*[a-z])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function isValidVaultProjectName(value: string): boolean {
  return VAULT_PROJECT_NAME_PATTERN.test(value.trim());
}

export function assertValidVaultProjectName(value: string): void {
  const trimmed = value.trim();
  if (isValidVaultProjectName(trimmed)) {
    return;
  }
  throw new Error(
    "Vault name must be 1-63 characters, use lowercase letters, numbers, or hyphens, start and end with a letter or number, and include at least one letter.",
  );
}

function sanitizeRuntimeNameToken(value: string, fallback: string): string {
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

export function vaultRuntimeScopeName(userProfileId: string, projectName: string): string {
  const userToken = sanitizeRuntimeNameToken(userProfileId, "user");
  const projectToken = sanitizeRuntimeNameToken(projectName, "vault");
  return truncateWithHash(`${userToken}-${projectToken}`, 63);
}

export function vaultRuntimeResourceName(
  userProfileId: string,
  projectName: string,
  suffix: string,
  maxLength = 63,
): string {
  const scope = vaultRuntimeScopeName(userProfileId, projectName);
  const suffixToken = sanitizeRuntimeNameToken(suffix, "resource");
  return truncateWithHash(`${scope}-${suffixToken}`, maxLength);
}
