import { createHash } from "node:crypto";
import type { VaultSpec } from "../core/vault.js";
import { vaultRuntimeResourceName } from "../core/vault-name.js";
import {
  WanghaiBackupError,
  resolveWanghaiBackupSettings,
  validateWanghaiBackupKeyFile,
  wanghaiBackupVolumeName,
} from "./wanghai-backup.js";

export const WANGHAI_RESTORE_JOB_KIND = "wanghai-restore";

const RESTORE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ARCHIVE_NAME_PATTERN =
  /^backup-[A-Za-z0-9_.:-]+-[A-Za-z0-9_.:-]+-[A-Za-z0-9_.:-]+\.tar\.gz\.enc$/u;
const DIGEST_PINNED_IMAGE_PATTERN = /@sha256:[a-f0-9]{64}$/u;
const DEFAULT_RESTORE_SUBMISSIONS_PER_HOUR = 2;
const DEFAULT_RESTORE_MAX_ARCHIVE_BYTES = 260 * 1024 * 1024;
const MIN_RESTORE_ARCHIVE_BYTES = 1024;
const MAX_RESTORE_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;

export interface WanghaiRestoreSettings {
  keyRoot: string;
  timeoutMs: number;
  submissionsPerHour: number;
  maxArchiveBytes: number;
}

export interface WanghaiRestoreDockerRunInput {
  vault: VaultSpec;
  jobId: string;
  tenantId: string;
  vaultId: string;
  archiveName: string;
  keyFile: string;
  settings: WanghaiRestoreSettings;
}

export interface WanghaiRestoreResult {
  [key: string]: unknown;
  sourceBackupJobId: string;
  archiveName: string;
  checksumVerified: true;
  stagingVolume: string;
}

export class WanghaiRestoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "WanghaiRestoreError";
  }
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!RESTORE_IDENTIFIER_PATTERN.test(normalized)) {
    throw new WanghaiRestoreError(
      "restore-contract-invalid",
      `${label} is invalid for a Wanghai restore`,
      false,
    );
  }
  return normalized;
}

function requireArchiveName(value: string): string {
  const normalized = value.trim();
  if (!ARCHIVE_NAME_PATTERN.test(normalized)) {
    throw new WanghaiRestoreError(
      "restore-contract-invalid",
      "Wanghai restore archive name is invalid",
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
    throw new WanghaiRestoreError(
      "restore-configuration-invalid",
      `${name} must be an integer`,
      false,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new WanghaiRestoreError(
      "restore-configuration-invalid",
      `${name} must be between ${minimum} and ${maximum}`,
      false,
    );
  }
  return value;
}

function assertSafeDockerMountSource(value: string, label: string): string {
  if (!value || value.includes("\u0000") || value.includes(",")) {
    throw new WanghaiRestoreError(
      "restore-contract-invalid",
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
  const source = assertSafeDockerMountSource(input.source, "Restore mount source");
  return [
    `type=${input.type}`,
    `source=${source}`,
    `target=${input.target}`,
    ...(input.readOnly ? ["readonly"] : []),
  ].join(",");
}

function restoreImage(vault: VaultSpec): string {
  const image = String(vault.runtime.baseImage ?? "").trim();
  if (!DIGEST_PINNED_IMAGE_PATTERN.test(image)) {
    throw new WanghaiRestoreError(
      "restore-image-unpinned",
      "Wanghai restore requires a digest-pinned vault image",
      false,
    );
  }
  return image;
}

export function resolveWanghaiRestoreSettings(
  env: NodeJS.ProcessEnv = process.env,
): WanghaiRestoreSettings {
  let backupSettings: ReturnType<typeof resolveWanghaiBackupSettings>;
  try {
    backupSettings = resolveWanghaiBackupSettings(env);
  } catch (error) {
    if (error instanceof WanghaiBackupError) {
      throw new WanghaiRestoreError(
        "restore-configuration-invalid",
        error.message,
        false,
      );
    }
    throw error;
  }
  return {
    keyRoot: backupSettings.keyRoot,
    timeoutMs: configuredInteger(
      env,
      "POLARIS_WANGHAI_RESTORE_TIMEOUT_MS",
      backupSettings.timeoutMs,
      60_000,
      6 * 60 * 60 * 1_000,
    ),
    submissionsPerHour: configuredInteger(
      env,
      "POLARIS_WANGHAI_RESTORE_SUBMISSIONS_PER_HOUR",
      Math.min(DEFAULT_RESTORE_SUBMISSIONS_PER_HOUR, backupSettings.submissionsPerHour),
      1,
      24,
    ),
    maxArchiveBytes: configuredInteger(
      env,
      "POLARIS_WANGHAI_RESTORE_MAX_ARCHIVE_BYTES",
      DEFAULT_RESTORE_MAX_ARCHIVE_BYTES,
      MIN_RESTORE_ARCHIVE_BYTES,
      MAX_RESTORE_ARCHIVE_BYTES,
    ),
  };
}

export function wanghaiRestoreDedupeKey(
  tenantId: string,
  vaultId: string,
  sourceBackupJobId: string,
  idempotencyKey: string,
): string {
  const tenant = requireIdentifier(tenantId, "Restore tenant ID");
  const vault = requireIdentifier(vaultId, "Restore vault ID");
  const source = requireIdentifier(sourceBackupJobId, "Restore source backup job ID");
  const key = requireIdentifier(idempotencyKey, "Restore idempotency key");
  const digest = createHash("sha256")
    .update(`${tenant}\u0000${vault}\u0000${source}\u0000${key}`)
    .digest("hex");
  return `${WANGHAI_RESTORE_JOB_KIND}:${digest}`;
}

export function wanghaiRestoreRateLimitBucket(tenantId: string, vaultId: string): string {
  const tenant = requireIdentifier(tenantId, "Restore tenant ID");
  const vault = requireIdentifier(vaultId, "Restore vault ID");
  const digest = createHash("sha256")
    .update(`${tenant}\u0000${vault}`)
    .digest("hex");
  return `${WANGHAI_RESTORE_JOB_KIND}:rate:${digest}`;
}

export function wanghaiRestoreContainerName(jobId: string): string {
  return `polaris-wanghai-restore-${requireIdentifier(jobId, "Restore job ID")}`;
}

export function wanghaiRestoreStagingVolumeName(vault: VaultSpec, jobId: string): string {
  const suffix = `wanghai-restore-${requireIdentifier(jobId, "Restore job ID")}`;
  return vaultRuntimeResourceName(vault.userProfile.id, vault.identity.projectName, suffix);
}

export function buildWanghaiRestoreDockerRunArgs(
  input: WanghaiRestoreDockerRunInput,
): string[] {
  const tenant = requireIdentifier(input.tenantId, "Restore tenant ID");
  const vaultId = requireIdentifier(input.vaultId, "Restore vault ID");
  const jobId = requireIdentifier(input.jobId, "Restore job ID");
  const archiveName = requireArchiveName(input.archiveName);
  const image = restoreImage(input.vault);
  const keyFile = validateWanghaiBackupKeyFile(input.keyFile);
  const backupVolume = wanghaiBackupVolumeName(input.vault);
  const stagingVolume = wanghaiRestoreStagingVolumeName(input.vault, jobId);
  const containerName = wanghaiRestoreContainerName(jobId);

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
    "--label", `polaris.job.kind=${WANGHAI_RESTORE_JOB_KIND}`,
    "--mount", dockerMount({
      type: "volume",
      source: backupVolume,
      target: "/backup",
      readOnly: true,
    }),
    "--mount", dockerMount({
      type: "volume",
      source: stagingVolume,
      target: "/restore",
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
    "--env", "WANGHAI_BACKUP_ENCRYPTION_KEY_FILE=/run/secrets/wanghai-backup.key",
    "--env", `WANGHAI_RESTORE_MAX_ARCHIVE_BYTES=${input.settings.maxArchiveBytes}`,
    "--entrypoint", "/bin/bash",
    image,
    "/opt/wanghai/scripts/polaris-restore-workspaces.sh",
    archiveName,
  ];
}

export function buildWanghaiRestoreVerificationDockerRunArgs(input: {
  vault: VaultSpec;
  jobId: string;
}): string[] {
  const image = restoreImage(input.vault);
  const stagingVolume = wanghaiRestoreStagingVolumeName(input.vault, input.jobId);
  const command = [
    "set -euo pipefail",
    "test -d /restore/workspaces",
    "test ! -e /restore/workspaces/.backup-manifest",
    "test ! -e /restore/workspaces/.backup-files.sha256",
    "test -z \"$(find /restore/workspaces -type l -print -quit)\"",
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
      source: stagingVolume,
      target: "/restore",
      readOnly: true,
    }),
    "--entrypoint", "/bin/bash",
    image,
    "-lc",
    command,
  ];
}

export function parseWanghaiRestoreLog(output: string): Pick<WanghaiRestoreResult, "checksumVerified"> {
  const lines = new Set(output.split(/\r?\n/u).map((line) => line.trim()));
  if (!lines.has("restored_to=/restore/workspaces") || !lines.has("verified=1")) {
    throw new WanghaiRestoreError(
      "restore-result-invalid",
      "Wanghai restore container did not report a verified staging result",
      false,
    );
  }
  return { checksumVerified: true };
}
