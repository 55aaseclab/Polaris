import { createHash } from "node:crypto";
import type { VaultSpec } from "../../core/vault.js";
import { vaultRuntimeResourceName } from "../../core/vault-name.js";
import {
  WanghaiBackupError,
  resolveWanghaiBackupSettings,
  validateWanghaiBackupKeyFile,
  wanghaiBackupVolumeName,
  wanghaiVaultDataMount,
} from "./wanghai-backup.js";

export const WANGHAI_RESTORE_JOB_KIND = "wanghai-restore";
export const WANGHAI_RESTORE_ACTIVATION_JOB_KIND = "wanghai-restore-activation";
export const WANGHAI_RESTORE_ROLLBACK_JOB_KIND = "wanghai-restore-rollback";

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

export interface WanghaiRestoreActivationDockerRunInput {
  vault: VaultSpec;
  jobId: string;
  restoreJobId: string;
  stagingVolume: string;
}

export interface WanghaiRestoreActivationResult {
  [key: string]: unknown;
  restoreJobId: string;
  previousWorkspaceName: string;
  checksumVerified: true;
}

export interface WanghaiRestoreRollbackDockerRunInput {
  vault: VaultSpec;
  jobId: string;
  activationJobId: string;
  previousWorkspaceName: string;
}

export interface WanghaiRestoreRollbackResult {
  [key: string]: unknown;
  activationJobId: string;
  failedWorkspaceName: string;
  rollbackVerified: true;
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

function wanghaiRestoreLifecycleDedupeKey(
  kind: string,
  tenantId: string,
  vaultId: string,
  sourceJobId: string,
  idempotencyKey: string,
): string {
  const tenant = requireIdentifier(tenantId, "Restore tenant ID");
  const vault = requireIdentifier(vaultId, "Restore vault ID");
  const source = requireIdentifier(sourceJobId, "Restore lifecycle source job ID");
  const key = requireIdentifier(idempotencyKey, "Restore lifecycle idempotency key");
  const digest = createHash("sha256")
    .update(`${kind}\u0000${tenant}\u0000${vault}\u0000${source}\u0000${key}`)
    .digest("hex");
  return `${kind}:${digest}`;
}

export function wanghaiRestoreActivationDedupeKey(
  tenantId: string,
  vaultId: string,
  restoreJobId: string,
  idempotencyKey: string,
): string {
  return wanghaiRestoreLifecycleDedupeKey(
    WANGHAI_RESTORE_ACTIVATION_JOB_KIND,
    tenantId,
    vaultId,
    restoreJobId,
    idempotencyKey,
  );
}

export function wanghaiRestoreRollbackDedupeKey(
  tenantId: string,
  vaultId: string,
  activationJobId: string,
  idempotencyKey: string,
): string {
  return wanghaiRestoreLifecycleDedupeKey(
    WANGHAI_RESTORE_ROLLBACK_JOB_KIND,
    tenantId,
    vaultId,
    activationJobId,
    idempotencyKey,
  );
}

export function wanghaiRestoreRateLimitBucket(tenantId: string, vaultId: string): string {
  return wanghaiRestoreLifecycleRateLimitBucket(
    WANGHAI_RESTORE_JOB_KIND,
    tenantId,
    vaultId,
  );
}

function wanghaiRestoreLifecycleRateLimitBucket(
  kind: string,
  tenantId: string,
  vaultId: string,
): string {
  const tenant = requireIdentifier(tenantId, "Restore tenant ID");
  const vault = requireIdentifier(vaultId, "Restore vault ID");
  const digest = createHash("sha256")
    .update(`${kind}\u0000${tenant}\u0000${vault}`)
    .digest("hex");
  return `${kind}:rate:${digest}`;
}

export function wanghaiRestoreActivationRateLimitBucket(
  tenantId: string,
  vaultId: string,
): string {
  return wanghaiRestoreLifecycleRateLimitBucket(
    WANGHAI_RESTORE_ACTIVATION_JOB_KIND,
    tenantId,
    vaultId,
  );
}

export function wanghaiRestoreRollbackRateLimitBucket(
  tenantId: string,
  vaultId: string,
): string {
  return wanghaiRestoreLifecycleRateLimitBucket(
    WANGHAI_RESTORE_ROLLBACK_JOB_KIND,
    tenantId,
    vaultId,
  );
}

export function wanghaiRestoreContainerName(jobId: string): string {
  return `polaris-wanghai-restore-${requireIdentifier(jobId, "Restore job ID")}`;
}

export function wanghaiRestoreActivationContainerName(jobId: string): string {
  return `polaris-wanghai-restore-activation-${requireIdentifier(jobId, "Restore activation job ID")}`;
}

export function wanghaiRestoreRollbackContainerName(jobId: string): string {
  return `polaris-wanghai-restore-rollback-${requireIdentifier(jobId, "Restore rollback job ID")}`;
}

export function wanghaiRestoreStagingVolumeName(vault: VaultSpec, jobId: string): string {
  const suffix = `wanghai-restore-${requireIdentifier(jobId, "Restore job ID")}`;
  return vaultRuntimeResourceName(vault.userProfile.id, vault.identity.projectName, suffix);
}

export function wanghaiRestoreActivationCandidateWorkspaceName(jobId: string): string {
  return `workspaces.restore-pending-${requireIdentifier(jobId, "Restore activation job ID")}`;
}

export function wanghaiRestorePreviousWorkspaceName(jobId: string): string {
  return `workspaces.pre-restore-${requireIdentifier(jobId, "Restore activation job ID")}`;
}

export function wanghaiRestoreRollbackFailedWorkspaceName(jobId: string): string {
  return `workspaces.failed-rollback-${requireIdentifier(jobId, "Restore rollback job ID")}`;
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

function workspaceChecksumShellFunction(): string[] {
  return [
    "workspace_checksums() {",
    "  local root=\"$1\"",
    "  (",
    "    cd \"$root\"",
    "    find . -type f -print0 | sort -z | while IFS= read -r -d '' entry; do",
    "      sha256sum -- \"$entry\"",
    "    done",
    "  )",
    "}",
    "verify_workspace_tree() {",
    "  local root=\"$1\"",
    "  test -d \"$root\"",
    "  test -z \"$(find \"$root\" -type l -print -quit)\"",
    "}",
  ];
}

function activationCommand(input: {
  jobId: string;
  restoreJobId: string;
  previousWorkspaceName: string;
  candidateWorkspaceName: string;
}): string {
  const jobId = requireIdentifier(input.jobId, "Restore activation job ID");
  const restoreJobId = requireIdentifier(input.restoreJobId, "Restore source job ID");
  const previousWorkspaceName = requireIdentifier(
    input.previousWorkspaceName,
    "Restore previous workspace name",
  );
  const candidateWorkspaceName = requireIdentifier(
    input.candidateWorkspaceName,
    "Restore candidate workspace name",
  );
  return [
    "set -euo pipefail",
    `activation_job_id=${JSON.stringify(jobId)}`,
    `restore_job_id=${JSON.stringify(restoreJobId)}`,
    `previous_workspace_name=${JSON.stringify(previousWorkspaceName)}`,
    "staged_root=/restore/workspaces",
    "target=/vault/project/workspaces",
    `candidate=/vault/project/${candidateWorkspaceName}`,
    `previous=/vault/project/${previousWorkspaceName}`,
    "candidate_failed=\"$candidate.failed\"",
    "original_moved=0",
    "candidate_activated=0",
    ...workspaceChecksumShellFunction(),
    "activation_cleanup() {",
    "  local status=$?",
    "  if [ \"$status\" -ne 0 ]; then",
    "    if [ \"$candidate_activated\" = 1 ] && [ -e \"$target\" ]; then",
    "      mv -- \"$target\" \"$candidate_failed\" || true",
    "    fi",
    "    if [ \"$original_moved\" = 1 ] && [ -e \"$previous\" ] && [ ! -e \"$target\" ]; then",
    "      mv -- \"$previous\" \"$target\" || true",
    "    fi",
    "    rm -rf -- \"$candidate\" || true",
    "  fi",
    "  exit \"$status\"",
    "}",
    "trap activation_cleanup EXIT",
    "verify_workspace_tree \"$staged_root\"",
    "if [ -e \"$previous\" ]; then",
    "  if [ ! -e \"$target\" ]; then",
    "    if [ -d \"$candidate\" ]; then",
    "      original_moved=1",
    "      verify_workspace_tree \"$candidate\"",
    "      cmp <(workspace_checksums \"$staged_root\") <(workspace_checksums \"$candidate\")",
    "      mv -- \"$candidate\" \"$target\"",
    "      candidate_activated=1",
    "    else",
    "      mv -- \"$previous\" \"$target\" || true",
    "      echo 'restore activation recovery could not find its candidate workspace' >&2",
    "      exit 1",
    "    fi",
    "  fi",
    "  verify_workspace_tree \"$target\"",
    "  cmp <(workspace_checksums \"$staged_root\") <(workspace_checksums \"$target\")",
    "  trap - EXIT",
    "  printf 'activation_job_id=%s\\n' \"$activation_job_id\"",
    "  printf 'restore_job_id=%s\\n' \"$restore_job_id\"",
    "  printf 'activated_workspace=workspaces\\n'",
    "  printf 'previous_workspace=%s\\n' \"$previous_workspace_name\"",
    "  printf 'verified=1\\n'",
    "  exit 0",
    "fi",
    "test -d \"$target\"",
    "test ! -e \"$candidate\"",
    "rm -rf -- \"$candidate\"",
    "mkdir -p \"$candidate\"",
    "rsync -a --delete --safe-links \"$staged_root/\" \"$candidate/\"",
    "verify_workspace_tree \"$candidate\"",
    "cmp <(workspace_checksums \"$staged_root\") <(workspace_checksums \"$candidate\")",
    "mv -- \"$target\" \"$previous\"",
    "original_moved=1",
    "mv -- \"$candidate\" \"$target\"",
    "candidate_activated=1",
    "verify_workspace_tree \"$target\"",
    "cmp <(workspace_checksums \"$staged_root\") <(workspace_checksums \"$target\")",
    "trap - EXIT",
    "printf 'activation_job_id=%s\\n' \"$activation_job_id\"",
    "printf 'restore_job_id=%s\\n' \"$restore_job_id\"",
    "printf 'activated_workspace=workspaces\\n'",
    "printf 'previous_workspace=%s\\n' \"$previous_workspace_name\"",
    "printf 'verified=1\\n'",
  ].join("\n");
}

export function buildWanghaiRestoreActivationDockerRunArgs(
  input: WanghaiRestoreActivationDockerRunInput,
): string[] {
  const jobId = requireIdentifier(input.jobId, "Restore activation job ID");
  const restoreJobId = requireIdentifier(input.restoreJobId, "Restore source job ID");
  const expectedStagingVolume = wanghaiRestoreStagingVolumeName(input.vault, restoreJobId);
  if (input.stagingVolume !== expectedStagingVolume) {
    throw new WanghaiRestoreError(
      "restore-contract-invalid",
      "Restore activation staging volume does not match its restore job",
      false,
    );
  }
  const stagingVolume = assertSafeDockerMountSource(expectedStagingVolume, "Restore staging volume");
  const image = restoreImage(input.vault);
  const dataMount = wanghaiVaultDataMount(input.vault);
  const previousWorkspaceName = wanghaiRestorePreviousWorkspaceName(jobId);
  const candidateWorkspaceName = wanghaiRestoreActivationCandidateWorkspaceName(jobId);
  return [
    "run",
    "--name", wanghaiRestoreActivationContainerName(jobId),
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "64",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--label", "polaris.managed=true",
    "--label", `polaris.job.id=${jobId}`,
    "--label", `polaris.job.kind=${WANGHAI_RESTORE_ACTIVATION_JOB_KIND}`,
    "--label", `polaris.restore.job.id=${restoreJobId}`,
    "--mount", dockerMount({
      type: dataMount.type,
      source: dataMount.source,
      target: "/vault/project",
    }),
    "--mount", dockerMount({
      type: "volume",
      source: stagingVolume,
      target: "/restore",
      readOnly: true,
    }),
    "--entrypoint", "/bin/bash",
    image,
    "-lc",
    activationCommand({
      jobId,
      restoreJobId,
      previousWorkspaceName,
      candidateWorkspaceName,
    }),
  ];
}

export function buildWanghaiRestoreActivationVerificationDockerRunArgs(input: {
  vault: VaultSpec;
  jobId: string;
  restoreJobId: string;
  stagingVolume: string;
}): string[] {
  const jobId = requireIdentifier(input.jobId, "Restore activation job ID");
  const restoreJobId = requireIdentifier(input.restoreJobId, "Restore source job ID");
  const expectedStagingVolume = wanghaiRestoreStagingVolumeName(input.vault, restoreJobId);
  if (input.stagingVolume !== expectedStagingVolume) {
    throw new WanghaiRestoreError(
      "restore-contract-invalid",
      "Restore activation staging volume does not match its restore job",
      false,
    );
  }
  const stagingVolume = assertSafeDockerMountSource(expectedStagingVolume, "Restore staging volume");
  const dataMount = wanghaiVaultDataMount(input.vault);
  const image = restoreImage(input.vault);
  const previousWorkspaceName = wanghaiRestorePreviousWorkspaceName(jobId);
  const command = [
    "set -euo pipefail",
    ...workspaceChecksumShellFunction(),
    "verify_workspace_tree /restore/workspaces",
    "verify_workspace_tree /vault/project/workspaces",
    `test -d ${JSON.stringify(`/vault/project/${previousWorkspaceName}`)}`,
    "cmp <(workspace_checksums /restore/workspaces) <(workspace_checksums /vault/project/workspaces)",
  ].join("\n");
  return [
    "run",
    "--rm",
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "32",
    "--mount", dockerMount({
      type: dataMount.type,
      source: dataMount.source,
      target: "/vault/project",
      readOnly: true,
    }),
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

export function parseWanghaiRestoreActivationLog(input: {
  output: string;
  jobId: string;
  restoreJobId: string;
}): Pick<WanghaiRestoreActivationResult, "checksumVerified" | "previousWorkspaceName"> {
  const jobId = requireIdentifier(input.jobId, "Restore activation job ID");
  const restoreJobId = requireIdentifier(input.restoreJobId, "Restore source job ID");
  const previousWorkspaceName = wanghaiRestorePreviousWorkspaceName(input.jobId);
  const lines = new Set(input.output.split(/\r?\n/u).map((line) => line.trim()));
  if (
    !lines.has(`activation_job_id=${jobId}`)
    || !lines.has(`restore_job_id=${restoreJobId}`)
    || !lines.has("activated_workspace=workspaces")
    || !lines.has(`previous_workspace=${previousWorkspaceName}`)
    || !lines.has("verified=1")
  ) {
    throw new WanghaiRestoreError(
      "restore-activation-result-invalid",
      "Wanghai restore activation container did not report a verified result",
      false,
    );
  }
  return { previousWorkspaceName, checksumVerified: true };
}

function rollbackCommand(input: {
  jobId: string;
  activationJobId: string;
  previousWorkspaceName: string;
}): string {
  const jobId = requireIdentifier(input.jobId, "Restore rollback job ID");
  const activationJobId = requireIdentifier(
    input.activationJobId,
    "Restore activation job ID",
  );
  const previousWorkspaceName = requireIdentifier(
    input.previousWorkspaceName,
    "Restore previous workspace name",
  );
  const failedWorkspaceName = wanghaiRestoreRollbackFailedWorkspaceName(jobId);
  return [
    "set -euo pipefail",
    `rollback_job_id=${JSON.stringify(jobId)}`,
    `activation_job_id=${JSON.stringify(activationJobId)}`,
    `failed_workspace_name=${JSON.stringify(failedWorkspaceName)}`,
    "target=/vault/project/workspaces",
    `previous=/vault/project/${previousWorkspaceName}`,
    `failed=/vault/project/${failedWorkspaceName}`,
    "target_moved=0",
    "original_restored=0",
    ...workspaceChecksumShellFunction(),
    "rollback_cleanup() {",
    "  local status=$?",
    "  if [ \"$status\" -ne 0 ]; then",
    "    if [ \"$original_restored\" = 1 ] && [ -e \"$target\" ]; then",
    "      mv -- \"$target\" \"$previous\" || true",
    "    fi",
    "    if [ \"$target_moved\" = 1 ] && [ -e \"$failed\" ] && [ ! -e \"$target\" ]; then",
    "      mv -- \"$failed\" \"$target\" || true",
    "    fi",
    "  fi",
    "  exit \"$status\"",
    "}",
    "trap rollback_cleanup EXIT",
    "if [ -e \"$failed\" ]; then",
    "  if [ ! -e \"$target\" ] && [ -d \"$previous\" ]; then",
    "    mv -- \"$previous\" \"$target\"",
    "  fi",
    "  verify_workspace_tree \"$target\"",
    "  trap - EXIT",
    "  printf 'rollback_job_id=%s\\n' \"$rollback_job_id\"",
    "  printf 'activation_job_id=%s\\n' \"$activation_job_id\"",
    "  printf 'rolled_back_workspace=workspaces\\n'",
    "  printf 'failed_workspace=%s\\n' \"$failed_workspace_name\"",
    "  printf 'verified=1\\n'",
    "  exit 0",
    "fi",
    "test -d \"$target\"",
    "test -d \"$previous\"",
    "mv -- \"$target\" \"$failed\"",
    "target_moved=1",
    "mv -- \"$previous\" \"$target\"",
    "original_restored=1",
    "verify_workspace_tree \"$target\"",
    "trap - EXIT",
    "printf 'rollback_job_id=%s\\n' \"$rollback_job_id\"",
    "printf 'activation_job_id=%s\\n' \"$activation_job_id\"",
    "printf 'rolled_back_workspace=workspaces\\n'",
    "printf 'failed_workspace=%s\\n' \"$failed_workspace_name\"",
    "printf 'verified=1\\n'",
  ].join("\n");
}

export function buildWanghaiRestoreRollbackDockerRunArgs(
  input: WanghaiRestoreRollbackDockerRunInput,
): string[] {
  const jobId = requireIdentifier(input.jobId, "Restore rollback job ID");
  const activationJobId = requireIdentifier(input.activationJobId, "Restore activation job ID");
  const previousWorkspaceName = wanghaiRestorePreviousWorkspaceName(activationJobId);
  if (input.previousWorkspaceName !== previousWorkspaceName) {
    throw new WanghaiRestoreError(
      "restore-contract-invalid",
      "Restore rollback previous workspace does not match its activation job",
      false,
    );
  }
  const image = restoreImage(input.vault);
  const dataMount = wanghaiVaultDataMount(input.vault);
  return [
    "run",
    "--name", wanghaiRestoreRollbackContainerName(jobId),
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "64",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--label", "polaris.managed=true",
    "--label", `polaris.job.id=${jobId}`,
    "--label", `polaris.job.kind=${WANGHAI_RESTORE_ROLLBACK_JOB_KIND}`,
    "--label", `polaris.restore.activation.id=${activationJobId}`,
    "--mount", dockerMount({
      type: dataMount.type,
      source: dataMount.source,
      target: "/vault/project",
    }),
    "--entrypoint", "/bin/bash",
    image,
    "-lc",
    rollbackCommand({ jobId, activationJobId, previousWorkspaceName }),
  ];
}

export function buildWanghaiRestoreRollbackVerificationDockerRunArgs(input: {
  vault: VaultSpec;
  jobId: string;
  failedWorkspaceName: string;
}): string[] {
  const image = restoreImage(input.vault);
  const dataMount = wanghaiVaultDataMount(input.vault);
  const expectedFailedWorkspaceName = wanghaiRestoreRollbackFailedWorkspaceName(input.jobId);
  if (input.failedWorkspaceName !== expectedFailedWorkspaceName) {
    throw new WanghaiRestoreError(
      "restore-contract-invalid",
      "Restore rollback failed workspace does not match its job",
      false,
    );
  }
  const command = [
    "set -euo pipefail",
    ...workspaceChecksumShellFunction(),
    "verify_workspace_tree /vault/project/workspaces",
    `verify_workspace_tree ${JSON.stringify(`/vault/project/${expectedFailedWorkspaceName}`)}`,
  ].join("\n");
  return [
    "run",
    "--rm",
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "32",
    "--mount", dockerMount({
      type: dataMount.type,
      source: dataMount.source,
      target: "/vault/project",
      readOnly: true,
    }),
    "--entrypoint", "/bin/bash",
    image,
    "-lc",
    command,
  ];
}

export function parseWanghaiRestoreRollbackLog(input: {
  output: string;
  jobId: string;
  activationJobId: string;
}): Pick<WanghaiRestoreRollbackResult, "rollbackVerified" | "failedWorkspaceName"> {
  const jobId = requireIdentifier(input.jobId, "Restore rollback job ID");
  const activationJobId = requireIdentifier(
    input.activationJobId,
    "Restore activation job ID",
  );
  const failedWorkspaceName = wanghaiRestoreRollbackFailedWorkspaceName(input.jobId);
  const lines = new Set(input.output.split(/\r?\n/u).map((line) => line.trim()));
  if (
    !lines.has(`rollback_job_id=${jobId}`)
    || !lines.has(`activation_job_id=${activationJobId}`)
    || !lines.has("rolled_back_workspace=workspaces")
    || !lines.has(`failed_workspace=${failedWorkspaceName}`)
    || !lines.has("verified=1")
  ) {
    throw new WanghaiRestoreError(
      "restore-rollback-result-invalid",
      "Wanghai restore rollback container did not report a verified result",
      false,
    );
  }
  return { failedWorkspaceName, rollbackVerified: true };
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
