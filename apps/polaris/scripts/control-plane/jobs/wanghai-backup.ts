import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { VaultSpec } from "../../core/vault.js";
import {
  isNetfsSource,
  netfsResolvedPath,
  vaultDataDockerVolumeName,
} from "../../core/netfs.js";
import { vaultRuntimeResourceName } from "../../core/vault-name.js";

export const WANGHAI_BACKUP_JOB_KIND = "wanghai-backup";

const BACKUP_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST_PINNED_IMAGE_PATTERN = /@sha256:[a-f0-9]{64}$/u;
const DEFAULT_RETENTION_COUNT = 2;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;
const MIN_TIMEOUT_MS = 60 * 1_000;
const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_SUBMISSIONS_PER_HOUR = 6;

export interface WanghaiBackupSettings {
  keyRoot: string;
  retentionCount: number;
  timeoutMs: number;
  submissionsPerHour: number;
}

export interface WanghaiBackupDockerRunInput {
  vault: VaultSpec;
  jobId: string;
  tenantId: string;
  vaultId: string;
  keyFile: string;
  settings: WanghaiBackupSettings;
}

export interface WanghaiBackupResult {
  [key: string]: unknown;
  archiveName: string;
  checksumVerified: true;
  retentionCount: number;
}

export class WanghaiBackupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "WanghaiBackupError";
  }
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!BACKUP_IDENTIFIER_PATTERN.test(normalized)) {
    throw new WanghaiBackupError(
      "backup-contract-invalid",
      `${label} is invalid for a Wanghai backup`,
      false,
    );
  }
  return normalized;
}

function configuredInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = String(env[name] ?? "").trim();
  if (!raw) return fallback;
  if (!/^\d+$/u.test(raw)) {
    throw new WanghaiBackupError(
      "backup-configuration-invalid",
      `${name} must be an integer`,
      false,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new WanghaiBackupError(
      "backup-configuration-invalid",
      `${name} must be between ${minimum} and ${maximum}`,
      false,
    );
  }
  return value;
}

function secureDirectory(directory: string, label: string): string {
  const normalized = directory.trim();
  if (!normalized || !path.isAbsolute(normalized)) {
    throw new WanghaiBackupError(
      "backup-configuration-invalid",
      `${label} must be an absolute directory`,
      false,
    );
  }
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(normalized);
  } catch {
    throw new WanghaiBackupError(
      "backup-configuration-invalid",
      `${label} does not exist`,
      false,
    );
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || (stats.mode & 0o077) !== 0
    || (currentUid !== undefined && stats.uid !== currentUid)
  ) {
    throw new WanghaiBackupError(
      "backup-configuration-invalid",
      `${label} must be a non-symlink directory inaccessible to group and other users`,
      false,
    );
  }
  return path.resolve(normalized);
}

export function validateWanghaiBackupKeyFile(keyFile: string): string {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(keyFile);
  } catch {
    throw new WanghaiBackupError(
      "backup-key-invalid",
      "Wanghai backup key is unavailable",
      false,
    );
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.size < 32
    || (stats.mode & 0o077) !== 0
    || (currentUid !== undefined && stats.uid !== currentUid)
  ) {
    throw new WanghaiBackupError(
      "backup-key-invalid",
      "Wanghai backup key must be a private, non-empty regular file",
      false,
    );
  }
  return keyFile;
}

function assertSafeDockerMountSource(value: string, label: string): string {
  if (!value || value.includes("\u0000") || value.includes(",")) {
    throw new WanghaiBackupError(
      "backup-contract-invalid",
      `${label} cannot be mounted safely by Docker`,
      false,
    );
  }
  return value;
}

function dockerMount(input: {
  type: "bind" | "volume";
  source: string;
  target: string;
  readOnly?: boolean;
}): string {
  const source = assertSafeDockerMountSource(input.source, "Backup mount source");
  return [
    `type=${input.type}`,
    `source=${source}`,
    `target=${input.target}`,
    ...(input.readOnly ? ["readonly"] : []),
  ].join(",");
}

function dataVolumeName(vault: VaultSpec): string {
  const source = vault.attachments.vaultData.source;
  const baseName = vaultDataDockerVolumeName(vault);
  if (isNetfsSource(source) || !source.subPath?.trim()) {
    return baseName;
  }
  const suffix = source.subPath.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-");
  return `${baseName}-${suffix}`;
}

export function wanghaiVaultDataMount(
  vault: VaultSpec,
): { type: "bind" | "volume"; source: string } {
  const source = vault.attachments.vaultData.source;
  if (isNetfsSource(source) && source.server?.trim() === "netfs.local") {
    return {
      type: "bind",
      source: netfsResolvedPath(source),
    };
  }
  return {
    type: "volume",
    source: dataVolumeName(vault),
  };
}

export function resolveWanghaiBackupSettings(
  env: NodeJS.ProcessEnv = process.env,
): WanghaiBackupSettings {
  return {
    keyRoot: secureDirectory(
      String(env.POLARIS_WANGHAI_BACKUP_KEY_ROOT ?? ""),
      "POLARIS_WANGHAI_BACKUP_KEY_ROOT",
    ),
    retentionCount: configuredInteger(
      env,
      "POLARIS_WANGHAI_BACKUP_RETENTION_COUNT",
      DEFAULT_RETENTION_COUNT,
      1,
      30,
    ),
    timeoutMs: configuredInteger(
      env,
      "POLARIS_WANGHAI_BACKUP_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
    submissionsPerHour: configuredInteger(
      env,
      "POLARIS_WANGHAI_BACKUP_SUBMISSIONS_PER_HOUR",
      DEFAULT_SUBMISSIONS_PER_HOUR,
      1,
      24,
    ),
  };
}

export function wanghaiBackupDedupeKey(
  tenantId: string,
  vaultId: string,
  idempotencyKey: string,
): string {
  const tenant = requireIdentifier(tenantId, "Backup tenant ID");
  const vault = requireIdentifier(vaultId, "Backup vault ID");
  const key = requireIdentifier(idempotencyKey, "Backup idempotency key");
  const digest = createHash("sha256")
    .update(`${tenant}\u0000${vault}\u0000${key}`)
    .digest("hex");
  return `${WANGHAI_BACKUP_JOB_KIND}:${digest}`;
}

export function wanghaiBackupRateLimitBucket(
  tenantId: string,
  vaultId: string,
): string {
  const tenant = requireIdentifier(tenantId, "Backup tenant ID");
  const vault = requireIdentifier(vaultId, "Backup vault ID");
  const digest = createHash("sha256")
    .update(`${tenant}\u0000${vault}`)
    .digest("hex");
  return `${WANGHAI_BACKUP_JOB_KIND}:rate:${digest}`;
}

export function wanghaiBackupContainerName(jobId: string): string {
  return `polaris-wanghai-backup-${requireIdentifier(jobId, "Backup job ID")}`;
}

export function wanghaiBackupArchiveName(input: {
  tenantId: string;
  vaultId: string;
  jobId: string;
}): string {
  const tenant = requireIdentifier(input.tenantId, "Backup tenant ID");
  const vault = requireIdentifier(input.vaultId, "Backup vault ID");
  const job = requireIdentifier(input.jobId, "Backup job ID");
  return `backup-${tenant}-${vault}-${job}.tar.gz.enc`;
}

export function wanghaiBackupVolumeName(vault: VaultSpec): string {
  return vaultRuntimeResourceName(
    vault.userProfile.id,
    vault.identity.projectName,
    "wanghai-backup",
  );
}

export function ensureWanghaiBackupKey(input: {
  keyRoot: string;
  tenantId: string;
  vaultId: string;
}): string {
  const keyRoot = secureDirectory(input.keyRoot, "POLARIS_WANGHAI_BACKUP_KEY_ROOT");
  const tenant = requireIdentifier(input.tenantId, "Backup tenant ID");
  const vault = requireIdentifier(input.vaultId, "Backup vault ID");
  const keyId = createHash("sha256")
    .update(`${tenant}\u0000${vault}`)
    .digest("hex");
  const keyFile = path.join(keyRoot, `wanghai-${keyId}.key`);
  try {
    fs.writeFileSync(
      keyFile,
      `${randomBytes(32).toString("base64")}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new WanghaiBackupError(
        "backup-key-invalid",
        "Unable to create the Wanghai backup key",
        false,
      );
    }
  }
  return validateWanghaiBackupKeyFile(keyFile);
}

export function buildWanghaiBackupDockerRunArgs(
  input: WanghaiBackupDockerRunInput,
): string[] {
  const tenant = requireIdentifier(input.tenantId, "Backup tenant ID");
  const vaultId = requireIdentifier(input.vaultId, "Backup vault ID");
  const jobId = requireIdentifier(input.jobId, "Backup job ID");
  const image = String(input.vault.runtime.baseImage ?? "").trim();
  if (!DIGEST_PINNED_IMAGE_PATTERN.test(image)) {
    throw new WanghaiBackupError(
      "backup-image-unpinned",
      "Wanghai backup requires a digest-pinned vault image",
      false,
    );
  }
  const dataMount = wanghaiVaultDataMount(input.vault);
  const backupVolume = wanghaiBackupVolumeName(input.vault);
  const containerName = wanghaiBackupContainerName(jobId);
  const keyFile = validateWanghaiBackupKeyFile(input.keyFile);

  return [
    "run",
    "--name", containerName,
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "64",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--label", "polaris.managed=true",
    "--label", `polaris.job.id=${jobId}`,
    "--label", `polaris.job.kind=${WANGHAI_BACKUP_JOB_KIND}`,
    "--mount", dockerMount({
      type: dataMount.type,
      source: dataMount.source,
      target: "/vault/project",
      readOnly: true,
    }),
    "--mount", dockerMount({
      type: "volume",
      source: backupVolume,
      target: "/backup",
    }),
    "--mount", dockerMount({
      type: "bind",
      source: keyFile,
      target: "/run/secrets/wanghai-backup.key",
      readOnly: true,
    }),
    "--env", "WANGHAI_RUNTIME_MODE=polaris",
    "--env", `WANGHAI_TENANT_ID=${tenant}`,
    "--env", `WANGHAI_VAULT_ID=${vaultId}`,
    "--env", `WANGHAI_BACKUP_ARCHIVE_ID=${jobId}`,
    "--env", `WANGHAI_BACKUP_RETENTION_COUNT=${input.settings.retentionCount}`,
    "--env", "WANGHAI_BACKUP_ENCRYPTION_KEY_FILE=/run/secrets/wanghai-backup.key",
    "--entrypoint", "/bin/bash",
    image,
    "/opt/wanghai/scripts/polaris-backup-workspaces.sh",
    "/backup",
  ];
}

export function buildWanghaiBackupVerificationDockerRunArgs(input: {
  vault: VaultSpec;
  archiveName: string;
}): string[] {
  const archiveName = input.archiveName.trim();
  if (!/^backup-[A-Za-z0-9_.:-]+-[A-Za-z0-9_.:-]+-[A-Za-z0-9_.:-]+\.tar\.gz\.enc$/u.test(archiveName)) {
    throw new WanghaiBackupError(
      "backup-contract-invalid",
      "Backup archive name is invalid",
      false,
    );
  }
  const image = String(input.vault.runtime.baseImage ?? "").trim();
  if (!DIGEST_PINNED_IMAGE_PATTERN.test(image)) {
    throw new WanghaiBackupError(
      "backup-image-unpinned",
      "Wanghai backup requires a digest-pinned vault image",
      false,
    );
  }
  const backupVolume = wanghaiBackupVolumeName(input.vault);
  const command = [
    "set -euo pipefail",
    "cd /backup",
    `test -f ${JSON.stringify(archiveName)}`,
    `test -f ${JSON.stringify(`${archiveName}.sha256`)}`,
    `sha256sum --check ${JSON.stringify(`${archiveName}.sha256`)}`,
  ].join("; ");
  return [
    "run",
    "--rm",
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "32",
    "--mount", dockerMount({
      type: "volume",
      source: backupVolume,
      target: "/backup",
      readOnly: true,
    }),
    "--entrypoint", "/bin/bash",
    image,
    "-lc",
    command,
  ];
}

export function parseWanghaiBackupArchiveLog(
  output: string,
  expectedArchiveName: string,
): Pick<WanghaiBackupResult, "archiveName" | "checksumVerified"> {
  const expected = `/backup/${expectedArchiveName}`;
  const found = output.split(/\r?\n/u).some((line) => line.trim() === expected);
  if (!found) {
    throw new WanghaiBackupError(
      "backup-result-invalid",
      "Wanghai backup container did not report the expected archive",
      false,
    );
  }
  return {
    archiveName: expectedArchiveName,
    checksumVerified: true,
  };
}
