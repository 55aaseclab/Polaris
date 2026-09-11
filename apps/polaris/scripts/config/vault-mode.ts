export type PolarisVaultMode = "host" | "vault";

export class VaultModeError extends Error {
  readonly statusCode = 403;

  constructor(message: string) {
    super(message);
    this.name = "VaultModeError";
  }
}

export function resolvePolarisVaultMode(
  env: NodeJS.ProcessEnv = process.env,
): PolarisVaultMode {
  const raw = String(env.POLARIS_VAULT_MODE ?? "").trim().toLowerCase();
  if (!raw || raw === "vault") {
    return "vault";
  }
  if (raw === "host") {
    return "host";
  }
  throw new Error("POLARIS_VAULT_MODE must be host or vault");
}

export function isHostVaultMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolvePolarisVaultMode(env) === "host";
}

export function assertVaultCreationAllowed(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isHostVaultMode(env)) {
    throw new VaultModeError("POLARIS_VAULT_MODE=host disables vault creation");
  }
}