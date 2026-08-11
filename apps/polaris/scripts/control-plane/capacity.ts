import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { vaultRuntimeScopeName } from "../core/vault-name.js";
import { polarisUsersRoot } from "../utils/paths.js";
import { withVaultLifecycleLock } from "../utils/vault-lifecycle-lock.js";

export const POLARIS_MAX_ACTIVE_VAULTS_ENV = "POLARIS_MAX_ACTIVE_VAULTS";
export const DEFAULT_MAX_ACTIVE_VAULTS = 10;

const CAPACITY_LOCK_USER_ID = "__polaris-control-plane__";
const CAPACITY_LOCK_VAULT = "active-vault-capacity";
const DOCKER_VAULT_CONFIG_FILE = "docker.agent.yaml";
const MAX_SUPPORTED_ACTIVE_VAULTS = 10_000;

export class ActiveVaultCapacityError extends Error {
  readonly statusCode = 503;

  constructor(
    message: string,
    readonly limit: number,
    readonly activeVaults: number,
  ) {
    super(message);
    this.name = "ActiveVaultCapacityError";
  }
}

/**
 * Development without a release profile uses the conservative local default.
 * A configured release profile must always provide the value that
 * release-profile.mjs verifies (20 for the current 0.3.4 single-host profile).
 */
export function maxActiveVaults(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env[POLARIS_MAX_ACTIVE_VAULTS_ENV] ?? "").trim();
  if (!raw) {
    if (String(env.POLARIS_RELEASE_PROFILE ?? "").trim()) {
      throw new ActiveVaultCapacityError(
        `${POLARIS_MAX_ACTIVE_VAULTS_ENV} is required for the configured release profile`,
        0,
        0,
      );
    }
    return DEFAULT_MAX_ACTIVE_VAULTS;
  }
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new ActiveVaultCapacityError(
      `${POLARIS_MAX_ACTIVE_VAULTS_ENV} must be a positive integer`,
      0,
      0,
    );
  }
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit > MAX_SUPPORTED_ACTIVE_VAULTS) {
    throw new ActiveVaultCapacityError(
      `${POLARIS_MAX_ACTIVE_VAULTS_ENV} is outside the supported range`,
      0,
      0,
    );
  }
  return limit;
}

function configuredDockerVaultContainerNames(importMetaUrl: string): Set<string> {
  const usersRoot = polarisUsersRoot(importMetaUrl);
  if (!fs.existsSync(usersRoot)) {
    return new Set();
  }
  const containerNames = new Set<string>();
  for (const userEntry of fs.readdirSync(usersRoot, { withFileTypes: true })) {
    if (!userEntry.isDirectory()) continue;
    const vaultsRoot = path.join(usersRoot, userEntry.name, "vaults");
    if (!fs.existsSync(vaultsRoot)) continue;
    for (const vaultEntry of fs.readdirSync(vaultsRoot, { withFileTypes: true })) {
      if (!vaultEntry.isDirectory()) continue;
      const configPath = path.join(vaultsRoot, vaultEntry.name, DOCKER_VAULT_CONFIG_FILE);
      if (!fs.existsSync(configPath)) continue;
      containerNames.add(
        `${vaultRuntimeScopeName(userEntry.name, vaultEntry.name)}-docker`,
      );
    }
  }
  return containerNames;
}

function runningDockerContainerNames(): Set<string> {
  const result = spawnSync("docker", ["ps", "--format", "{{.Names}}"], {
    encoding: "utf8",
  });
  if (result.error) {
    throw new ActiveVaultCapacityError(
      `Could not inspect active Docker vaults: ${result.error.message}`,
      0,
      0,
    );
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new ActiveVaultCapacityError(
      `Could not inspect active Docker vaults${detail ? `: ${detail}` : ""}`,
      0,
      0,
    );
  }
  return new Set(
    String(result.stdout || "")
      .split(/\r?\n/u)
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

function activeDockerVaultContainerNames(importMetaUrl: string): Set<string> {
  const configured = configuredDockerVaultContainerNames(importMetaUrl);
  const running = runningDockerContainerNames();
  return new Set([...configured].filter((containerName) => running.has(containerName)));
}

/**
 * Serialize count plus container creation so two tenants cannot oversubscribe
 * the single Docker host between admission and `docker compose up`.
 */
export async function withDockerActiveVaultCapacity<T>(
  importMetaUrl: string,
  input: {
    userId: string;
    vault: string;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const userId = input.userId.trim();
  const vault = input.vault.trim();
  if (!userId || !vault) {
    throw new Error("Docker active-vault capacity requires a user and vault");
  }
  return withVaultLifecycleLock(
    importMetaUrl,
    CAPACITY_LOCK_USER_ID,
    CAPACITY_LOCK_VAULT,
    async () => {
      const activeVaults = activeDockerVaultContainerNames(importMetaUrl);
      const targetContainer = `${vaultRuntimeScopeName(userId, vault)}-docker`;
      if (activeVaults.has(targetContainer)) {
        return fn();
      }
      const limit = maxActiveVaults();
      if (activeVaults.size >= limit) {
        throw new ActiveVaultCapacityError(
          `Polaris active vault capacity reached (${activeVaults.size}/${limit}); stop a vault before starting another`,
          limit,
          activeVaults.size,
        );
      }
      return fn();
    },
  );
}
