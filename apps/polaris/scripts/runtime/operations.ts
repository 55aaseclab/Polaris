import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ensureCanonicalVaultImage, ensureVaultConfig } from "../config/provision.js";
import { assertProjectNameAvailableForUser } from "../config/project-ownership.js";
import { userProfileExists, vaultConfigExists, vaultConfigPath } from "../config/scaffold.js";
import { readManagedCredentialRecord } from "../config/credentials.js";
import {
  supportsLiveCredentialSwitch,
  type ManagedHarness,
} from "../config/credential-catalog.js";
import {
  SKILL_HARNESSES,
  isSkillHarness,
  listInstalledVaultSkills,
  listUserSkills,
  readUserSkill,
  removeInstalledVaultSkill,
  resolveVaultSkillInstallRoot,
  type SkillHarness,
} from "../config/skills.js";
import {
  defaultMountPathForCredentialFile,
  stateStoragePathForMountPath,
} from "../core/identity-layout.js";
import {
  loadVaultDetail,
  loadPortalVaultByTarget,
  loadVaultSummary,
  readVaultStatus,
  type PortalDriverTarget,
  type PortalVaultDetail,
  type PortalVaultPaseoDiagnostic,
  updatePortalVaultAgentBinding,
  vaultRefFromTarget,
} from "../core/portal.js";
import { loadVaultFromConfigPath } from "../config/load.js";
import { createVaultForUser } from "../cli/commands/create.js";
import { performVaultSwitch, type SwitchResult } from "../cli/commands/switch.js";
import { deleteVaultOwnedByUser } from "../cli/commands/delete.js";
import {
  loadExecutableVaultForCommand,
  loadVaultForCommand,
} from "../cli/commands/shared.js";
import { startCommand } from "../cli/commands/start.js";
import { statusCommand } from "../cli/commands/status.js";
import { stopCommand } from "../cli/commands/stop.js";
import { rebuildCommand } from "../cli/commands/rebuild.js";
import { renderAndWriteDockerVault } from "../backends/docker/render.js";
import { renderAndWritePodVault } from "../backends/pod/render.js";
import { renderAndWriteKubevirtVault } from "../backends/kubevirt/render.js";
import { getBackendDriver } from "../backends/index.js";
import {
  VAULT_STATUS_SCHEMA_VERSION,
  type VaultCommandKind,
  type VaultSpec,
  type VaultStatus,
} from "../core/vault.js";
import { vaultRuntimeScopeName } from "../core/vault-name.js";
import {
  parsePaseoDaemonStatus,
} from "../core/paseo.js";
import {
  writeVaultLiveCredentialSelection,
  writeVaultPaseoPairing,
  writeVaultPaseoServerId,
  writeVaultStatus,
} from "../output/state-store.js";
import { logError, logInfo, logWarn } from "../utils/log.js";
import { polarisUsersRoot, repoRoot } from "../utils/paths.js";
import { logVaultEvent, measureVaultPhase } from "../utils/vault-log.js";
import { notifyPortalVaultLiveChange } from "../portal/vault-live-hub.js";
import { withUserMutationLock } from "../utils/user-mutation-lock.js";
import {
  withVaultLifecycleLock,
  withVaultMutationLock,
} from "../utils/vault-lifecycle-lock.js";
import {
  getPolarisControlStore,
  type DurableJob,
} from "../portal/control-store.js";
import { durableJobWorkerConcurrency } from "./job-concurrency.js";
import {
  WANGHAI_BACKUP_JOB_KIND,
  WanghaiBackupError,
  buildWanghaiBackupDockerRunArgs,
  buildWanghaiBackupVerificationDockerRunArgs,
  ensureWanghaiBackupKey,
  parseWanghaiBackupArchiveLog,
  resolveWanghaiBackupSettings,
  wanghaiBackupArchiveName,
  wanghaiBackupContainerName,
  wanghaiBackupDedupeKey,
  wanghaiBackupRateLimitBucket,
  type WanghaiBackupResult,
} from "./wanghai-backup.js";
import {
  WANGHAI_RESTORE_ACTIVATION_JOB_KIND,
  WANGHAI_RESTORE_JOB_KIND,
  WANGHAI_RESTORE_ROLLBACK_JOB_KIND,
  WanghaiRestoreError,
  buildWanghaiRestoreActivationDockerRunArgs,
  buildWanghaiRestoreActivationVerificationDockerRunArgs,
  buildWanghaiRestoreDockerRunArgs,
  buildWanghaiRestoreRollbackDockerRunArgs,
  buildWanghaiRestoreRollbackVerificationDockerRunArgs,
  parseWanghaiRestoreActivationLog,
  buildWanghaiRestoreVerificationDockerRunArgs,
  parseWanghaiRestoreLog,
  parseWanghaiRestoreRollbackLog,
  resolveWanghaiRestoreSettings,
  wanghaiRestoreActivationContainerName,
  wanghaiRestoreActivationDedupeKey,
  wanghaiRestoreActivationRateLimitBucket,
  wanghaiRestoreContainerName,
  wanghaiRestoreDedupeKey,
  wanghaiRestorePreviousWorkspaceName,
  wanghaiRestoreRateLimitBucket,
  wanghaiRestoreRollbackContainerName,
  wanghaiRestoreRollbackDedupeKey,
  wanghaiRestoreRollbackRateLimitBucket,
  wanghaiRestoreStagingVolumeName,
  type WanghaiRestoreActivationResult,
  type WanghaiRestoreRollbackResult,
  type WanghaiRestoreResult,
} from "./wanghai-restore.js";

const REPO_ROOT = repoRoot(import.meta.url);
const USER_ROOT = polarisUsersRoot(import.meta.url);
const provisionJobs = new Map<string, Promise<void>>();
const statusRefreshJobs = new Map<string, Promise<void>>();
const stopJobs = new Map<string, Promise<void>>();
let durableJobQueueDrain: Promise<void> | null = null;
let durableJobDrainFollowup: Promise<void> | null = null;
let durableJobWorkerSequence = 0;
let durableJobRecoveryTimer: NodeJS.Timeout | null = null;

const DURABLE_JOB_RECOVERY_INTERVAL_MS = 5_000;
const DEFAULT_DURABLE_JOB_LEASE_MS = 60_000;
const MAX_DURABLE_JOB_LEASE_MS = 6 * 60 * 60 * 1_000;

type VaultOperationKind = "create" | "start" | "stop" | "rebuild" | "delete";

function vaultJobKey(userId: string, vault: string): string {
  return `${userId.trim()}:${vault.trim()}`;
}

function provisionStepDelayMs(): number {
  const raw = process.env.POLARIS_TEST_PROVISION_STEP_DELAY_MS?.trim();
  if (!raw) {
    return 0;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function maybeDelayProvisionStep(
  userId: string,
  vault: string,
  phase: string,
): Promise<void> {
  const delayMs = provisionStepDelayMs();
  if (!delayMs) {
    return;
  }
  logInfo("executor", "vault-provision-step-delay", {
    userId,
    vault,
    phase,
    delayMs,
  });
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function rootKey(userId: string, vault: string): string {
  return `${userId}:${vault}`;
}

function provisionJobDedupeKey(userId: string, vault: string): string {
  return `vault-provision:${rootKey(userId, vault)}`;
}

type ProvisionJobOptions = {
  defaultDockerOnly?: boolean;
  startAfterCreate?: boolean;
  line?: "coding" | "vertical";
};

class ProvisionTenantMissingError extends Error {
  constructor(userId: string) {
    super(`Provision tenant '${userId}' no longer exists`);
    this.name = "ProvisionTenantMissingError";
  }
}

function enqueueProvisionJob(
  userId: string,
  vault: string,
  options?: ProvisionJobOptions,
): DurableJob {
  return getPolarisControlStore(import.meta.url).enqueueJob({
    kind: "vault-provision",
    dedupeKey: provisionJobDedupeKey(userId, vault),
    tenantId: userId,
    vaultId: vault,
    payload: {
      defaultDockerOnly: options?.defaultDockerOnly ?? false,
      startAfterCreate: options?.startAfterCreate ?? false,
      ...(options?.line ? { line: options.line } : {}),
    },
  });
}

function durableJobLeaseMs(): number {
  const raw = Number.parseInt(String(process.env.POLARIS_JOB_LEASE_MS ?? ""), 10);
  if (!Number.isFinite(raw)) return DEFAULT_DURABLE_JOB_LEASE_MS;
  return Math.max(DEFAULT_DURABLE_JOB_LEASE_MS, Math.min(MAX_DURABLE_JOB_LEASE_MS, raw));
}

function driverStatusForOperation(kind: VaultOperationKind): NonNullable<VaultStatus["driver"]>["status"] {
  switch (kind) {
    case "create":
      return "creating";
    case "start":
      return "starting";
    case "stop":
      return "stopping";
    case "rebuild":
      return "rebuilding";
    case "delete":
      return "deleting";
  }
}

function buildVaultStatusFromCurrent(args: {
  vault: string;
  current: VaultStatus | null;
  driverState?: Partial<Pick<NonNullable<VaultStatus["driver"]>, "selected" | "status" | "reason">>;
  paseo?: Partial<VaultStatus["paseo"]>;
  driver?: VaultStatus["driver"];
  credentials?: VaultStatus["credentials"];
  details?: VaultStatus["details"];
  evolution?: VaultStatus["evolution"];
  assets?: VaultStatus["assets"];
  attachments?: VaultStatus["attachments"];
  vaultAssembly?: VaultStatus["vaultAssembly"];
}): VaultStatus {
  const currentDriver = args.current?.driver;
  const nextDriver = args.driver ?? currentDriver;
  return {
    schemaVersion: VAULT_STATUS_SCHEMA_VERSION,
    project: args.vault,
    ...(nextDriver
      ? {
          driver: {
            ...nextDriver,
            selected:
              Object.prototype.hasOwnProperty.call(args.driverState ?? {}, "selected")
                ? args.driverState?.selected ?? null
                : currentDriver?.selected ?? nextDriver.selected ?? null,
            status:
              args.driverState?.status
              ?? currentDriver?.status
              ?? nextDriver?.status
              ?? "unknown",
            ...(Object.prototype.hasOwnProperty.call(args.driverState ?? {}, "reason")
              ? { reason: args.driverState?.reason }
              : currentDriver?.reason
                ? { reason: currentDriver.reason }
                : nextDriver?.reason
                  ? { reason: nextDriver.reason }
                  : {}),
          },
        }
      : {}),
    paseo: {
      daemon: args.paseo?.daemon ?? args.current?.paseo?.daemon ?? "unknown",
      web: args.paseo?.web ?? args.current?.paseo?.web ?? "unavailable",
      reconnectMode: args.paseo?.reconnectMode ?? args.current?.paseo?.reconnectMode ?? "unknown",
      ...(Object.prototype.hasOwnProperty.call(args.paseo ?? {}, "liveTarget")
        ? { liveTarget: args.paseo?.liveTarget ?? null }
        : { liveTarget: args.current?.paseo?.liveTarget ?? null }),
      ...(Object.prototype.hasOwnProperty.call(args.paseo ?? {}, "reconnectTarget")
        ? { reconnectTarget: args.paseo?.reconnectTarget ?? null }
        : { reconnectTarget: args.current?.paseo?.reconnectTarget ?? null }),
      ...(Object.prototype.hasOwnProperty.call(args.paseo ?? {}, "reason")
        ? { reason: args.paseo?.reason }
        : args.current?.paseo?.reason
          ? { reason: args.current.paseo.reason }
          : {}),
    },
    credentials: args.credentials ?? args.current?.credentials,
    details: args.details ?? args.current?.details ?? {},
    evolution: args.evolution ?? args.current?.evolution,
    assets: args.assets ?? args.current?.assets,
    attachments: args.attachments ?? args.current?.attachments,
    vaultAssembly: args.vaultAssembly ?? args.current?.vaultAssembly,
  };
}

function portalRoot(userId: string, vault: string): string {
  return path.join(USER_ROOT, userId, "vaults", vault);
}

function clearProvisionState(userId: string, vault: string): void {
  fs.rmSync(path.join(portalRoot(userId, vault), "state", "provision.json"), {
    force: true,
  });
}

function classifyProvisionError(error: unknown): {
  message: string;
  errorCode: string;
  retryable: boolean;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancelled/i.test(message)) {
    return {
      message,
      errorCode: "vault-provision-cancelled",
      retryable: true,
    };
  }
  if (/docker build/i.test(message)) {
    return {
      message,
      errorCode: "image-build-failed",
      retryable: true,
    };
  }
  if (/docker compose|vault .* does not have a selected driver|Image '.*' is not available/i.test(message)) {
    return {
      message,
      errorCode: "vault-runtime-failed",
      retryable: true,
    };
  }
  return {
    message,
    errorCode: "vault-provision-failed",
    retryable: true,
  };
}

function writeDirectVaultStatus(
  userId: string,
  vault: string,
  mutate: (current: VaultStatus | null) => VaultStatus,
): VaultStatus {
  const current = loadVaultSummary(userId, vault).status;
  const next = mutate(current);
  writeVaultStatus(next, userId);
  notifyPortalVaultLiveChange(userId, vault);
  return next;
}

function isStoppedContainerStatusRefreshError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("cannot exec in a stopped state");
}

function writeCachedVaultStatusUpdate(args: {
  userId: string;
  vault: string;
  mutate: (current: VaultStatus | null, summary: PortalVaultDetail | ReturnType<typeof loadVaultSummary>) => VaultStatus | null;
  reason: string;
}): void {
  const summary = loadVaultSummary(args.userId, args.vault);
  const next = args.mutate(summary.status, summary);
  if (!next) {
    return;
  }
  writeVaultStatus(next, args.userId);
  notifyPortalVaultLiveChange(args.userId, args.vault);
  logInfo("executor", "vault-status-cached", {
    userId: args.userId,
    vault: args.vault,
    reason: args.reason,
    runtimeLifecycle: next.driver?.status,
  });
}

function runChecked(
  command: string,
  args: string[],
): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(
      `Failed to execute '${command} ${args.join(" ")}': ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const stdout = stripAnsi(String(result.stdout || "")).trim();
    const stderr = stripAnsi(String(result.stderr || "")).trim();
    const significantStderr = stderr
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^npm notice\b/ui.test(line))
      .filter((line) => !/^npm warn Unknown project config "store-dir"/ui.test(line))
      .join("\n");
    const details = [
      stdout ? `stdout:\n${stdout}` : "",
      significantStderr ? `stderr:\n${significantStderr}` : "",
    ].filter(Boolean).join("\n\n");
    throw new Error(
      details || `Command failed (${result.status ?? 1}): ${command} ${args.join(" ")}`,
    );
  }
  return {
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

function q(value: string): string {
  return JSON.stringify(value);
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/gu, "");
}

async function captureStdout<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string }> {
  const stdoutChunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    stdoutChunks.push(
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString("utf8"),
    );
    const callback = args.find(
      (arg) => typeof arg === "function",
    ) as (() => void) | undefined;
    callback?.();
    return true;
  }) as typeof process.stdout.write;

  try {
    const result = await fn();
    return { result, stdout: stdoutChunks.join("").trim() };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function ensureImageRefAvailable(imageRef: string): void {
  const inspect = spawnSync("docker", ["image", "inspect", imageRef], {
    encoding: "utf8",
  });
  if (inspect.status === 0) {
    return;
  }
  const pull = spawnSync("docker", ["pull", imageRef], { encoding: "utf8" });
  if (pull.status === 0) {
    return;
  }
  throw new Error(`Image '${imageRef}' is not available`);
}

function loadUserVault(
  userId: string,
  vault: string,
  backend: "docker" | "pod" | "kubevirt-vm",
  profileHint?: string,
): VaultSpec {
  const projectRef =
    backend === "pod" && profileHint
      ? `${vault}@${backend}:${profileHint}`
      : `${vault}@${backend}`;
  const ensuredConfig = ensureVaultConfig(projectRef, userId);
  const configPath =
    ensuredConfig?.configPath ?? vaultConfigPath(vault, backend, userId);
  return loadVaultFromConfigPath(
    configPath,
    vault,
    backend,
    profileHint,
  );
}

function runVaultShell(vault: VaultSpec, script: string): { stdout: string; stderr: string } {
  const scope = vaultRuntimeScopeName(
    vault.userProfile.id,
    vault.identity.projectName,
  );
  switch (vault.backend.kind) {
    case "docker":
      return runChecked("docker", [
        "exec",
        `${scope}-docker`,
        "sh",
        "-lc",
        script,
      ]);
    case "pod":
      return runChecked("kubectl", [
        "-n",
        scope,
        "exec",
        `deployment/${scope}`,
        "--",
        "sh",
        "-lc",
        script,
      ]);
    default:
      throw new Error(`Paseo daemon diagnostics are not supported for backend '${vault.backend.kind}' yet`);
  }
}

function listVaultSkillsScript(root: string): string {
  return [
    "set -euo pipefail",
    `if [ ! -d ${q(root)} ]; then exit 0; fi`,
    `find ${q(root)} -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' | sort`,
  ].join("\n");
}

async function listInstalledVaultSkillsResolved(args: {
  vault: VaultSpec;
  harness?: SkillHarness;
}): Promise<Array<{ harness: SkillHarness; skills: string[] }>> {
  const harnesses = args.harness ? [args.harness] : [...SKILL_HARNESSES];
  const runningSupported =
    (args.vault.backend.kind === "docker" || args.vault.backend.kind === "pod");
  if (!runningSupported) {
    const installed = listInstalledVaultSkills(args);
    logInfo("executor", "vault-skill-list-resolved", {
      userId: args.vault.userProfile.id,
      vault: args.vault.identity.projectName,
      backend: args.vault.backend.kind,
      mode: "host-fallback-unsupported-backend",
      installed,
    });
    return installed;
  }
  const observation = await getBackendDriver(args.vault.backend.kind).inspect(args.vault);
  if (!observation.backend.exists || !observation.backend.running) {
    const installed = listInstalledVaultSkills(args);
    logInfo("executor", "vault-skill-list-resolved", {
      userId: args.vault.userProfile.id,
      vault: args.vault.identity.projectName,
      backend: args.vault.backend.kind,
      mode: "host-fallback-not-running",
      backendExists: observation.backend.exists,
      backendRunning: observation.backend.running,
      installed,
    });
    return installed;
  }
  const installed = harnesses.map((harness) => {
    const root = resolveVaultSkillInstallRoot(args.vault, harness);
    const output = runVaultShell(
      args.vault,
      listVaultSkillsScript(root),
    ).stdout;
    const skills = output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith("."))
      .sort((left, right) => left.localeCompare(right));
    return { harness, skills };
  });
  logInfo("executor", "vault-skill-list-resolved", {
    userId: args.vault.userProfile.id,
    vault: args.vault.identity.projectName,
    backend: args.vault.backend.kind,
    mode: "runtime-exec",
    installed,
  });
  return installed;
}

function removeVaultSkillScript(root: string, skillId: string): string {
  const target = path.posix.join(root, skillId);
  return [
    "set -euo pipefail",
    `if [ -d ${q(target)} ]; then`,
    `  rm -rf ${q(target)}`,
    "  printf 'true\\n'",
    "else",
    "  printf 'false\\n'",
    "fi",
  ].join("\n");
}

async function removeInstalledVaultSkillResolved(args: {
  vault: VaultSpec;
  harness: SkillHarness;
  skillId: string;
}): Promise<{ harness: SkillHarness; skillId: string; removed: boolean }> {
  const runningSupported =
    (args.vault.backend.kind === "docker" || args.vault.backend.kind === "pod");
  if (!runningSupported) {
    return removeInstalledVaultSkill(args);
  }
  const observation = await getBackendDriver(args.vault.backend.kind).inspect(args.vault);
  if (!observation.backend.exists || !observation.backend.running) {
    return removeInstalledVaultSkill(args);
  }
  const root = resolveVaultSkillInstallRoot(args.vault, args.harness);
  const output = runVaultShell(
    args.vault,
    removeVaultSkillScript(root, args.skillId),
  ).stdout.trim();
  return {
    harness: args.harness,
    skillId: args.skillId,
    removed: output === "true",
  };
}

function vaultSkillInstallScript(args: {
  vault: VaultSpec;
  harness: SkillHarness;
  packageName: string;
  commandArgs: string[];
  skillId: string;
}): string {
  const installRoot = resolveVaultSkillInstallRoot(args.vault, args.harness);
  const assistantHome = path.posix.dirname(installRoot);
  const installTarget = path.posix.join(installRoot, args.skillId);
  const scratchHome = path.posix.join(
    args.vault.attachments.vaultData.mountRoot,
    ".runtime",
    "skills",
    args.vault.identity.projectName,
    args.harness,
  );
  const commandArgs = materializedSkillCommandArgs(
    args.packageName,
    args.commandArgs,
    args.harness,
  );
  const command = [
    "npx",
    "-y",
    args.packageName,
    ...commandArgs,
  ].map((part) => q(part)).join(" ");
  const directInstall = args.harness === "claude";
  return [
    "set -euo pipefail",
    ...(args.harness === "codex"
      ? [`export CODEX_HOME=${q(assistantHome)}`]
      : [`export CLAUDE_HOME=${q(assistantHome)}`]),
    `export HOME=${q(scratchHome)}`,
    "export npm_config_cache=/tmp/npm-cache",
    `mkdir -p ${q(assistantHome)} ${q(installRoot)} ${q(scratchHome)} /tmp/npm-cache`,
    `cd ${q(scratchHome)}`,
    `rm -f ${q(path.posix.join(scratchHome, "skills-lock.json"))}`,
    `rm -rf ${q(path.posix.join(scratchHome, ".agents", "skills", args.skillId))}`,
    `rm -rf ${q(path.posix.join(scratchHome, ".claude", "skills", args.skillId))}`,
    `rm -rf ${q(installTarget)}`,
    command,
    `rm -f ${q(path.posix.join(scratchHome, "skills-lock.json"))}`,
    ...(directInstall
      ? [`test -d ${q(installTarget)}`]
      : [
        `if [ -d ${q(installTarget)} ]; then exit 0; fi`,
        `for candidate in ${q(path.posix.join(scratchHome, ".agents", "skills", args.skillId))} ${q(path.posix.join(scratchHome, ".claude", "skills", args.skillId))}; do`,
        "  if [ -d \"$candidate\" ]; then",
        `    mkdir -p ${q(installRoot)}`,
        `    cp -a "$candidate" ${q(installTarget)}`,
        "    exit 0",
        "  fi",
        "done",
        `echo "skill install completed but no materialized directory was found for ${args.skillId}" >&2`,
        "exit 1",
      ]),
  ].join("\n");
}

function materializedSkillCommandArgs(
  packageName: string,
  commandArgs: string[],
  harness: SkillHarness,
): string[] {
  if (packageName !== "skills" || commandArgs[0] !== "add") {
    return commandArgs;
  }
  const filtered = commandArgs.filter((arg) => arg !== "--global");
  if (harness !== "claude") {
    return filtered;
  }
  if (filtered.includes("--global")) {
    return filtered;
  }
  return [
    filtered[0] ?? "",
    filtered[1] ?? "",
    "--global",
    ...filtered.slice(2),
  ].filter(Boolean);
}

function vaultSkillInstallDebug(args: {
  vault: VaultSpec;
  harness: SkillHarness;
  packageName: string;
  commandArgs: string[];
  skillId: string;
}): {
  installRoot: string;
  assistantHome: string;
  installTarget: string;
  finalCommandArgs: string[];
  materializationMode: "direct" | "download-copy";
} {
  const installRoot = resolveVaultSkillInstallRoot(args.vault, args.harness);
  const assistantHome = path.posix.dirname(installRoot);
  const installTarget = path.posix.join(installRoot, args.skillId);
  const finalCommandArgs = materializedSkillCommandArgs(
    args.packageName,
    args.commandArgs,
    args.harness,
  );
  return {
    installRoot,
    assistantHome,
    installTarget,
    finalCommandArgs,
    materializationMode: args.harness === "claude" ? "direct" : "download-copy",
  };
}

function assertVaultSkillRuntimeSupported(vault: VaultSpec): void {
  if (vault.backend.kind !== "docker" && vault.backend.kind !== "pod") {
    throw new Error(
      `Vault skill operations are not supported for backend '${vault.backend.kind}'`,
    );
  }
}

async function loadRunningVaultForSkillAction(args: {
  vaultRef: string;
  userProfileId?: string;
}): Promise<VaultSpec> {
  const { vault } = loadVaultForCommand(
    "status",
    args.vaultRef,
    args.userProfileId,
  );
  assertVaultSkillRuntimeSupported(vault);
  const observation = await getBackendDriver(vault.backend.kind).inspect(vault);
  if (!observation.backend.exists || !observation.backend.running) {
    throw new Error(
      `Vault '${vault.identity.projectName}' is not running on ${vault.backend.kind}`,
    );
  }
  return vault;
}

function mutateVaultSkillStatus(args: {
  userId: string;
  vault: string;
  reason: string;
  installed: Array<{ harness: SkillHarness; skills: string[] }>;
}): void {
  writeCachedVaultStatusUpdate({
    userId: args.userId,
    vault: args.vault,
    reason: args.reason,
    mutate: (current, summary) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        skills: {
          installedByHarness: Object.fromEntries(
            args.installed.map((entry) => [entry.harness, entry.skills]),
          ),
          source: "vault-runtime-state",
        },
      } as VaultStatus & {
        skills: {
          installedByHarness: Record<string, string[]>;
          source: string;
        };
      };
    },
  });
}

function collectVaultPaseoDiagnostic(
  userId: string,
  vault: string,
): PortalVaultPaseoDiagnostic {
  const summary = loadVaultSummary(userId, vault);
  const target = summary.status?.driver?.selected ?? null;
  if (!target) {
    throw new Error(`Vault '${vault}' does not have a selected driver`);
  }
  const loaded = loadPortalVaultByTarget(userId, vault, target);
  const daemonStatusRaw = runVaultShell(
    loaded,
    "PASEO_HOME=/root/.paseo paseo daemon status --json --home /root/.paseo",
  ).stdout.trim();
  const daemonStatus = parsePaseoDaemonStatus(daemonStatusRaw);
  return {
    daemonStatusRaw,
    daemonStatus,
  };
}

function liveRuntimeCredentialFiles(
  vault: VaultSpec,
  userId: string,
  credentialId: string,
  requestedHarness?: ManagedHarness,
  requireSupported = false,
): {
  harness: ManagedHarness;
  files: Array<{ path: string; content: string }>;
} {
  const record = readManagedCredentialRecord({
    userProfileId: userId,
    credentialId,
  });
  if (requestedHarness && record.summary.harness !== requestedHarness) {
    throw new Error(
      `Credential '${credentialId}' belongs to harness '${record.summary.harness}', not '${requestedHarness}'`,
    );
  }
  if (
    requireSupported
    && !supportsLiveCredentialSwitch(record.summary.harness)
  ) {
    throw new Error(
      `Credential '${credentialId}' does not support live runtime switching`,
    );
  }
  const files = record.files.map((file) => {
    const mountPath =
      file.mountPath?.trim()
      || defaultMountPathForCredentialFile(
        record.summary.kind,
        vault.runtime.home,
        file.key,
      );
    const targetPath = stateStoragePathForMountPath({
      mountPath,
      runtimeHome: vault.runtime.home,
      identityRoot: vault.attachments.userIdentityState.mountRoot,
    });
    if (
      !targetPath
      || !targetPath.startsWith(
        `${vault.attachments.userIdentityState.mountRoot}/`,
      )
    ) {
      throw new Error(
        `Credential '${credentialId}' file '${file.key}' does not map into vault identity state`,
      );
    }
    return {
      path: targetPath,
      content: file.content,
    };
  });
  if (files.length === 0) {
    throw new Error(
      `Credential '${credentialId}' does not contain live runtime material files`,
    );
  }
  return {
    harness: record.summary.harness,
    files,
  };
}

function runtimeWriteScript(
  vault: VaultSpec,
  files: Array<{ path: string; content: string }>,
): string {
  const payload = JSON.stringify(
    files.map((file) => ({
      path: file.path,
      content: Buffer.from(file.content, "utf8").toString("base64"),
    })),
  );
  const runtimeUser = vault.runtime.user.trim() || "root";
  return [
    "python3 - <<'PY'",
    "import base64, json, os, pathlib, pwd, stat",
    `files = json.loads(${JSON.stringify(payload)})`,
    `runtime_user = ${JSON.stringify(runtimeUser)}`,
    "uid = gid = None",
    "if runtime_user and runtime_user != 'root':",
    "    try:",
    "        account = pwd.getpwnam(runtime_user)",
    "        uid = account.pw_uid",
    "        gid = account.pw_gid",
    "    except KeyError:",
    "        uid = gid = None",
    "",
    "def is_ssh_path(path: pathlib.Path) -> bool:",
    "    return 'ssh' in path.parts",
    "",
    "def desired_mode(path: pathlib.Path) -> int:",
    "    name = path.name",
    "    if name.endswith('.pub'):",
    "        return stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH",
    "    if name in {'authorized_keys', 'known_hosts', 'known_hosts.old'}:",
    "        return stat.S_IRUSR | stat.S_IWUSR",
    "    if is_ssh_path(path):",
    "        return stat.S_IRUSR | stat.S_IWUSR",
    "    return stat.S_IRUSR | stat.S_IWUSR",
    "",
    "for entry in files:",
    "    path = pathlib.Path(entry['path'])",
    "    path.parent.mkdir(parents=True, exist_ok=True)",
    "    if is_ssh_path(path):",
    "        path.parent.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)",
    "    path.write_bytes(base64.b64decode(entry['content']))",
    "    if uid is not None and gid is not None:",
    "        try:",
    "            os.chown(path.parent, uid, gid)",
    "        except FileNotFoundError:",
    "            pass",
    "        os.chown(path, uid, gid)",
    "    path.chmod(desired_mode(path))",
    "PY",
  ].join("\n");
}

function dockerContainerName(vault: VaultSpec): string {
  return `${vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName)}-docker`;
}

function runtimeScope(vault: VaultSpec): string {
  return vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName);
}

function runningPodName(vault: VaultSpec): string {
  return runChecked(
    "kubectl",
    [
      "-n",
      runtimeScope(vault),
      "get",
      "pod",
      "-l",
      `app=${runtimeScope(vault)}`,
      "-o",
      "jsonpath={.items[0].metadata.name}",
    ],
  ).stdout.trim();
}

function applyLiveRuntimeFiles(
  vault: VaultSpec,
  files: Array<{ path: string; content: string }>,
): void {
  const script = runtimeWriteScript(vault, files);
  if (vault.backend.kind === "docker") {
    const containerName = dockerContainerName(vault);
    runChecked("docker", ["exec", containerName, "sh", "-lc", script]);
    return;
  }
  if (vault.backend.kind === "pod") {
    const podName = runningPodName(vault);
    if (!podName) {
      throw new Error(
        `Vault '${vault.identity.projectName}' does not have a running pod`,
      );
    }
    runChecked(
      "kubectl",
      [
        "-n",
        runtimeScope(vault),
        "exec",
        podName,
        "--",
        "sh",
        "-lc",
        script,
      ],
    );
    return;
  }
  throw new Error(
    `Live credential switching is not supported for backend '${vault.backend.kind}'`,
  );
}

export function switchVaultLiveCredentialMaterial(input: {
  vault: VaultSpec;
  userId: string;
  credentialId: string;
  harness?: ManagedHarness;
  requireSupported?: boolean;
}): {
  harness: ManagedHarness;
  credentialId: string;
} {
  const resolved = liveRuntimeCredentialFiles(
    input.vault,
    input.userId,
    input.credentialId,
    input.harness,
    input.requireSupported ?? false,
  );
  applyLiveRuntimeFiles(input.vault, resolved.files);
  writeVaultLiveCredentialSelection(
    input.vault.identity.projectName,
    resolved.harness,
    input.credentialId,
    input.userId,
  );
  return {
    harness: resolved.harness,
    credentialId: input.credentialId,
  };
}

export async function listVaultSkills(input: {
  vaultRef: string;
  userProfileId?: string;
  harness?: SkillHarness;
}): Promise<{
  vault: string;
  userId: string;
  installed: Array<{ harness: SkillHarness; skills: string[] }>;
}> {
  const { vault } = loadVaultForCommand(
    "status",
    input.vaultRef,
    input.userProfileId,
  );
  const installed = await listInstalledVaultSkillsResolved({
    vault,
    ...(input.harness ? { harness: input.harness } : {}),
  });
  return {
    vault: vault.identity.projectName,
    userId: vault.userProfile.id,
    installed,
  };
}

export async function skillInstallVault(input: {
  vaultRef: string;
  userProfileId?: string;
  harness: SkillHarness;
  skillId: string;
}): Promise<{
  installed: true;
  vault: string;
  userId: string;
  harness: SkillHarness;
  skillId: string;
  packageName: string;
}> {
  const vault = await loadRunningVaultForSkillAction(input);
  const skill = readUserSkill(vault.userProfile.id, input.skillId);
  if (skill.harness !== input.harness) {
    throw new Error(
      `Skill '${input.skillId}' belongs to harness '${skill.harness}', not '${input.harness}'`,
    );
  }
  const debug = vaultSkillInstallDebug({
    vault,
    harness: input.harness,
    packageName: skill.packageName,
    commandArgs: skill.args,
    skillId: skill.id,
  });
  logInfo("executor", "vault-skill-install-command", {
    userId: vault.userProfile.id,
    vault: vault.identity.projectName,
    harness: input.harness,
    skillId: skill.id,
    packageName: skill.packageName,
    source: skill.source,
    selectedSkillName: skill.selectedSkillName,
    originalArgs: skill.args,
    finalArgs: debug.finalCommandArgs,
    materializationMode: debug.materializationMode,
    assistantHome: debug.assistantHome,
    installRoot: debug.installRoot,
    installTarget: debug.installTarget,
  });
  runVaultShell(
    vault,
    vaultSkillInstallScript({
      vault,
      harness: input.harness,
      packageName: skill.packageName,
      commandArgs: skill.args,
      skillId: skill.id,
    }),
  );
  const installed = await listInstalledVaultSkillsResolved({
    vault,
    harness: input.harness,
  });
  mutateVaultSkillStatus({
    userId: vault.userProfile.id,
    vault: vault.identity.projectName,
    reason: "vault-skill-installed",
    installed,
  });
  return {
    installed: true,
    vault: vault.identity.projectName,
    userId: vault.userProfile.id,
    harness: input.harness,
    skillId: skill.id,
    packageName: skill.packageName,
  };
}

export async function skillUninstallVault(input: {
  vaultRef: string;
  userProfileId?: string;
  harness: SkillHarness;
  skillId: string;
}): Promise<{
  uninstalled: true;
  vault: string;
  userId: string;
  harness: SkillHarness;
  skillId: string;
  removed: boolean;
}> {
  const vault = await loadRunningVaultForSkillAction(input);
  const removed = await removeInstalledVaultSkillResolved({
    vault,
    harness: input.harness,
    skillId: input.skillId,
  });
  const installed = await listInstalledVaultSkillsResolved({
    vault,
    harness: input.harness,
  });
  mutateVaultSkillStatus({
    userId: vault.userProfile.id,
    vault: vault.identity.projectName,
    reason: "vault-skill-uninstalled",
    installed,
  });
  return {
    uninstalled: true,
    vault: vault.identity.projectName,
    userId: vault.userProfile.id,
    harness: input.harness,
    skillId: input.skillId,
    removed: removed.removed,
  };
}

export async function skillSyncVault(input: {
  vaultRef: string;
  userProfileId?: string;
  harness: SkillHarness;
}): Promise<{
  synced: true;
  vault: string;
  userId: string;
  harness: SkillHarness;
  installed: string[];
  removed: string[];
}> {
  const vault = await loadRunningVaultForSkillAction(input);
  const declared = listUserSkills(vault.userProfile.id)
    .filter((skill) => skill.harness === input.harness);
  const installedState = (await listInstalledVaultSkillsResolved({
    vault,
    harness: input.harness,
  }))[0];
  const installedIds = new Set(installedState?.skills ?? []);
  const declaredIds = new Set(declared.map((skill) => skill.id));
  const installedNow: string[] = [];
  const removedNow: string[] = [];

  for (const skill of declared) {
    if (installedIds.has(skill.id)) {
      continue;
    }
    const debug = vaultSkillInstallDebug({
      vault,
      harness: input.harness,
      packageName: skill.packageName,
      commandArgs: skill.args,
      skillId: skill.id,
    });
    logInfo("executor", "vault-skill-sync-install-command", {
      userId: vault.userProfile.id,
      vault: vault.identity.projectName,
      harness: input.harness,
      skillId: skill.id,
      packageName: skill.packageName,
      source: skill.source,
      selectedSkillName: skill.selectedSkillName,
      originalArgs: skill.args,
      finalArgs: debug.finalCommandArgs,
      materializationMode: debug.materializationMode,
      assistantHome: debug.assistantHome,
      installRoot: debug.installRoot,
      installTarget: debug.installTarget,
    });
    runVaultShell(
      vault,
      vaultSkillInstallScript({
        vault,
        harness: input.harness,
        packageName: skill.packageName,
        commandArgs: skill.args,
        skillId: skill.id,
      }),
    );
    installedNow.push(skill.id);
  }

  for (const skillId of installedIds) {
    if (declaredIds.has(skillId)) {
      continue;
    }
    await removeInstalledVaultSkillResolved({
      vault,
      harness: input.harness,
      skillId,
    });
    removedNow.push(skillId);
  }

  const installed = await listInstalledVaultSkillsResolved({
    vault,
    harness: input.harness,
  });
  mutateVaultSkillStatus({
    userId: vault.userProfile.id,
    vault: vault.identity.projectName,
    reason: "vault-skill-synced",
    installed,
  });
  return {
    synced: true,
    vault: vault.identity.projectName,
    userId: vault.userProfile.id,
    harness: input.harness,
    installed: installedNow,
    removed: removedNow,
  };
}

function renderVaultTargets(
  userId: string,
  vault: string,
  defaultDockerOnly = false,
): void {
  const dockerVault = loadUserVault(userId, vault, "docker");
  renderAndWriteDockerVault(dockerVault);
  if (defaultDockerOnly) {
    return;
  }
  const podVault = loadUserVault(
    userId,
    vault,
    "pod",
    "gvisor",
  );
  renderAndWritePodVault(podVault);
  const kubevirtVault = loadUserVault(
    userId,
    vault,
    "kubevirt-vm",
  );
  renderAndWriteKubevirtVault(kubevirtVault);
}

function renderVaultTarget(
  userId: string,
  vault: string,
  target: PortalDriverTarget,
): void {
  if (target.backend === "docker") {
    renderAndWriteDockerVault(loadUserVault(userId, vault, "docker"));
    return;
  }
  if (target.backend === "pod") {
    renderAndWritePodVault(
      loadUserVault(userId, vault, "pod", target.profile ?? "gvisor"),
    );
    return;
  }
  renderAndWriteKubevirtVault(
    loadUserVault(userId, vault, "kubevirt-vm"),
  );
}

async function shouldRecycleRunningVault(
  userId: string,
  vault: string,
  target: PortalDriverTarget,
): Promise<boolean> {
  const loaded = loadUserVault(
    userId,
    vault,
    target.backend,
    target.profile,
  );
  const observation = await getBackendDriver(loaded.backend.kind).inspect(loaded);
  return Boolean(observation.backend.exists && observation.backend.running);
}

function ensureVaultImageTargets(
  userId: string,
  vault: string,
  defaultDockerOnly = false,
): void {
  ensureCanonicalVaultImage(`${vault}@docker`, userId);
  if (defaultDockerOnly) {
    return;
  }
  ensureCanonicalVaultImage(`${vault}@pod:gvisor`, userId);
  ensureCanonicalVaultImage(`${vault}@kubevirt-vm`, userId);
  const kubevirtVault = loadUserVault(
    userId,
    vault,
    "kubevirt-vm",
  );
  ensureImageRefAvailable(
    kubevirtVault.runtime.rootdiskImage ??
      "quay.io/containerdisks/debian:13",
  );
}

function ensureVaultTargetSpecs(
  userId: string,
  vault: string,
  defaultDockerOnly = false,
): void {
  fs.mkdirSync(portalRoot(userId, vault), { recursive: true });
  ensureVaultConfig(`${vault}@docker`, userId);
  if (!defaultDockerOnly) {
    ensureVaultConfig(`${vault}@pod:gvisor`, userId);
    ensureVaultConfig(`${vault}@kubevirt-vm`, userId);
  }
}

async function provisionVaultInternal(
  userId: string,
  vault: string,
  options?: {
    defaultDockerOnly?: boolean;
    startAfterCreate?: boolean;
    line?: "coding" | "vertical";
    isCancelled?: () => boolean;
  },
): Promise<void> {
  return withVaultMutationLock(
    import.meta.url,
    userId,
    vault,
    async () => {
      const defaultDockerOnly = options?.defaultDockerOnly ?? false;
      const startAfterCreate = options?.startAfterCreate ?? false;
      const ensureNotCancelled = () => {
        if (options?.isCancelled?.()) {
          throw new Error("vault provision cancelled");
        }
      };
      if (!userProfileExists(userId)) {
        throw new ProvisionTenantMissingError(userId);
      }
      ensureNotCancelled();
      writeDirectVaultStatus(userId, vault, (current) => buildVaultStatusFromCurrent({
        vault,
        current,
        driverState: {
          selected: null,
          status: driverStatusForOperation("create"),
          reason: "vault creation in progress",
        },
      }));
      if (!fs.existsSync(vaultConfigPath(vault, "docker", userId))) {
        await createVaultForUser(vault, userId, options?.line ? { line: options.line } : undefined);
      }
      await maybeDelayProvisionStep(userId, vault, "specs");
      ensureNotCancelled();
      ensureVaultTargetSpecs(userId, vault, defaultDockerOnly);
      await maybeDelayProvisionStep(userId, vault, "images");
      ensureNotCancelled();
      ensureVaultImageTargets(userId, vault, defaultDockerOnly);
      await maybeDelayProvisionStep(userId, vault, "manifests");
      ensureNotCancelled();
      renderVaultTargets(userId, vault, defaultDockerOnly);
      await maybeDelayProvisionStep(userId, vault, "status");
      ensureNotCancelled();
      await captureStdout(() => statusCommand(`${vault}@docker`, userId));
      const summary = loadVaultSummary(userId, vault);
      if ((summary.status?.driver?.selected ?? null) === null) {
        await maybeDelayProvisionStep(userId, vault, "selection");
      }

      if (startAfterCreate) {
        await maybeDelayProvisionStep(userId, vault, "start");
        ensureNotCancelled();
        writeDirectVaultStatus(userId, vault, (current) => buildVaultStatusFromCurrent({
          vault,
          current,
          driver: current?.driver,
          driverState: {
            selected: current?.driver?.selected ?? summary.status?.driver?.selected ?? { backend: "docker" },
            status: driverStatusForOperation("start"),
            reason: "vault start requested",
          },
        }));
        await startCommand(`${vault}@docker`, userId);
      }
      await maybeDelayProvisionStep(userId, vault, "finalize");
      ensureNotCancelled();
      // Without a start transition, no runtime state changes after the first
      // status synthesis, so avoid paying for a duplicate backend inspection.
      if (startAfterCreate) {
        const finalRef = vaultRefFromTarget(
          vault,
          summary.status?.driver?.selected ?? { backend: "docker" },
        );
        await captureStdout(() => statusCommand(finalRef, userId));
      }
    },
  );
}

async function startVaultWithoutWait(
  projectRef: string,
  userProfileId?: string,
): Promise<void> {
  const { vault, driver } = await loadExecutableVaultForCommand(
    "start",
    projectRef,
    userProfileId,
  );
  await driver.start(vault);
}

export async function refreshPortalVaultStatus(
  userId: string,
  vault: string,
): Promise<void> {
  const key = rootKey(userId, vault);
  const existing = statusRefreshJobs.get(key);
  if (existing) {
    return existing;
  }
  const job = (async () => {
    const summary = loadVaultSummary(userId, vault);
    const selectedDriver = summary.status?.driver?.selected ?? null;
    if (!selectedDriver) {
      logVaultEvent("warn", "status-refresh-skipped", {
        userId,
        vault,
      }, {
        reason: "no-selected-driver",
      });
      return;
    }
    const ref = vaultRefFromTarget(vault, selectedDriver);
    if (!ref) {
      throw new Error(`Vault '${vault}' does not have a selected driver`);
    }
    logVaultEvent("info", "status-refresh-requested", {
      userId,
      vault,
      ref,
    });
    try {
      await measureVaultPhase({
        context: {
          userId,
          vault,
          ref,
          backend: selectedDriver.backend,
          profile: selectedDriver.profile,
        },
        phase: "status-refresh",
        execute: () => captureStdout(() => statusCommand(ref, userId)),
      });
      logVaultEvent("info", "status-refresh-completed", {
        userId,
        vault,
        ref,
      });
    } catch (error) {
      logVaultEvent("warn", "status-refresh-failed", {
        userId,
        vault,
        ref,
      }, {
        reason: error instanceof Error ? error.message : String(error),
      });
      if (isStoppedContainerStatusRefreshError(error)) {
        writeDirectVaultStatus(userId, vault, (current) => buildVaultStatusFromCurrent({
          vault,
          current,
          driverState: {
            selected: current?.driver?.selected ?? null,
            status: "stopped",
            reason: "vault is stopped",
          },
        }));
        logVaultEvent("info", "status-refresh-coerced-stopped", {
          userId,
          vault,
          ref,
        });
      }
    } finally {
      statusRefreshJobs.delete(key);
    }
  })();
  statusRefreshJobs.set(key, job);
  return job;
}

export async function updatePortalVaultSelectedDriver(input: {
  userId: string;
  vault: string;
  target: PortalDriverTarget;
}): Promise<{ updated: true }> {
  writeDirectVaultStatus(
    input.userId,
    input.vault,
    (current) => buildVaultStatusFromCurrent({
      vault: input.vault,
      current,
      driver: current?.driver ?? {
        selected: null,
        status: "unknown",
      },
      driverState: {
        selected: input.target,
      },
    }),
  );
  logVaultEvent("info", "vault-selected-driver-updated", {
    userId: input.userId,
    vault: input.vault,
  }, {
    backend: input.target.backend,
    profile: input.target.profile,
  });
  return { updated: true };
}

export async function queueProvisionVault(
  userId: string,
  vault: string,
  options?: ProvisionJobOptions,
): Promise<{ queued: true; vault: string }> {
  return withUserMutationLock(import.meta.url, userId, async () => {
    if (!userProfileExists(userId)) {
      throw new Error(`User profile '${userId}' was not found. Create it first with user create.`);
    }
    const key = rootKey(userId, vault);
    const existing = provisionJobs.get(key);
    if (existing) {
      logInfo("executor", "vault-provision-queue-reused", {
        userId,
        vault,
      });
      return { queued: true, vault };
    }
    const store = getPolarisControlStore(import.meta.url);
    const existingDurable = store.getJobByDedupeKey(provisionJobDedupeKey(userId, vault));
    if (existingDurable?.status === "queued" || existingDurable?.status === "running") {
      logInfo("executor", "vault-provision-queue-reused", {
        userId,
        vault,
        jobId: existingDurable.id,
      });
      void resumeDurableVaultJobs();
      return { queued: true, vault };
    }
    if (existingDurable?.status === "failed" && existingDurable.cancelRequested) {
      throw new Error(`Vault '${vault}' provision was cancelled; remove it before retrying.`);
    }
    if (
      existingDurable?.status === "failed"
      && existingDurable.attempts >= existingDurable.maxAttempts
    ) {
      throw new Error(`Vault '${vault}' provision exhausted its retry budget.`);
    }
    assertProjectNameAvailableForUser(vault, userId);
    if (vaultConfigExists(vault, userId) && !existingDurable) {
      throw new Error(`Vault '${vault}' already exists for user ${userId}.`);
    }
    const durableJob = enqueueProvisionJob(userId, vault, options);
    clearProvisionState(userId, vault);
    logInfo("executor", "vault-provision-queued", {
      userId,
      vault,
      jobId: durableJob.id,
      defaultDockerOnly: options?.defaultDockerOnly ?? false,
      startAfterCreate: options?.startAfterCreate ?? false,
      line: options?.line ?? "coding",
    });
    void resumeDurableVaultJobs();
    return { queued: true, vault };
  });
}

export function startProvisionVault(
  userId: string,
  vault: string,
  options?: ProvisionJobOptions,
): Promise<void> {
  const key = rootKey(userId, vault);
  const existing = provisionJobs.get(key);
  if (existing) {
    return existing;
  }
  const job = enqueueProvisionJob(userId, vault, options);
  const drain = resumeDurableVaultJobs();
  if (job.status === "failed" && job.cancelRequested) {
    return Promise.reject(new Error("vault provision was cancelled"));
  }
  return provisionJobs.get(key) ?? drain;
}

export function requestProvisionCancellation(userId: string, vault: string): boolean {
  const store = getPolarisControlStore(import.meta.url);
  const requested = store.requestJobCancellation(provisionJobDedupeKey(userId, vault));
  store.recordAudit({
    actorId: userId,
    tenantId: userId,
    vaultId: vault,
    action: "vault.provision.cancel",
    outcome: requested ? "success" : "denied",
    metadata: { requested },
  });
  return requested;
}

const MAX_BACKUP_PROCESS_OUTPUT_BYTES = 16 * 1024;

interface DockerCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

interface DockerBackupContainerState {
  running: boolean;
  exitCode: number | null;
}

interface WanghaiBackupContainerSuccess {
  result: WanghaiBackupResult;
  containerName: string;
}

interface WanghaiRestoreContainerSuccess {
  result: WanghaiRestoreResult;
  containerName: string;
}

interface WanghaiRestoreActivationContainerSuccess {
  result: WanghaiRestoreActivationResult;
  containerName: string;
}

interface WanghaiRestoreRollbackContainerSuccess {
  result: WanghaiRestoreRollbackResult;
  containerName: string;
}

class WanghaiBackupContainerError extends WanghaiBackupError {
  constructor(
    code: string,
    message: string,
    retryable: boolean,
    readonly cleanupContainer: boolean,
  ) {
    super(code, message, retryable);
    this.name = "WanghaiBackupContainerError";
  }
}

class WanghaiRestoreContainerError extends WanghaiRestoreError {
  constructor(
    code: string,
    message: string,
    retryable: boolean,
    readonly cleanupContainer: boolean,
    readonly cleanupStagingVolume: boolean,
  ) {
    super(code, message, retryable);
    this.name = "WanghaiRestoreContainerError";
  }
}

class WanghaiRestoreLifecycleContainerError extends WanghaiRestoreError {
  constructor(
    code: string,
    message: string,
    retryable: boolean,
    readonly cleanupContainer: boolean,
  ) {
    super(code, message, retryable);
    this.name = "WanghaiRestoreLifecycleContainerError";
  }
}

function appendBoundedBackupOutput(current: string, chunk: Buffer): string {
  const combined = Buffer.concat([Buffer.from(current, "utf8"), chunk]);
  return combined.subarray(Math.max(0, combined.length - MAX_BACKUP_PROCESS_OUTPUT_BYTES)).toString("utf8");
}

function startDockerCapture(args: string[]): {
  completion: Promise<DockerCommandResult>;
  terminate: () => void;
} {
  const child = spawn("docker", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const completion = new Promise<DockerCommandResult>((resolve) => {
    let settled = false;
    const finish = (result: DockerCommandResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendBoundedBackupOutput(stdout, Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendBoundedBackupOutput(stderr, Buffer.from(chunk));
    });
    child.once("error", (error) => {
      finish({ status: null, stdout, stderr, error });
    });
    child.once("close", (status) => {
      finish({ status, stdout, stderr });
    });
  });
  return {
    completion,
    terminate: () => {
      child.kill("SIGTERM");
    },
  };
}

async function runDockerCapture(args: string[]): Promise<DockerCommandResult> {
  return startDockerCapture(args).completion;
}

function dockerResultIsNotFound(result: DockerCommandResult): boolean {
  return /no such (?:container|object|volume)/iu.test(`${result.stdout}\n${result.stderr}`);
}

function parseDockerContainerState(output: string): DockerBackupContainerState {
  const parsed = JSON.parse(output) as unknown;
  const state = Array.isArray(parsed)
    ? parsed[0]?.State
    : parsed;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("missing Docker state");
  }
  const record = state as Record<string, unknown>;
  const rawExitCode = record.ExitCode;
  const exitCode = typeof rawExitCode === "number" && Number.isSafeInteger(rawExitCode)
    ? rawExitCode
    : null;
  return {
    running: record.Running === true || record.Status === "running",
    exitCode,
  };
}

async function inspectWanghaiBackupContainer(
  containerName: string,
): Promise<DockerBackupContainerState | null> {
  const result = await runDockerCapture([
    "inspect",
    "--format",
    "{{json .State}}",
    containerName,
  ]);
  if (result.status !== 0) {
    if (dockerResultIsNotFound(result)) return null;
    throw new WanghaiBackupContainerError(
      "backup-container-inspect-failed",
      "Unable to inspect the Wanghai backup container",
      true,
      false,
    );
  }
  try {
    return parseDockerContainerState(result.stdout);
  } catch {
    throw new WanghaiBackupContainerError(
      "backup-container-inspect-invalid",
      "Wanghai backup container inspection returned invalid state",
      true,
      false,
    );
  }
}

async function stopWanghaiBackupContainer(containerName: string): Promise<void> {
  const stopped = await runDockerCapture(["stop", "--time", "10", containerName]);
  if (stopped.status === 0 || dockerResultIsNotFound(stopped)) return;
  await runDockerCapture(["kill", containerName]);
}

async function waitForWanghaiBackupDockerCommand(input: {
  args: string[];
  containerName: string;
  timeoutMs: number;
  isCancelled: () => boolean;
}): Promise<{ result: DockerCommandResult; cancelled: boolean; timedOut: boolean }> {
  const command = startDockerCapture(input.args);
  let cancellationRequested = input.isCancelled();
  let timedOut = false;
  let interruption: Promise<void> | null = null;
  let terminateTimer: NodeJS.Timeout | null = null;
  const interrupt = (): void => {
    if (interruption) return;
    interruption = stopWanghaiBackupContainer(input.containerName).catch(() => {
      // The final inspect determines whether the container was actually stopped.
    });
  };
  if (cancellationRequested) {
    interrupt();
  }
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (input.isCancelled()) {
      cancellationRequested = true;
      interrupt();
      return;
    }
    if (Date.now() - startedAt >= input.timeoutMs) {
      timedOut = true;
      interrupt();
      if (!terminateTimer) {
        terminateTimer = setTimeout(() => {
          command.terminate();
        }, 15_000);
        terminateTimer.unref();
      }
    }
  }, 1_000);
  timer.unref();
  const result = await command.completion;
  clearInterval(timer);
  if (terminateTimer) clearTimeout(terminateTimer);
  if (interruption) {
    await interruption;
  }
  return { result, cancelled: cancellationRequested, timedOut };
}

function hasWanghaiSurface(vault: VaultSpec): boolean {
  return vault.connectivity.servicePorts.some((port) => (
    port.name?.toLowerCase() === "wanghai" || port.containerPort === "9090"
  ));
}

function resolveWanghaiBackupVault(userId: string, vault: string): VaultSpec {
  const target = readVaultStatus(userId, vault)?.driver?.selected;
  if (!target) {
    throw new WanghaiBackupError(
      "backup-runtime-unavailable",
      "Wanghai backup requires a selected vault runtime",
      false,
    );
  }
  let spec: VaultSpec;
  try {
    spec = loadPortalVaultByTarget(userId, vault, target);
  } catch {
    throw new WanghaiBackupError(
      "backup-runtime-unavailable",
      "Wanghai backup could not resolve the selected vault runtime",
      false,
    );
  }
  if (
    spec.userProfile.id !== userId
    || spec.identity.projectName !== vault
  ) {
    throw new WanghaiBackupError(
      "backup-runtime-unavailable",
      "Wanghai backup selected vault identity does not match the durable job",
      false,
    );
  }
  if (spec.backend.kind !== "docker") {
    throw new WanghaiBackupError(
      "backup-backend-unsupported",
      "Wanghai backup is currently supported only for the selected Docker runtime",
      false,
    );
  }
  if (!hasWanghaiSurface(spec) || spec.attachments.vaultData.mountRoot !== "/vault/project") {
    throw new WanghaiBackupError(
      "backup-surface-unavailable",
      "The selected vault does not provide the integrated Wanghai backup surface",
      false,
    );
  }
  return spec;
}

function resolveWanghaiRestoreVault(userId: string, vault: string): VaultSpec {
  const target = readVaultStatus(userId, vault)?.driver?.selected;
  if (!target) {
    throw new WanghaiRestoreError(
      "restore-runtime-unavailable",
      "Wanghai restore requires a selected vault runtime",
      false,
    );
  }
  let spec: VaultSpec;
  try {
    spec = loadPortalVaultByTarget(userId, vault, target);
  } catch {
    throw new WanghaiRestoreError(
      "restore-runtime-unavailable",
      "Wanghai restore could not resolve the selected vault runtime",
      false,
    );
  }
  if (
    spec.userProfile.id !== userId
    || spec.identity.projectName !== vault
  ) {
    throw new WanghaiRestoreError(
      "restore-runtime-unavailable",
      "Wanghai restore selected vault identity does not match the durable job",
      false,
    );
  }
  if (spec.backend.kind !== "docker") {
    throw new WanghaiRestoreError(
      "restore-backend-unsupported",
      "Wanghai restore is currently supported only for the selected Docker runtime",
      false,
    );
  }
  if (!hasWanghaiSurface(spec) || spec.attachments.vaultData.mountRoot !== "/vault/project") {
    throw new WanghaiRestoreError(
      "restore-surface-unavailable",
      "The selected vault does not provide the integrated Wanghai restore surface",
      false,
    );
  }
  return spec;
}

async function withStoppedWanghaiRestoreVault<T>(input: {
  tenantId: string;
  vaultId: string;
  execute: () => Promise<T>;
}): Promise<T> {
  const selected = readVaultStatus(input.tenantId, input.vaultId)?.driver?.selected;
  if (!selected) {
    throw new WanghaiRestoreError(
      "restore-runtime-unavailable",
      "Wanghai restore requires a selected vault runtime",
      false,
    );
  }
  const ref = vaultRefFromTarget(input.vaultId, selected);
  let stopped = false;
  let operationError: unknown;
  try {
    await stopCommand(ref, input.tenantId);
    stopped = true;
    await refreshPortalVaultStatus(input.tenantId, input.vaultId);
    return await input.execute();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (stopped) {
      try {
        await startCommand(ref, input.tenantId);
        await refreshPortalVaultStatus(input.tenantId, input.vaultId);
      } catch (startError) {
        if (operationError) {
          logError("executor", "wanghai-restore-lifecycle-start-failed", {
            tenantId: input.tenantId,
            vaultId: input.vaultId,
            error: startError instanceof Error ? startError.message : String(startError),
          });
        } else {
          throw startError;
        }
      }
    }
  }
}

function durableJobActorId(job: DurableJob, tenantId: string): string {
  const actor = String(job.payload.actorId ?? "").trim();
  return actor || tenantId;
}

function resolveWanghaiRestoreSource(input: {
  tenantId: string;
  vaultId: string;
  sourceBackupJobId: string;
}): { sourceBackupJobId: string; archiveName: string } {
  const sourceBackupJobId = input.sourceBackupJobId.trim();
  if (!sourceBackupJobId) {
    throw new WanghaiRestoreError(
      "restore-source-invalid",
      "Wanghai restore requires a completed source backup job",
      false,
    );
  }
  const backup = getWanghaiBackupJob({
    tenantId: input.tenantId,
    vaultId: input.vaultId,
    jobId: sourceBackupJobId,
  });
  if (!backup || backup.status !== "succeeded") {
    throw new WanghaiRestoreError(
      "restore-source-unavailable",
      "Wanghai restore source backup is unavailable",
      false,
    );
  }
  const archiveName = typeof backup.result?.archiveName === "string"
    ? backup.result.archiveName.trim()
    : "";
  const checksumVerified = backup.result?.checksumVerified === true;
  const expectedArchiveName = wanghaiBackupArchiveName({
    tenantId: input.tenantId,
    vaultId: input.vaultId,
    jobId: backup.id,
  });
  if (!checksumVerified || archiveName !== expectedArchiveName) {
    throw new WanghaiRestoreError(
      "restore-source-invalid",
      "Wanghai restore source backup is invalid",
      false,
    );
  }
  return { sourceBackupJobId: backup.id, archiveName };
}

function resolveWanghaiRestoreActivationSource(input: {
  tenantId: string;
  vaultId: string;
  restoreJobId: string;
  vault: VaultSpec;
}): {
  restoreJobId: string;
  sourceBackupJobId: string;
  archiveName: string;
  stagingVolume: string;
} {
  const restoreJobId = input.restoreJobId.trim();
  const restore = getWanghaiRestoreJob({
    tenantId: input.tenantId,
    vaultId: input.vaultId,
    jobId: restoreJobId,
  });
  if (!restore || restore.status !== "succeeded") {
    throw new WanghaiRestoreError(
      "restore-activation-source-unavailable",
      "Wanghai restore activation requires a completed restore staging job",
      false,
    );
  }
  const sourceBackupJobId = typeof restore.result?.sourceBackupJobId === "string"
    ? restore.result.sourceBackupJobId.trim()
    : "";
  const archiveName = typeof restore.result?.archiveName === "string"
    ? restore.result.archiveName.trim()
    : "";
  const stagingVolume = typeof restore.result?.stagingVolume === "string"
    ? restore.result.stagingVolume.trim()
    : "";
  const expectedStagingVolume = wanghaiRestoreStagingVolumeName(input.vault, restore.id);
  if (
    !sourceBackupJobId
    || !archiveName
    || restore.result?.checksumVerified !== true
    || stagingVolume !== expectedStagingVolume
  ) {
    throw new WanghaiRestoreError(
      "restore-activation-source-invalid",
      "Wanghai restore activation source is invalid",
      false,
    );
  }
  const source = resolveWanghaiRestoreSource({
    tenantId: input.tenantId,
    vaultId: input.vaultId,
    sourceBackupJobId,
  });
  if (source.archiveName !== archiveName) {
    throw new WanghaiRestoreError(
      "restore-activation-source-invalid",
      "Wanghai restore activation source archive is invalid",
      false,
    );
  }
  return {
    restoreJobId: restore.id,
    sourceBackupJobId: source.sourceBackupJobId,
    archiveName,
    stagingVolume,
  };
}

function resolveWanghaiRestoreRollbackSource(input: {
  tenantId: string;
  vaultId: string;
  activationJobId: string;
}): { activationJobId: string; restoreJobId: string; previousWorkspaceName: string } {
  const activationJobId = input.activationJobId.trim();
  const activation = getWanghaiRestoreActivationJob({
    tenantId: input.tenantId,
    vaultId: input.vaultId,
    jobId: activationJobId,
  });
  if (!activation || activation.status !== "succeeded") {
    throw new WanghaiRestoreError(
      "restore-rollback-source-unavailable",
      "Wanghai restore rollback requires a completed activation job",
      false,
    );
  }
  const restoreJobId = typeof activation.result?.restoreJobId === "string"
    ? activation.result.restoreJobId.trim()
    : "";
  const previousWorkspaceName = typeof activation.result?.previousWorkspaceName === "string"
    ? activation.result.previousWorkspaceName.trim()
    : "";
  const expectedPreviousWorkspaceName = wanghaiRestorePreviousWorkspaceName(activation.id);
  if (
    !restoreJobId
    || activation.result?.checksumVerified !== true
    || previousWorkspaceName !== expectedPreviousWorkspaceName
  ) {
    throw new WanghaiRestoreError(
      "restore-rollback-source-invalid",
      "Wanghai restore rollback source is invalid",
      false,
    );
  }
  if (!getPolarisControlStore(import.meta.url).isWanghaiRestoreActivationCurrent({
    tenantId: input.tenantId,
    vaultId: input.vaultId,
    activationJobId: activation.id,
  })) {
    throw new WanghaiRestoreError(
      "restore-rollback-source-unavailable",
      "Wanghai restore rollback requires the current restore activation",
      false,
    );
  }
  return {
    activationJobId: activation.id,
    restoreJobId,
    previousWorkspaceName,
  };
}

function classifyWanghaiBackupError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  cleanupContainer: boolean;
} {
  if (error instanceof WanghaiBackupContainerError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      cleanupContainer: error.cleanupContainer,
    };
  }
  if (error instanceof WanghaiBackupError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      cleanupContainer: false,
    };
  }
  return {
    code: "backup-worker-failed",
    message: "Wanghai backup worker failed",
    retryable: true,
    cleanupContainer: false,
  };
}

async function inspectCompletedWanghaiBackup(input: {
  vault: VaultSpec;
  containerName: string;
  tenantId: string;
  vaultId: string;
  jobId: string;
  retentionCount: number;
  cancelled: boolean;
  timedOut: boolean;
}): Promise<WanghaiBackupContainerSuccess> {
  const state = await inspectWanghaiBackupContainer(input.containerName);
  if (!state) {
    throw new WanghaiBackupContainerError(
      "backup-container-missing",
      "Wanghai backup container disappeared before completion was recorded",
      true,
      false,
    );
  }
  if (state.running) {
    throw new WanghaiBackupContainerError(
      "backup-container-running",
      "Wanghai backup container is still running after the worker disconnected",
      true,
      false,
    );
  }
  if (input.cancelled) {
    throw new WanghaiBackupContainerError(
      "backup-cancelled",
      "Wanghai backup was cancelled",
      false,
      true,
    );
  }
  if (input.timedOut) {
    throw new WanghaiBackupContainerError(
      "backup-timeout",
      "Wanghai backup exceeded its execution deadline",
      true,
      true,
    );
  }
  if (state.exitCode !== 0) {
    throw new WanghaiBackupContainerError(
      "backup-container-failed",
      "Wanghai backup container exited unsuccessfully",
      true,
      true,
    );
  }
  const archiveName = wanghaiBackupArchiveName({
    tenantId: input.tenantId,
    vaultId: input.vaultId,
    jobId: input.jobId,
  });
  const logs = await runDockerCapture(["logs", "--tail", "64", input.containerName]);
  if (logs.status !== 0) {
    throw new WanghaiBackupContainerError(
      "backup-container-logs-unavailable",
      "Wanghai backup container logs are unavailable for recovery",
      true,
      false,
    );
  }
  const parsed = parseWanghaiBackupArchiveLog(logs.stdout, archiveName);
  const verification = await runDockerCapture(
    buildWanghaiBackupVerificationDockerRunArgs({
      vault: input.vault,
      archiveName,
    }),
  );
  if (verification.status !== 0) {
    throw new WanghaiBackupContainerError(
      "backup-verification-failed",
      "Wanghai backup archive checksum verification failed",
      true,
      true,
    );
  }
  return {
    containerName: input.containerName,
    result: {
      ...parsed,
      retentionCount: input.retentionCount,
    },
  };
}

async function executeWanghaiBackupContainer(input: {
  vault: VaultSpec;
  job: DurableJob;
  tenantId: string;
  vaultId: string;
  isCancelled: () => boolean;
}): Promise<WanghaiBackupContainerSuccess> {
  const settings = resolveWanghaiBackupSettings();
  const containerName = wanghaiBackupContainerName(input.job.id);
  const existing = await inspectWanghaiBackupContainer(containerName);
  if (existing?.running) {
    const waited = await waitForWanghaiBackupDockerCommand({
      args: ["wait", containerName],
      containerName,
      timeoutMs: settings.timeoutMs,
      isCancelled: input.isCancelled,
    });
    return inspectCompletedWanghaiBackup({
      vault: input.vault,
      containerName,
      tenantId: input.tenantId,
      vaultId: input.vaultId,
      jobId: input.job.id,
      retentionCount: settings.retentionCount,
      cancelled: waited.cancelled,
      timedOut: waited.timedOut,
    });
  }
  if (existing) {
    return inspectCompletedWanghaiBackup({
      vault: input.vault,
      containerName,
      tenantId: input.tenantId,
      vaultId: input.vaultId,
      jobId: input.job.id,
      retentionCount: settings.retentionCount,
      cancelled: input.isCancelled(),
      timedOut: false,
    });
  }
  const keyFile = ensureWanghaiBackupKey({
    keyRoot: settings.keyRoot,
    tenantId: input.tenantId,
    vaultId: input.vaultId,
  });
  const started = await waitForWanghaiBackupDockerCommand({
    args: buildWanghaiBackupDockerRunArgs({
      vault: input.vault,
      jobId: input.job.id,
      tenantId: input.tenantId,
      vaultId: input.vaultId,
      keyFile,
      settings,
    }),
    containerName,
    timeoutMs: settings.timeoutMs,
    isCancelled: input.isCancelled,
  });
  return inspectCompletedWanghaiBackup({
    vault: input.vault,
    containerName,
    tenantId: input.tenantId,
    vaultId: input.vaultId,
    jobId: input.job.id,
    retentionCount: settings.retentionCount,
    cancelled: started.cancelled,
    timedOut: started.timedOut,
  });
}

function classifyWanghaiRestoreError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  cleanupContainer: boolean;
  cleanupStagingVolume: boolean;
} {
  if (error instanceof WanghaiRestoreContainerError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      cleanupContainer: error.cleanupContainer,
      cleanupStagingVolume: error.cleanupStagingVolume,
    };
  }
  if (error instanceof WanghaiRestoreError || error instanceof WanghaiBackupError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      cleanupContainer: false,
      cleanupStagingVolume: false,
    };
  }
  return {
    code: "restore-worker-failed",
    message: "Wanghai restore worker failed",
    retryable: true,
    cleanupContainer: false,
    cleanupStagingVolume: false,
  };
}

function classifyWanghaiRestoreLifecycleError(error: unknown, operation: "activation" | "rollback"): {
  code: string;
  message: string;
  retryable: boolean;
  cleanupContainer: boolean;
} {
  if (error instanceof WanghaiRestoreLifecycleContainerError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      cleanupContainer: error.cleanupContainer,
    };
  }
  if (error instanceof WanghaiRestoreError || error instanceof WanghaiBackupError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      cleanupContainer: false,
    };
  }
  return {
    code: `restore-${operation}-worker-failed`,
    message: `Wanghai restore ${operation} worker failed`,
    retryable: true,
    cleanupContainer: false,
  };
}

async function inspectWanghaiRestoreContainer(
  containerName: string,
): Promise<DockerBackupContainerState | null> {
  const result = await runDockerCapture([
    "inspect",
    "--format",
    "{{json .State}}",
    containerName,
  ]);
  if (result.status !== 0) {
    if (dockerResultIsNotFound(result)) return null;
    throw new WanghaiRestoreContainerError(
      "restore-container-inspect-failed",
      "Unable to inspect the Wanghai restore container",
      true,
      false,
      false,
    );
  }
  try {
    return parseDockerContainerState(result.stdout);
  } catch {
    throw new WanghaiRestoreContainerError(
      "restore-container-inspect-invalid",
      "Wanghai restore container inspection returned invalid state",
      true,
      false,
      false,
    );
  }
}

async function stopWanghaiRestoreContainer(containerName: string): Promise<void> {
  const stopped = await runDockerCapture(["stop", "--time", "10", containerName]);
  if (stopped.status === 0 || dockerResultIsNotFound(stopped)) return;
  await runDockerCapture(["kill", containerName]);
}

async function waitForWanghaiRestoreDockerCommand(input: {
  args: string[];
  containerName: string;
  timeoutMs: number;
  isCancelled: () => boolean;
}): Promise<{ result: DockerCommandResult; cancelled: boolean; timedOut: boolean }> {
  const command = startDockerCapture(input.args);
  let cancellationRequested = input.isCancelled();
  let timedOut = false;
  let interruption: Promise<void> | null = null;
  let terminateTimer: NodeJS.Timeout | null = null;
  const interrupt = (): void => {
    if (interruption) return;
    interruption = stopWanghaiRestoreContainer(input.containerName).catch(() => {
      // The final inspect determines whether the container was actually stopped.
    });
  };
  if (cancellationRequested) {
    interrupt();
  }
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (input.isCancelled()) {
      cancellationRequested = true;
      interrupt();
      return;
    }
    if (Date.now() - startedAt >= input.timeoutMs) {
      timedOut = true;
      interrupt();
      if (!terminateTimer) {
        terminateTimer = setTimeout(() => {
          command.terminate();
        }, 15_000);
        terminateTimer.unref();
      }
    }
  }, 1_000);
  timer.unref();
  const result = await command.completion;
  clearInterval(timer);
  if (terminateTimer) clearTimeout(terminateTimer);
  if (interruption) {
    await interruption;
  }
  return { result, cancelled: cancellationRequested, timedOut };
}

async function inspectCompletedWanghaiRestore(input: {
  vault: VaultSpec;
  containerName: string;
  tenantId: string;
  vaultId: string;
  jobId: string;
  sourceBackupJobId: string;
  archiveName: string;
  cancelled: boolean;
  timedOut: boolean;
}): Promise<WanghaiRestoreContainerSuccess> {
  const state = await inspectWanghaiRestoreContainer(input.containerName);
  if (!state) {
    throw new WanghaiRestoreContainerError(
      "restore-container-missing",
      "Wanghai restore container disappeared before completion was recorded",
      true,
      false,
      false,
    );
  }
  if (state.running) {
    throw new WanghaiRestoreContainerError(
      "restore-container-running",
      "Wanghai restore container is still running after the worker disconnected",
      true,
      false,
      false,
    );
  }
  if (input.cancelled) {
    throw new WanghaiRestoreContainerError(
      "restore-cancelled",
      "Wanghai restore was cancelled",
      false,
      true,
      true,
    );
  }
  if (input.timedOut) {
    throw new WanghaiRestoreContainerError(
      "restore-timeout",
      "Wanghai restore exceeded its execution deadline",
      true,
      true,
      true,
    );
  }
  if (state.exitCode !== 0) {
    throw new WanghaiRestoreContainerError(
      "restore-container-failed",
      "Wanghai restore container exited unsuccessfully",
      true,
      true,
      true,
    );
  }
  const logs = await runDockerCapture(["logs", "--tail", "64", input.containerName]);
  if (logs.status !== 0) {
    throw new WanghaiRestoreContainerError(
      "restore-container-logs-unavailable",
      "Wanghai restore container logs are unavailable for recovery",
      true,
      false,
      false,
    );
  }
  const parsed = parseWanghaiRestoreLog(logs.stdout);
  const verification = await runDockerCapture(
    buildWanghaiRestoreVerificationDockerRunArgs({
      vault: input.vault,
      jobId: input.jobId,
    }),
  );
  if (verification.status !== 0) {
    throw new WanghaiRestoreContainerError(
      "restore-verification-failed",
      "Wanghai restore staging verification failed",
      true,
      true,
      true,
    );
  }
  return {
    containerName: input.containerName,
    result: {
      sourceBackupJobId: input.sourceBackupJobId,
      archiveName: input.archiveName,
      ...parsed,
      stagingVolume: wanghaiRestoreStagingVolumeName(input.vault, input.jobId),
    },
  };
}

async function executeWanghaiRestoreContainer(input: {
  vault: VaultSpec;
  job: DurableJob;
  tenantId: string;
  vaultId: string;
  sourceBackupJobId: string;
  archiveName: string;
  isCancelled: () => boolean;
}): Promise<WanghaiRestoreContainerSuccess> {
  const settings = resolveWanghaiRestoreSettings();
  const containerName = wanghaiRestoreContainerName(input.job.id);
  const existing = await inspectWanghaiRestoreContainer(containerName);
  if (existing?.running) {
    const waited = await waitForWanghaiRestoreDockerCommand({
      args: ["wait", containerName],
      containerName,
      timeoutMs: settings.timeoutMs,
      isCancelled: input.isCancelled,
    });
    return inspectCompletedWanghaiRestore({
      vault: input.vault,
      containerName,
      tenantId: input.tenantId,
      vaultId: input.vaultId,
      jobId: input.job.id,
      sourceBackupJobId: input.sourceBackupJobId,
      archiveName: input.archiveName,
      cancelled: waited.cancelled,
      timedOut: waited.timedOut,
    });
  }
  if (existing) {
    return inspectCompletedWanghaiRestore({
      vault: input.vault,
      containerName,
      tenantId: input.tenantId,
      vaultId: input.vaultId,
      jobId: input.job.id,
      sourceBackupJobId: input.sourceBackupJobId,
      archiveName: input.archiveName,
      cancelled: input.isCancelled(),
      timedOut: false,
    });
  }
  const keyFile = ensureWanghaiBackupKey({
    keyRoot: settings.keyRoot,
    tenantId: input.tenantId,
    vaultId: input.vaultId,
  });
  const started = await waitForWanghaiRestoreDockerCommand({
    args: buildWanghaiRestoreDockerRunArgs({
      vault: input.vault,
      jobId: input.job.id,
      tenantId: input.tenantId,
      vaultId: input.vaultId,
      archiveName: input.archiveName,
      keyFile,
      settings,
    }),
    containerName,
    timeoutMs: settings.timeoutMs,
    isCancelled: input.isCancelled,
  });
  return inspectCompletedWanghaiRestore({
    vault: input.vault,
    containerName,
    tenantId: input.tenantId,
    vaultId: input.vaultId,
    jobId: input.job.id,
    sourceBackupJobId: input.sourceBackupJobId,
    archiveName: input.archiveName,
    cancelled: started.cancelled,
    timedOut: started.timedOut,
  });
}

async function inspectCompletedWanghaiRestoreActivation(input: {
  vault: VaultSpec;
  containerName: string;
  jobId: string;
  restoreJobId: string;
  stagingVolume: string;
  cancelled: boolean;
  timedOut: boolean;
}): Promise<WanghaiRestoreActivationContainerSuccess> {
  const state = await inspectWanghaiRestoreContainer(input.containerName);
  if (!state) {
    throw new WanghaiRestoreLifecycleContainerError(
      "restore-activation-container-missing",
      "Wanghai restore activation container disappeared before completion was recorded",
      true,
      false,
    );
  }
  if (state.running) {
    throw new WanghaiRestoreLifecycleContainerError(
      "restore-activation-container-running",
      "Wanghai restore activation container is still running after the worker disconnected",
      true,
      false,
    );
  }
  if (input.cancelled) {
    throw new WanghaiRestoreLifecycleContainerError(
      "restore-activation-cancelled",
      "Wanghai restore activation was cancelled",
      false,
      true,
    );
  }
  if (input.timedOut) {
    throw new WanghaiRestoreLifecycleContainerError(
      "restore-activation-timeout",
      "Wanghai restore activation exceeded its execution deadline",
      true,
      true,
    );
  }
  if (state.exitCode !== 0) {
    throw new WanghaiRestoreLifecycleContainerError(
      "restore-activation-container-failed",
      "Wanghai restore activation container exited unsuccessfully",
      true,
      true,
    );
  }
  const logs = await runDockerCapture(["logs", "--tail", "64", input.containerName]);
  if (logs.status !== 0) {
    throw new WanghaiRestoreLifecycleContainerError(
      "restore-activation-container-logs-unavailable",
      "Wanghai restore activation container logs are unavailable for recovery",
      true,
      false,
    );
  }
  let parsed: Pick<WanghaiRestoreActivationResult, "checksumVerified" | "previousWorkspaceName">;
  try {
    parsed = parseWanghaiRestoreActivationLog({
      output: logs.stdout,
      jobId: input.jobId,
      restoreJobId: input.restoreJobId,
    });
  } catch (error) {
    throw new WanghaiRestoreLifecycleContainerError(
      "restore-activation-result-invalid",
      error instanceof Error ? error.message : "Wanghai restore activation result is invalid",
      true,
      true,
    );
  }
  const verification = await runDockerCapture(
    buildWanghaiRestoreActivationVerificationDockerRunArgs({
      vault: input.vault,
      jobId: input.jobId,
      restoreJobId: input.restoreJobId,
      stagingVolume: input.stagingVolume,
    }),
  );
  if (verification.status !== 0) {
    throw new WanghaiRestoreLifecycleContainerError(
      "restore-activation-verification-failed",
      "Wanghai restore activation verification failed",
      true,
      true,
    );
  }
  return {
    containerName: input.containerName,
    result: {
      restoreJobId: input.restoreJobId,
      ...parsed,
    },
  };
}

async function executeWanghaiRestoreActivationContainer(input: {
  vault: VaultSpec;
  job: DurableJob;
  restoreJobId: string;
  stagingVolume: string;
  isCancelled: () => boolean;
}): Promise<WanghaiRestoreActivationContainerSuccess> {
  const settings = resolveWanghaiRestoreSettings();
  const containerName = wanghaiRestoreActivationContainerName(input.job.id);
  const inspectInput = {
    vault: input.vault,
    containerName,
    jobId: input.job.id,
    restoreJobId: input.restoreJobId,
    stagingVolume: input.stagingVolume,
  };
  const existing = await inspectWanghaiRestoreContainer(containerName);
  if (existing?.running) {
    const waited = await waitForWanghaiRestoreDockerCommand({
      args: ["wait", containerName],
      containerName,
      timeoutMs: settings.timeoutMs,
      isCancelled: input.isCancelled,
    });
    return inspectCompletedWanghaiRestoreActivation({
      ...inspectInput,
      cancelled: waited.cancelled,
      timedOut: waited.timedOut,
    });
  }
  if (existing) {
    return inspectCompletedWanghaiRestoreActivation({
      ...inspectInput,
      cancelled: input.isCancelled(),
      timedOut: false,
    });
  }
  const started = await waitForWanghaiRestoreDockerCommand({
    args: buildWanghaiRestoreActivationDockerRunArgs({
      vault: input.vault,
      jobId: input.job.id,
      restoreJobId: input.restoreJobId,
      stagingVolume: input.stagingVolume,
    }),
    containerName,
    timeoutMs: settings.timeoutMs,
    isCancelled: input.isCancelled,
  });
  return inspectCompletedWanghaiRestoreActivation({
    ...inspectInput,
    cancelled: started.cancelled,
    timedOut: started.timedOut,
  });
}

async function inspectCompletedWanghaiRestoreRollback(input: {
  vault: VaultSpec;
  containerName: string;
  jobId: string;
  activationJobId: string;
  previousWorkspaceName: string;
  cancelled: boolean;
  timedOut: boolean;
}): Promise<WanghaiRestoreRollbackContainerSuccess> {
  const state = await inspectWanghaiRestoreContainer(input.containerName);
  if (!state) {
    throw new WanghaiRestoreLifecycleContainerError(
      "restore-rollback-container-missing",
      "Wanghai restore rollback container disappeared before completion was recorded",
      true,
      false,
    );
  }
  if (state.running) {
    throw new WanghaiRestoreLifecycleContainerError(
      "restore-rollback-container-running",
      "Wanghai restore rollback container is still running after the worker disconnected",
      true,
      false,
    );
  }
  if (input.cancelled) {
    throw new WanghaiRestoreLifecycleContainerError(
      "restore-rollback-cancelled",
      "Wanghai restore rollback was cancelled",
      false,
      true,
    );
  }
  if (input.timedOut) {
    throw new WanghaiRestoreLifecycleContainerError(
      "restore-rollback-timeout",
      "Wanghai restore rollback exceeded its execution deadline",
      true,
      true,
    );
  }
  if (state.exitCode !== 0) {
    throw new WanghaiRestoreLifecycleContainerError(
      "restore-rollback-container-failed",
      "Wanghai restore rollback container exited unsuccessfully",
      true,
      true,
    );
  }
  const logs = await runDockerCapture(["logs", "--tail", "64", input.containerName]);
  if (logs.status !== 0) {
    throw new WanghaiRestoreLifecycleContainerError(
      "restore-rollback-container-logs-unavailable",
      "Wanghai restore rollback container logs are unavailable for recovery",
      true,
      false,
    );
  }
  let parsed: Pick<WanghaiRestoreRollbackResult, "rollbackVerified" | "failedWorkspaceName">;
  try {
    parsed = parseWanghaiRestoreRollbackLog({
      output: logs.stdout,
      jobId: input.jobId,
      activationJobId: input.activationJobId,
    });
  } catch (error) {
    throw new WanghaiRestoreLifecycleContainerError(
      "restore-rollback-result-invalid",
      error instanceof Error ? error.message : "Wanghai restore rollback result is invalid",
      true,
      true,
    );
  }
  const verification = await runDockerCapture(
    buildWanghaiRestoreRollbackVerificationDockerRunArgs({
      vault: input.vault,
      jobId: input.jobId,
      failedWorkspaceName: parsed.failedWorkspaceName,
    }),
  );
  if (verification.status !== 0) {
    throw new WanghaiRestoreLifecycleContainerError(
      "restore-rollback-verification-failed",
      "Wanghai restore rollback verification failed",
      true,
      true,
    );
  }
  return {
    containerName: input.containerName,
    result: {
      activationJobId: input.activationJobId,
      ...parsed,
    },
  };
}

async function executeWanghaiRestoreRollbackContainer(input: {
  vault: VaultSpec;
  job: DurableJob;
  activationJobId: string;
  previousWorkspaceName: string;
  isCancelled: () => boolean;
}): Promise<WanghaiRestoreRollbackContainerSuccess> {
  const settings = resolveWanghaiRestoreSettings();
  const containerName = wanghaiRestoreRollbackContainerName(input.job.id);
  const inspectInput = {
    vault: input.vault,
    containerName,
    jobId: input.job.id,
    activationJobId: input.activationJobId,
    previousWorkspaceName: input.previousWorkspaceName,
  };
  const existing = await inspectWanghaiRestoreContainer(containerName);
  if (existing?.running) {
    const waited = await waitForWanghaiRestoreDockerCommand({
      args: ["wait", containerName],
      containerName,
      timeoutMs: settings.timeoutMs,
      isCancelled: input.isCancelled,
    });
    return inspectCompletedWanghaiRestoreRollback({
      ...inspectInput,
      cancelled: waited.cancelled,
      timedOut: waited.timedOut,
    });
  }
  if (existing) {
    return inspectCompletedWanghaiRestoreRollback({
      ...inspectInput,
      cancelled: input.isCancelled(),
      timedOut: false,
    });
  }
  const started = await waitForWanghaiRestoreDockerCommand({
    args: buildWanghaiRestoreRollbackDockerRunArgs({
      vault: input.vault,
      jobId: input.job.id,
      activationJobId: input.activationJobId,
      previousWorkspaceName: input.previousWorkspaceName,
    }),
    containerName,
    timeoutMs: settings.timeoutMs,
    isCancelled: input.isCancelled,
  });
  return inspectCompletedWanghaiRestoreRollback({
    ...inspectInput,
    cancelled: started.cancelled,
    timedOut: started.timedOut,
  });
}

async function removeWanghaiRestoreContainer(containerName: string): Promise<void> {
  const result = await runDockerCapture(["rm", "-f", containerName]);
  if (result.status !== 0 && !dockerResultIsNotFound(result)) {
    logWarn("executor", "wanghai-restore-container-remove-failed", { containerName });
  }
}

async function removeWanghaiRestoreStagingVolume(volumeName: string): Promise<void> {
  const result = await runDockerCapture(["volume", "rm", volumeName]);
  if (result.status !== 0 && !dockerResultIsNotFound(result)) {
    logWarn("executor", "wanghai-restore-staging-volume-remove-failed", { volumeName });
  }
}

async function removeWanghaiBackupContainer(containerName: string): Promise<void> {
  const result = await runDockerCapture(["rm", "-f", containerName]);
  if (result.status !== 0 && !dockerResultIsNotFound(result)) {
    logWarn("executor", "wanghai-backup-container-remove-failed", {
      containerName,
    });
  }
}

export async function queueWanghaiBackup(input: {
  actorId: string;
  tenantId: string;
  vaultId: string;
  idempotencyKey: string;
}): Promise<DurableJob> {
  const tenantId = input.tenantId.trim();
  const vaultId = input.vaultId.trim();
  if (!tenantId || !vaultId || !userProfileExists(tenantId)) {
    throw new WanghaiBackupError(
      "backup-tenant-not-found",
      "Wanghai backup tenant was not found",
      false,
    );
  }
  const dedupeKey = wanghaiBackupDedupeKey(tenantId, vaultId, input.idempotencyKey);
  const store = getPolarisControlStore(import.meta.url);
  const existing = store.getJobByDedupeKey(dedupeKey);
  if (existing) {
    store.recordAudit({
      actorId: input.actorId.trim() || tenantId,
      tenantId,
      vaultId,
      action: "wanghai.backup.submit",
      outcome: "success",
      metadata: { jobId: existing.id, reused: true },
    });
    void resumeDurableVaultJobs();
    return existing;
  }
  resolveWanghaiBackupVault(tenantId, vaultId);
  const settings = resolveWanghaiBackupSettings();
  const rateLimit = store.consumeGatewayRateLimit({
    bucketKey: wanghaiBackupRateLimitBucket(tenantId, vaultId),
    limit: settings.submissionsPerHour,
    windowSeconds: 60 * 60,
  });
  if (!rateLimit.allowed) {
    store.recordAudit({
      actorId: input.actorId.trim() || tenantId,
      tenantId,
      vaultId,
      action: "wanghai.backup.submit",
      outcome: "denied",
      metadata: { reason: "rate-limited", limit: rateLimit.limit },
    });
    throw new WanghaiBackupError(
      "backup-rate-limited",
      "Wanghai backup submission rate limit exceeded",
      false,
    );
  }
  const job = store.enqueueJob({
    kind: WANGHAI_BACKUP_JOB_KIND,
    dedupeKey,
    tenantId,
    vaultId,
    payload: {
      actorId: input.actorId.trim() || tenantId,
    },
  });
  store.recordAudit({
    actorId: input.actorId.trim() || tenantId,
    tenantId,
    vaultId,
    action: "wanghai.backup.submit",
    outcome: "success",
    metadata: { jobId: job.id, reused: false },
  });
  void resumeDurableVaultJobs();
  return job;
}

export function getWanghaiBackupJob(input: {
  tenantId: string;
  vaultId: string;
  jobId: string;
}): DurableJob | null {
  const job = getPolarisControlStore(import.meta.url).getJob(input.jobId);
  if (
    !job
    || job.kind !== WANGHAI_BACKUP_JOB_KIND
    || job.tenantId !== input.tenantId.trim()
    || job.vaultId !== input.vaultId.trim()
  ) {
    return null;
  }
  return job;
}

export function requestWanghaiBackupCancellation(input: {
  actorId: string;
  tenantId: string;
  vaultId: string;
  jobId: string;
}): boolean {
  const job = getWanghaiBackupJob(input);
  const requested = job
    ? getPolarisControlStore(import.meta.url).requestJobCancellation(job.dedupeKey)
    : false;
  getPolarisControlStore(import.meta.url).recordAudit({
    actorId: input.actorId.trim() || input.tenantId.trim(),
    tenantId: input.tenantId.trim(),
    vaultId: input.vaultId.trim(),
    action: "wanghai.backup.cancel",
    outcome: requested ? "success" : "denied",
    metadata: { jobId: input.jobId.trim() || "unknown", requested },
  });
  return requested;
}

export async function queueWanghaiRestore(input: {
  actorId: string;
  tenantId: string;
  vaultId: string;
  sourceBackupJobId: string;
  idempotencyKey: string;
}): Promise<DurableJob> {
  const tenantId = input.tenantId.trim();
  const vaultId = input.vaultId.trim();
  if (!tenantId || !vaultId || !userProfileExists(tenantId)) {
    throw new WanghaiRestoreError(
      "restore-tenant-not-found",
      "Wanghai restore tenant was not found",
      false,
    );
  }
  const sourceBackupJobId = input.sourceBackupJobId.trim();
  const dedupeKey = wanghaiRestoreDedupeKey(
    tenantId,
    vaultId,
    sourceBackupJobId,
    input.idempotencyKey,
  );
  const store = getPolarisControlStore(import.meta.url);
  const existing = store.getJobByDedupeKey(dedupeKey);
  if (existing) {
    store.recordAudit({
      actorId: input.actorId.trim() || tenantId,
      tenantId,
      vaultId,
      action: "wanghai.restore.submit",
      outcome: "success",
      metadata: { jobId: existing.id, sourceBackupJobId, reused: true },
    });
    void resumeDurableVaultJobs();
    return existing;
  }
  const source = resolveWanghaiRestoreSource({
    tenantId,
    vaultId,
    sourceBackupJobId,
  });
  resolveWanghaiRestoreVault(tenantId, vaultId);
  const settings = resolveWanghaiRestoreSettings();
  const rateLimit = store.consumeGatewayRateLimit({
    bucketKey: wanghaiRestoreRateLimitBucket(tenantId, vaultId),
    limit: settings.submissionsPerHour,
    windowSeconds: 60 * 60,
  });
  if (!rateLimit.allowed) {
    store.recordAudit({
      actorId: input.actorId.trim() || tenantId,
      tenantId,
      vaultId,
      action: "wanghai.restore.submit",
      outcome: "denied",
      metadata: {
        sourceBackupJobId: source.sourceBackupJobId,
        reason: "rate-limited",
        limit: rateLimit.limit,
      },
    });
    throw new WanghaiRestoreError(
      "restore-rate-limited",
      "Wanghai restore submission rate limit exceeded",
      false,
    );
  }
  const job = store.enqueueJob({
    kind: WANGHAI_RESTORE_JOB_KIND,
    dedupeKey,
    tenantId,
    vaultId,
    payload: {
      actorId: input.actorId.trim() || tenantId,
      sourceBackupJobId: source.sourceBackupJobId,
    },
  });
  store.recordAudit({
    actorId: input.actorId.trim() || tenantId,
    tenantId,
    vaultId,
    action: "wanghai.restore.submit",
    outcome: "success",
    metadata: {
      jobId: job.id,
      sourceBackupJobId: source.sourceBackupJobId,
      reused: false,
    },
  });
  void resumeDurableVaultJobs();
  return job;
}

export function getWanghaiRestoreJob(input: {
  tenantId: string;
  vaultId: string;
  jobId: string;
}): DurableJob | null {
  const job = getPolarisControlStore(import.meta.url).getJob(input.jobId);
  if (
    !job
    || job.kind !== WANGHAI_RESTORE_JOB_KIND
    || job.tenantId !== input.tenantId.trim()
    || job.vaultId !== input.vaultId.trim()
  ) {
    return null;
  }
  return job;
}

export function requestWanghaiRestoreCancellation(input: {
  actorId: string;
  tenantId: string;
  vaultId: string;
  jobId: string;
}): boolean {
  const job = getWanghaiRestoreJob(input);
  const requested = job
    ? getPolarisControlStore(import.meta.url).requestJobCancellation(job.dedupeKey)
    : false;
  getPolarisControlStore(import.meta.url).recordAudit({
    actorId: input.actorId.trim() || input.tenantId.trim(),
    tenantId: input.tenantId.trim(),
    vaultId: input.vaultId.trim(),
    action: "wanghai.restore.cancel",
    outcome: requested ? "success" : "denied",
    metadata: { jobId: input.jobId.trim() || "unknown", requested },
  });
  return requested;
}

export async function queueWanghaiRestoreActivation(input: {
  actorId: string;
  tenantId: string;
  vaultId: string;
  restoreJobId: string;
  idempotencyKey: string;
}): Promise<DurableJob> {
  const tenantId = input.tenantId.trim();
  const vaultId = input.vaultId.trim();
  if (!tenantId || !vaultId || !userProfileExists(tenantId)) {
    throw new WanghaiRestoreError(
      "restore-tenant-not-found",
      "Wanghai restore tenant was not found",
      false,
    );
  }
  const restoreJobId = input.restoreJobId.trim();
  const dedupeKey = wanghaiRestoreActivationDedupeKey(
    tenantId,
    vaultId,
    restoreJobId,
    input.idempotencyKey,
  );
  const store = getPolarisControlStore(import.meta.url);
  const existing = store.getJobByDedupeKey(dedupeKey);
  if (existing) {
    store.recordAudit({
      actorId: input.actorId.trim() || tenantId,
      tenantId,
      vaultId,
      action: "wanghai.restore.activate.submit",
      outcome: "success",
      metadata: { jobId: existing.id, restoreJobId, reused: true },
    });
    void resumeDurableVaultJobs();
    return existing;
  }
  const vault = resolveWanghaiRestoreVault(tenantId, vaultId);
  const source = resolveWanghaiRestoreActivationSource({
    tenantId,
    vaultId,
    restoreJobId,
    vault,
  });
  const settings = resolveWanghaiRestoreSettings();
  const rateLimit = store.consumeGatewayRateLimit({
    bucketKey: wanghaiRestoreActivationRateLimitBucket(tenantId, vaultId),
    limit: settings.submissionsPerHour,
    windowSeconds: 60 * 60,
  });
  if (!rateLimit.allowed) {
    store.recordAudit({
      actorId: input.actorId.trim() || tenantId,
      tenantId,
      vaultId,
      action: "wanghai.restore.activate.submit",
      outcome: "denied",
      metadata: {
        restoreJobId: source.restoreJobId,
        reason: "rate-limited",
        limit: rateLimit.limit,
      },
    });
    throw new WanghaiRestoreError(
      "restore-activation-rate-limited",
      "Wanghai restore activation submission rate limit exceeded",
      false,
    );
  }
  const job = store.enqueueJob({
    kind: WANGHAI_RESTORE_ACTIVATION_JOB_KIND,
    dedupeKey,
    tenantId,
    vaultId,
    payload: {
      actorId: input.actorId.trim() || tenantId,
      restoreJobId: source.restoreJobId,
    },
  });
  store.recordAudit({
    actorId: input.actorId.trim() || tenantId,
    tenantId,
    vaultId,
    action: "wanghai.restore.activate.submit",
    outcome: "success",
    metadata: {
      jobId: job.id,
      restoreJobId: source.restoreJobId,
      reused: false,
    },
  });
  void resumeDurableVaultJobs();
  return job;
}

export function getWanghaiRestoreActivationJob(input: {
  tenantId: string;
  vaultId: string;
  jobId: string;
}): DurableJob | null {
  const job = getPolarisControlStore(import.meta.url).getJob(input.jobId);
  if (
    !job
    || job.kind !== WANGHAI_RESTORE_ACTIVATION_JOB_KIND
    || job.tenantId !== input.tenantId.trim()
    || job.vaultId !== input.vaultId.trim()
  ) {
    return null;
  }
  return job;
}

export function requestWanghaiRestoreActivationCancellation(input: {
  actorId: string;
  tenantId: string;
  vaultId: string;
  jobId: string;
}): boolean {
  const job = getWanghaiRestoreActivationJob(input);
  const requested = job?.status === "queued"
    ? getPolarisControlStore(import.meta.url).requestJobCancellation(job.dedupeKey)
    : false;
  getPolarisControlStore(import.meta.url).recordAudit({
    actorId: input.actorId.trim() || input.tenantId.trim(),
    tenantId: input.tenantId.trim(),
    vaultId: input.vaultId.trim(),
    action: "wanghai.restore.activate.cancel",
    outcome: requested ? "success" : "denied",
    metadata: { jobId: input.jobId.trim() || "unknown", requested },
  });
  return requested;
}

export async function queueWanghaiRestoreRollback(input: {
  actorId: string;
  tenantId: string;
  vaultId: string;
  activationJobId: string;
  idempotencyKey: string;
}): Promise<DurableJob> {
  const tenantId = input.tenantId.trim();
  const vaultId = input.vaultId.trim();
  if (!tenantId || !vaultId || !userProfileExists(tenantId)) {
    throw new WanghaiRestoreError(
      "restore-tenant-not-found",
      "Wanghai restore tenant was not found",
      false,
    );
  }
  const activationJobId = input.activationJobId.trim();
  const dedupeKey = wanghaiRestoreRollbackDedupeKey(
    tenantId,
    vaultId,
    activationJobId,
    input.idempotencyKey,
  );
  const store = getPolarisControlStore(import.meta.url);
  const existing = store.getJobByDedupeKey(dedupeKey);
  if (existing) {
    store.recordAudit({
      actorId: input.actorId.trim() || tenantId,
      tenantId,
      vaultId,
      action: "wanghai.restore.rollback.submit",
      outcome: "success",
      metadata: { jobId: existing.id, activationJobId, reused: true },
    });
    void resumeDurableVaultJobs();
    return existing;
  }
  resolveWanghaiRestoreVault(tenantId, vaultId);
  const source = resolveWanghaiRestoreRollbackSource({
    tenantId,
    vaultId,
    activationJobId,
  });
  const settings = resolveWanghaiRestoreSettings();
  const rateLimit = store.consumeGatewayRateLimit({
    bucketKey: wanghaiRestoreRollbackRateLimitBucket(tenantId, vaultId),
    limit: settings.submissionsPerHour,
    windowSeconds: 60 * 60,
  });
  if (!rateLimit.allowed) {
    store.recordAudit({
      actorId: input.actorId.trim() || tenantId,
      tenantId,
      vaultId,
      action: "wanghai.restore.rollback.submit",
      outcome: "denied",
      metadata: {
        activationJobId: source.activationJobId,
        reason: "rate-limited",
        limit: rateLimit.limit,
      },
    });
    throw new WanghaiRestoreError(
      "restore-rollback-rate-limited",
      "Wanghai restore rollback submission rate limit exceeded",
      false,
    );
  }
  const job = store.enqueueJob({
    kind: WANGHAI_RESTORE_ROLLBACK_JOB_KIND,
    dedupeKey,
    tenantId,
    vaultId,
    payload: {
      actorId: input.actorId.trim() || tenantId,
      activationJobId: source.activationJobId,
    },
  });
  store.recordAudit({
    actorId: input.actorId.trim() || tenantId,
    tenantId,
    vaultId,
    action: "wanghai.restore.rollback.submit",
    outcome: "success",
    metadata: {
      jobId: job.id,
      activationJobId: source.activationJobId,
      reused: false,
    },
  });
  void resumeDurableVaultJobs();
  return job;
}

export function getWanghaiRestoreRollbackJob(input: {
  tenantId: string;
  vaultId: string;
  jobId: string;
}): DurableJob | null {
  const job = getPolarisControlStore(import.meta.url).getJob(input.jobId);
  if (
    !job
    || job.kind !== WANGHAI_RESTORE_ROLLBACK_JOB_KIND
    || job.tenantId !== input.tenantId.trim()
    || job.vaultId !== input.vaultId.trim()
  ) {
    return null;
  }
  return job;
}

export function requestWanghaiRestoreRollbackCancellation(input: {
  actorId: string;
  tenantId: string;
  vaultId: string;
  jobId: string;
}): boolean {
  const job = getWanghaiRestoreRollbackJob(input);
  const requested = job?.status === "queued"
    ? getPolarisControlStore(import.meta.url).requestJobCancellation(job.dedupeKey)
    : false;
  getPolarisControlStore(import.meta.url).recordAudit({
    actorId: input.actorId.trim() || input.tenantId.trim(),
    tenantId: input.tenantId.trim(),
    vaultId: input.vaultId.trim(),
    action: "wanghai.restore.rollback.cancel",
    outcome: requested ? "success" : "denied",
    metadata: { jobId: input.jobId.trim() || "unknown", requested },
  });
  return requested;
}

function provisionOptionsFromJob(job: DurableJob): {
  defaultDockerOnly: boolean;
  startAfterCreate: boolean;
  line?: "coding" | "vertical";
} {
  return {
    defaultDockerOnly: job.payload.defaultDockerOnly === true,
    startAfterCreate: job.payload.startAfterCreate === true,
    ...(job.payload.line === "coding" || job.payload.line === "vertical"
      ? { line: job.payload.line }
      : {}),
  };
}

async function executeClaimedProvisionJob(
  job: DurableJob,
  workerId: string,
): Promise<void> {
  const userId = job.tenantId?.trim();
  const vault = job.vaultId?.trim();
  const store = getPolarisControlStore(import.meta.url);
  if (!userId || !vault) {
    store.failJobPermanently(job.id, workerId, "invalid-job", "Provision job is missing tenant or vault identity");
    store.recordAudit({
      action: "vault.provision",
      outcome: "failure",
      metadata: { jobId: job.id, reason: "invalid-job" },
    });
    return;
  }
  if (store.isJobCancellationRequested(job.id)) {
    store.failJob(job.id, workerId, "vault-provision-cancelled", "vault provision cancelled", 0);
    return;
  }
  const key = rootKey(userId, vault);
  const existing = provisionJobs.get(key);
  if (existing) {
    await existing;
    return;
  }
  const leaseMs = durableJobLeaseMs();
  const heartbeat = setInterval(() => {
    store.heartbeatJob(job.id, workerId, leaseMs);
  }, Math.max(10_000, Math.floor(leaseMs / 4)));
  heartbeat.unref();
  const execution = (async () => {
    let tenantMissing = false;
    try {
      clearProvisionState(userId, vault);
      await provisionVaultInternal(userId, vault, {
        ...provisionOptionsFromJob(job),
        isCancelled: () => store.isJobCancellationRequested(job.id),
      });
      if (!store.completeJob(job.id, workerId)) {
        if (store.isJobCancellationRequested(job.id)) {
          store.failJob(job.id, workerId, "vault-provision-cancelled", "vault provision cancelled", 0);
          return;
        }
        throw new Error("Lost durable job lease while completing provision");
      }
      store.recordAudit({
        actorId: userId,
        tenantId: userId,
        vaultId: vault,
        action: "vault.provision",
        outcome: "success",
        metadata: { jobId: job.id, attempts: job.attempts },
      });
    } catch (error) {
      tenantMissing = error instanceof ProvisionTenantMissingError;
      const cancelled = store.isJobCancellationRequested(job.id);
      const classified = cancelled
        ? {
            message: "vault provision cancelled",
            errorCode: "vault-provision-cancelled",
            retryable: false,
          }
        : classifyProvisionError(error);
      const failureCode = tenantMissing ? "tenant-not-found" : classified.errorCode;
      logVaultEvent("warn", "provision-failed", {
        userId,
        vault,
      }, {
        errorCode: failureCode,
        reason: classified.message,
      });
      if (!cancelled && !tenantMissing) {
        try {
          await refreshPortalVaultStatus(userId, vault);
        } catch (refreshError) {
          writeDirectVaultStatus(userId, vault, (current) => buildVaultStatusFromCurrent({
            vault,
            current,
            driverState: {
              selected: current?.driver?.selected ?? null,
              status: "failed",
              reason: classified.message,
            },
          }));
          logVaultEvent("warn", "provision-failed-refresh", {
            userId,
            vault,
          }, {
            error: refreshError instanceof Error ? refreshError.message : String(refreshError),
          });
        }
      }
      const updated = tenantMissing
        ? store.failJobPermanently(job.id, workerId, "tenant-not-found", classified.message)
        : store.failJob(job.id, workerId, classified.errorCode, classified.message);
      store.recordAudit({
        actorId: userId,
        tenantId: userId,
        vaultId: vault,
        action: "vault.provision",
        outcome: "failure",
        metadata: {
          jobId: job.id,
          attempts: job.attempts,
          errorCode: failureCode,
          retryScheduled: updated?.status === "queued",
        },
      });
      if (!cancelled && updated?.status === "queued") {
        const retry = setTimeout(() => {
          void resumeDurableVaultJobs();
        }, 1_000);
        retry.unref();
      }
    } finally {
      clearInterval(heartbeat);
      if (!store.isJobCancellationRequested(job.id) && !tenantMissing) {
        clearProvisionState(userId, vault);
      }
      provisionJobs.delete(key);
    }
  })();
  provisionJobs.set(key, execution);
  await execution;
}

async function executeClaimedWanghaiBackupJob(
  job: DurableJob,
  workerId: string,
): Promise<void> {
  const tenantId = job.tenantId?.trim();
  const vaultId = job.vaultId?.trim();
  const store = getPolarisControlStore(import.meta.url);
  if (!tenantId || !vaultId) {
    store.failJobPermanently(
      job.id,
      workerId,
      "backup-job-invalid",
      "Wanghai backup job is missing tenant or vault identity",
    );
    store.recordAudit({
      action: "wanghai.backup",
      outcome: "failure",
      metadata: { jobId: job.id, errorCode: "backup-job-invalid" },
    });
    return;
  }
  const actorId = durableJobActorId(job, tenantId);
  if (store.isJobCancellationRequested(job.id)) {
    const updated = store.failJob(job.id, workerId, "backup-cancelled", "Wanghai backup was cancelled", 0);
    store.recordAudit({
      actorId,
      tenantId,
      vaultId,
      action: "wanghai.backup",
      outcome: "failure",
      metadata: {
        jobId: job.id,
        errorCode: updated?.errorCode ?? "durable-job-cancelled",
        cancelled: true,
      },
    });
    return;
  }

  let cleanupContainer = false;
  let containerName: string | undefined;
  const leaseMs = durableJobLeaseMs();
  const heartbeat = setInterval(() => {
    store.heartbeatJob(job.id, workerId, leaseMs);
  }, Math.max(10_000, Math.floor(leaseMs / 4)));
  heartbeat.unref();
  try {
    containerName = wanghaiBackupContainerName(job.id);
    await withVaultLifecycleLock(import.meta.url, tenantId, vaultId, async () => {
      if (store.isJobCancellationRequested(job.id)) {
        throw new WanghaiBackupContainerError(
          "backup-cancelled",
          "Wanghai backup was cancelled",
          false,
          false,
        );
      }
      const vault = resolveWanghaiBackupVault(tenantId, vaultId);
      const completed = await executeWanghaiBackupContainer({
        vault,
        job,
        tenantId,
        vaultId,
        isCancelled: () => store.isJobCancellationRequested(job.id),
      });
      if (!store.completeJob(job.id, workerId, completed.result)) {
        if (store.isJobCancellationRequested(job.id)) {
          const updated = store.failJob(
            job.id,
            workerId,
            "backup-cancelled",
            "Wanghai backup was cancelled",
            0,
          );
          cleanupContainer = updated?.status === "failed";
          store.recordAudit({
            actorId,
            tenantId,
            vaultId,
            action: "wanghai.backup",
            outcome: "failure",
            metadata: {
              jobId: job.id,
              errorCode: updated?.errorCode ?? "durable-job-cancelled",
              cancelled: true,
            },
          });
          return;
        }
        throw new WanghaiBackupContainerError(
          "backup-job-lease-lost",
          "Lost durable job lease while completing Wanghai backup",
          true,
          false,
        );
      }
      cleanupContainer = true;
      store.recordAudit({
        actorId,
        tenantId,
        vaultId,
        action: "wanghai.backup",
        outcome: "success",
        metadata: {
          jobId: job.id,
          attempts: job.attempts,
          archiveName: completed.result.archiveName,
          checksumVerified: completed.result.checksumVerified,
          retentionCount: completed.result.retentionCount,
        },
      });
    });
  } catch (error) {
    const cancelled = store.isJobCancellationRequested(job.id);
    const classified = cancelled
      ? {
          code: "backup-cancelled",
          message: "Wanghai backup was cancelled",
          retryable: false,
          cleanupContainer: error instanceof WanghaiBackupContainerError
            ? error.cleanupContainer
            : false,
        }
      : classifyWanghaiBackupError(error);
    cleanupContainer = cleanupContainer || classified.cleanupContainer;
    // A completed container is evidence for this job attempt. Do not remove it
    // and start another one until the durable job has reached a terminal state.
    const retryable = classified.retryable && !classified.cleanupContainer;
    const updated = retryable
      ? store.failJob(job.id, workerId, classified.code, classified.message)
      : store.failJobPermanently(job.id, workerId, classified.code, classified.message);
    store.recordAudit({
      actorId,
      tenantId,
      vaultId,
      action: "wanghai.backup",
      outcome: "failure",
      metadata: {
        jobId: job.id,
        attempts: job.attempts,
        errorCode: updated?.errorCode ?? classified.code,
        retryScheduled: updated?.status === "queued",
        cancelled,
      },
    });
    if (!cancelled && retryable && updated?.status === "queued") {
      const retry = setTimeout(() => {
        void resumeDurableVaultJobs();
      }, 1_000);
      retry.unref();
    }
  } finally {
    clearInterval(heartbeat);
    if (cleanupContainer && containerName) {
      await removeWanghaiBackupContainer(containerName);
    }
  }
}

async function executeClaimedWanghaiRestoreJob(
  job: DurableJob,
  workerId: string,
): Promise<void> {
  const tenantId = job.tenantId?.trim();
  const vaultId = job.vaultId?.trim();
  const store = getPolarisControlStore(import.meta.url);
  if (!tenantId || !vaultId) {
    store.failJobPermanently(
      job.id,
      workerId,
      "restore-job-invalid",
      "Wanghai restore job is missing tenant or vault identity",
    );
    store.recordAudit({
      action: "wanghai.restore",
      outcome: "failure",
      metadata: { jobId: job.id, errorCode: "restore-job-invalid" },
    });
    return;
  }
  const actorId = durableJobActorId(job, tenantId);
  if (store.isJobCancellationRequested(job.id)) {
    const updated = store.failJob(job.id, workerId, "restore-cancelled", "Wanghai restore was cancelled", 0);
    store.recordAudit({
      actorId,
      tenantId,
      vaultId,
      action: "wanghai.restore",
      outcome: "failure",
      metadata: {
        jobId: job.id,
        errorCode: updated?.errorCode ?? "durable-job-cancelled",
        cancelled: true,
      },
    });
    return;
  }

  let cleanupContainer = false;
  let cleanupStagingVolume = false;
  let containerName: string | undefined;
  let stagingVolume: string | undefined;
  const leaseMs = durableJobLeaseMs();
  const heartbeat = setInterval(() => {
    store.heartbeatJob(job.id, workerId, leaseMs);
  }, Math.max(10_000, Math.floor(leaseMs / 4)));
  heartbeat.unref();
  try {
    containerName = wanghaiRestoreContainerName(job.id);
    await withVaultLifecycleLock(import.meta.url, tenantId, vaultId, async () => {
      if (store.isJobCancellationRequested(job.id)) {
        throw new WanghaiRestoreContainerError(
          "restore-cancelled",
          "Wanghai restore was cancelled",
          false,
          false,
          false,
        );
      }
      const sourceBackupJobId = String(job.payload.sourceBackupJobId ?? "");
      const source = resolveWanghaiRestoreSource({
        tenantId,
        vaultId,
        sourceBackupJobId,
      });
      const vault = resolveWanghaiRestoreVault(tenantId, vaultId);
      stagingVolume = wanghaiRestoreStagingVolumeName(vault, job.id);
      const completed = await executeWanghaiRestoreContainer({
        vault,
        job,
        tenantId,
        vaultId,
        sourceBackupJobId: source.sourceBackupJobId,
        archiveName: source.archiveName,
        isCancelled: () => store.isJobCancellationRequested(job.id),
      });
      if (!store.completeJob(job.id, workerId, completed.result)) {
        if (store.isJobCancellationRequested(job.id)) {
          const updated = store.failJob(
            job.id,
            workerId,
            "restore-cancelled",
            "Wanghai restore was cancelled",
            0,
          );
          cleanupContainer = updated?.status === "failed";
          cleanupStagingVolume = updated?.status === "failed";
          store.recordAudit({
            actorId,
            tenantId,
            vaultId,
            action: "wanghai.restore",
            outcome: "failure",
            metadata: {
              jobId: job.id,
              errorCode: updated?.errorCode ?? "durable-job-cancelled",
              cancelled: true,
            },
          });
          return;
        }
        throw new WanghaiRestoreContainerError(
          "restore-job-lease-lost",
          "Lost durable job lease while completing Wanghai restore",
          true,
          false,
          false,
        );
      }
      cleanupContainer = true;
      store.recordAudit({
        actorId,
        tenantId,
        vaultId,
        action: "wanghai.restore",
        outcome: "success",
        metadata: {
          jobId: job.id,
          attempts: job.attempts,
          sourceBackupJobId: completed.result.sourceBackupJobId,
          archiveName: completed.result.archiveName,
          checksumVerified: completed.result.checksumVerified,
          staged: true,
        },
      });
    });
  } catch (error) {
    const cancelled = store.isJobCancellationRequested(job.id);
    const classified = cancelled
      ? {
          code: "restore-cancelled",
          message: "Wanghai restore was cancelled",
          retryable: false,
          cleanupContainer: error instanceof WanghaiRestoreContainerError
            ? error.cleanupContainer
            : false,
          cleanupStagingVolume: error instanceof WanghaiRestoreContainerError
            ? error.cleanupStagingVolume
            : false,
        }
      : classifyWanghaiRestoreError(error);
    cleanupContainer = cleanupContainer || classified.cleanupContainer;
    cleanupStagingVolume = cleanupStagingVolume || classified.cleanupStagingVolume;
    // A completed restore container and its staging volume remain intact until
    // Polaris records their terminal result or explicitly abandons the attempt.
    const retryable = classified.retryable
      && !classified.cleanupContainer
      && !classified.cleanupStagingVolume;
    const updated = retryable
      ? store.failJob(job.id, workerId, classified.code, classified.message)
      : store.failJobPermanently(job.id, workerId, classified.code, classified.message);
    store.recordAudit({
      actorId,
      tenantId,
      vaultId,
      action: "wanghai.restore",
      outcome: "failure",
      metadata: {
        jobId: job.id,
        attempts: job.attempts,
        errorCode: updated?.errorCode ?? classified.code,
        retryScheduled: updated?.status === "queued",
        cancelled,
      },
    });
    if (!cancelled && retryable && updated?.status === "queued") {
      const retry = setTimeout(() => {
        void resumeDurableVaultJobs();
      }, 1_000);
      retry.unref();
    }
  } finally {
    clearInterval(heartbeat);
    if (cleanupContainer && containerName) {
      await removeWanghaiRestoreContainer(containerName);
    }
    if (cleanupStagingVolume && stagingVolume) {
      await removeWanghaiRestoreStagingVolume(stagingVolume);
    }
  }
}

async function executeClaimedWanghaiRestoreActivationJob(
  job: DurableJob,
  workerId: string,
): Promise<void> {
  const tenantId = job.tenantId?.trim();
  const vaultId = job.vaultId?.trim();
  const store = getPolarisControlStore(import.meta.url);
  if (!tenantId || !vaultId) {
    store.failJobPermanently(
      job.id,
      workerId,
      "restore-activation-job-invalid",
      "Wanghai restore activation job is missing tenant or vault identity",
    );
    store.recordAudit({
      action: "wanghai.restore.activate",
      outcome: "failure",
      metadata: { jobId: job.id, errorCode: "restore-activation-job-invalid" },
    });
    return;
  }
  const actorId = durableJobActorId(job, tenantId);
  if (store.isJobCancellationRequested(job.id)) {
    const updated = store.failJob(
      job.id,
      workerId,
      "restore-activation-cancelled",
      "Wanghai restore activation was cancelled",
      0,
    );
    store.recordAudit({
      actorId,
      tenantId,
      vaultId,
      action: "wanghai.restore.activate",
      outcome: "failure",
      metadata: {
        jobId: job.id,
        errorCode: updated?.errorCode ?? "durable-job-cancelled",
        cancelled: true,
      },
    });
    return;
  }

  let cleanupContainer = false;
  let containerName: string | undefined;
  const leaseMs = durableJobLeaseMs();
  const heartbeat = setInterval(() => {
    store.heartbeatJob(job.id, workerId, leaseMs);
  }, Math.max(10_000, Math.floor(leaseMs / 4)));
  heartbeat.unref();
  try {
    containerName = wanghaiRestoreActivationContainerName(job.id);
    await withVaultLifecycleLock(import.meta.url, tenantId, vaultId, async () => {
      if (store.isJobCancellationRequested(job.id)) {
        throw new WanghaiRestoreLifecycleContainerError(
          "restore-activation-cancelled",
          "Wanghai restore activation was cancelled",
          false,
          false,
        );
      }
      const vault = resolveWanghaiRestoreVault(tenantId, vaultId);
      const restoreJobId = String(job.payload.restoreJobId ?? "");
      const source = resolveWanghaiRestoreActivationSource({
        tenantId,
        vaultId,
        restoreJobId,
        vault,
      });
      const completed = await withStoppedWanghaiRestoreVault({
        tenantId,
        vaultId,
        execute: () => executeWanghaiRestoreActivationContainer({
          vault,
          job,
          restoreJobId: source.restoreJobId,
          stagingVolume: source.stagingVolume,
          isCancelled: () => store.isJobCancellationRequested(job.id),
        }),
      });
      if (!store.completeWanghaiRestoreActivation({
        jobId: job.id,
        workerId,
        tenantId,
        vaultId,
        result: completed.result,
      })) {
        if (store.isJobCancellationRequested(job.id)) {
          const updated = store.failJob(
            job.id,
            workerId,
            "restore-activation-cancelled",
            "Wanghai restore activation was cancelled",
            0,
          );
          cleanupContainer = updated?.status === "failed";
          store.recordAudit({
            actorId,
            tenantId,
            vaultId,
            action: "wanghai.restore.activate",
            outcome: "failure",
            metadata: {
              jobId: job.id,
              errorCode: updated?.errorCode ?? "durable-job-cancelled",
              cancelled: true,
            },
          });
          return;
        }
        throw new WanghaiRestoreLifecycleContainerError(
          "restore-activation-job-lease-lost",
          "Lost durable job lease while completing Wanghai restore activation",
          true,
          false,
        );
      }
      cleanupContainer = true;
      store.recordAudit({
        actorId,
        tenantId,
        vaultId,
        action: "wanghai.restore.activate",
        outcome: "success",
        metadata: {
          jobId: job.id,
          attempts: job.attempts,
          restoreJobId: completed.result.restoreJobId,
          checksumVerified: completed.result.checksumVerified,
        },
      });
    });
  } catch (error) {
    logError("executor", "wanghai-restore-activation-worker-failed", {
      tenantId,
      vaultId,
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
    const cancelled = store.isJobCancellationRequested(job.id);
    const classified = cancelled
      ? {
          code: "restore-activation-cancelled",
          message: "Wanghai restore activation was cancelled",
          retryable: false,
          cleanupContainer: error instanceof WanghaiRestoreLifecycleContainerError
            ? error.cleanupContainer
            : false,
        }
      : classifyWanghaiRestoreLifecycleError(error, "activation");
    cleanupContainer = cleanupContainer || classified.cleanupContainer;
    const updated = classified.retryable
      ? store.failJob(job.id, workerId, classified.code, classified.message)
      : store.failJobPermanently(job.id, workerId, classified.code, classified.message);
    store.recordAudit({
      actorId,
      tenantId,
      vaultId,
      action: "wanghai.restore.activate",
      outcome: "failure",
      metadata: {
        jobId: job.id,
        attempts: job.attempts,
        errorCode: updated?.errorCode ?? classified.code,
        retryScheduled: updated?.status === "queued",
        cancelled,
      },
    });
    if (!cancelled && classified.retryable && updated?.status === "queued") {
      const retry = setTimeout(() => {
        void resumeDurableVaultJobs();
      }, 1_000);
      retry.unref();
    }
  } finally {
    clearInterval(heartbeat);
    if (cleanupContainer && containerName) {
      await removeWanghaiRestoreContainer(containerName);
    }
  }
}

async function executeClaimedWanghaiRestoreRollbackJob(
  job: DurableJob,
  workerId: string,
): Promise<void> {
  const tenantId = job.tenantId?.trim();
  const vaultId = job.vaultId?.trim();
  const store = getPolarisControlStore(import.meta.url);
  if (!tenantId || !vaultId) {
    store.failJobPermanently(
      job.id,
      workerId,
      "restore-rollback-job-invalid",
      "Wanghai restore rollback job is missing tenant or vault identity",
    );
    store.recordAudit({
      action: "wanghai.restore.rollback",
      outcome: "failure",
      metadata: { jobId: job.id, errorCode: "restore-rollback-job-invalid" },
    });
    return;
  }
  const actorId = durableJobActorId(job, tenantId);
  if (store.isJobCancellationRequested(job.id)) {
    const updated = store.failJob(
      job.id,
      workerId,
      "restore-rollback-cancelled",
      "Wanghai restore rollback was cancelled",
      0,
    );
    store.recordAudit({
      actorId,
      tenantId,
      vaultId,
      action: "wanghai.restore.rollback",
      outcome: "failure",
      metadata: {
        jobId: job.id,
        errorCode: updated?.errorCode ?? "durable-job-cancelled",
        cancelled: true,
      },
    });
    return;
  }

  let cleanupContainer = false;
  let containerName: string | undefined;
  const leaseMs = durableJobLeaseMs();
  const heartbeat = setInterval(() => {
    store.heartbeatJob(job.id, workerId, leaseMs);
  }, Math.max(10_000, Math.floor(leaseMs / 4)));
  heartbeat.unref();
  try {
    containerName = wanghaiRestoreRollbackContainerName(job.id);
    await withVaultLifecycleLock(import.meta.url, tenantId, vaultId, async () => {
      if (store.isJobCancellationRequested(job.id)) {
        throw new WanghaiRestoreLifecycleContainerError(
          "restore-rollback-cancelled",
          "Wanghai restore rollback was cancelled",
          false,
          false,
        );
      }
      const vault = resolveWanghaiRestoreVault(tenantId, vaultId);
      const activationJobId = String(job.payload.activationJobId ?? "");
      const source = resolveWanghaiRestoreRollbackSource({
        tenantId,
        vaultId,
        activationJobId,
      });
      const completed = await withStoppedWanghaiRestoreVault({
        tenantId,
        vaultId,
        execute: () => executeWanghaiRestoreRollbackContainer({
          vault,
          job,
          activationJobId: source.activationJobId,
          previousWorkspaceName: source.previousWorkspaceName,
          isCancelled: () => store.isJobCancellationRequested(job.id),
        }),
      });
      if (!store.completeWanghaiRestoreRollback({
        jobId: job.id,
        workerId,
        tenantId,
        vaultId,
        activationJobId: source.activationJobId,
        result: completed.result,
      })) {
        if (store.isJobCancellationRequested(job.id)) {
          const updated = store.failJob(
            job.id,
            workerId,
            "restore-rollback-cancelled",
            "Wanghai restore rollback was cancelled",
            0,
          );
          cleanupContainer = updated?.status === "failed";
          store.recordAudit({
            actorId,
            tenantId,
            vaultId,
            action: "wanghai.restore.rollback",
            outcome: "failure",
            metadata: {
              jobId: job.id,
              errorCode: updated?.errorCode ?? "durable-job-cancelled",
              cancelled: true,
            },
          });
          return;
        }
        throw new WanghaiRestoreLifecycleContainerError(
          "restore-rollback-job-lease-lost",
          "Lost durable job lease while completing Wanghai restore rollback",
          true,
          false,
        );
      }
      cleanupContainer = true;
      store.recordAudit({
        actorId,
        tenantId,
        vaultId,
        action: "wanghai.restore.rollback",
        outcome: "success",
        metadata: {
          jobId: job.id,
          attempts: job.attempts,
          activationJobId: completed.result.activationJobId,
          rollbackVerified: completed.result.rollbackVerified,
        },
      });
    });
  } catch (error) {
    logError("executor", "wanghai-restore-rollback-worker-failed", {
      tenantId,
      vaultId,
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
    const cancelled = store.isJobCancellationRequested(job.id);
    const classified = cancelled
      ? {
          code: "restore-rollback-cancelled",
          message: "Wanghai restore rollback was cancelled",
          retryable: false,
          cleanupContainer: error instanceof WanghaiRestoreLifecycleContainerError
            ? error.cleanupContainer
            : false,
        }
      : classifyWanghaiRestoreLifecycleError(error, "rollback");
    cleanupContainer = cleanupContainer || classified.cleanupContainer;
    const updated = classified.retryable
      ? store.failJob(job.id, workerId, classified.code, classified.message)
      : store.failJobPermanently(job.id, workerId, classified.code, classified.message);
    store.recordAudit({
      actorId,
      tenantId,
      vaultId,
      action: "wanghai.restore.rollback",
      outcome: "failure",
      metadata: {
        jobId: job.id,
        attempts: job.attempts,
        errorCode: updated?.errorCode ?? classified.code,
        retryScheduled: updated?.status === "queued",
        cancelled,
      },
    });
    if (!cancelled && classified.retryable && updated?.status === "queued") {
      const retry = setTimeout(() => {
        void resumeDurableVaultJobs();
      }, 1_000);
      retry.unref();
    }
  } finally {
    clearInterval(heartbeat);
    if (cleanupContainer && containerName) {
      await removeWanghaiRestoreContainer(containerName);
    }
  }
}

const DURABLE_WORKER_JOB_KINDS = [
  "vault-provision",
  WANGHAI_BACKUP_JOB_KIND,
  WANGHAI_RESTORE_JOB_KIND,
  WANGHAI_RESTORE_ACTIVATION_JOB_KIND,
  WANGHAI_RESTORE_ROLLBACK_JOB_KIND,
] as const;

async function runDurableJobWorker(workerId: string): Promise<void> {
  const store = getPolarisControlStore(import.meta.url);
  for (;;) {
    const job = store.claimNextJob(workerId, durableJobLeaseMs(), DURABLE_WORKER_JOB_KINDS);
    if (!job) return;
    if (job.kind === "vault-provision") {
      await executeClaimedProvisionJob(job, workerId);
      continue;
    }
    if (job.kind === WANGHAI_BACKUP_JOB_KIND) {
      await executeClaimedWanghaiBackupJob(job, workerId);
      continue;
    }
    if (job.kind === WANGHAI_RESTORE_JOB_KIND) {
      await executeClaimedWanghaiRestoreJob(job, workerId);
      continue;
    }
    if (job.kind === WANGHAI_RESTORE_ACTIVATION_JOB_KIND) {
      await executeClaimedWanghaiRestoreActivationJob(job, workerId);
      continue;
    }
    if (job.kind === WANGHAI_RESTORE_ROLLBACK_JOB_KIND) {
      await executeClaimedWanghaiRestoreRollbackJob(job, workerId);
      continue;
    }
    store.failJobPermanently(
      job.id,
      workerId,
      "durable-job-handler-missing",
      "No durable job handler is registered for this job",
    );
  }
}

/** Resume queued and leased Polaris durable jobs after a process restart. */
export function resumeDurableVaultJobs(): Promise<void> {
  if (durableJobQueueDrain) {
    if (!durableJobDrainFollowup) {
      const activeDrain = durableJobQueueDrain;
      const runFollowup = (): Promise<void> => {
        durableJobDrainFollowup = null;
        return resumeDurableVaultJobs();
      };
      durableJobDrainFollowup = activeDrain.then(runFollowup, runFollowup);
      durableJobDrainFollowup.catch((error) => {
        logError("executor", "durable-job-followup-worker-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return durableJobDrainFollowup;
  }
  const workerCount = durableJobWorkerConcurrency();
  const workers = Array.from({ length: workerCount }, () => {
    durableJobWorkerSequence += 1;
    return runDurableJobWorker(`polaris-${process.pid}-durable-${durableJobWorkerSequence}`);
  });
  durableJobQueueDrain = Promise.all(workers)
    .then(() => undefined)
    .finally(() => {
      durableJobQueueDrain = null;
    });
  durableJobQueueDrain.catch((error) => {
    logError("executor", "durable-job-worker-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return durableJobQueueDrain;
}

export function startDurableJobRecoveryLoop(options?: {
  intervalMs?: number;
  resume?: () => Promise<void>;
  schedule?: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
}): boolean {
  if (durableJobRecoveryTimer) return false;
  const requestedIntervalMs = options?.intervalMs ?? DURABLE_JOB_RECOVERY_INTERVAL_MS;
  const intervalMs = Number.isFinite(requestedIntervalMs)
    ? Math.max(100, Math.floor(requestedIntervalMs))
    : DURABLE_JOB_RECOVERY_INTERVAL_MS;
  const resume = options?.resume ?? resumeDurableVaultJobs;
  const schedule = options?.schedule
    ?? ((callback: () => void, delayMs: number) => setInterval(callback, delayMs));
  durableJobRecoveryTimer = schedule(() => {
    void resume().catch((error) => {
      logError("executor", "durable-job-recovery-cycle-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, intervalMs);
  durableJobRecoveryTimer.unref();
  return true;
}

export function stopDurableJobRecoveryLoop(): void {
  if (!durableJobRecoveryTimer) return;
  clearInterval(durableJobRecoveryTimer);
  durableJobRecoveryTimer = null;
}

export async function switchPortalVault(
  userId: string,
  vault: string,
  target: PortalDriverTarget,
): Promise<SwitchResult> {
  const ref = vaultRefFromTarget(vault, target);
  return performVaultSwitch(ref, userId);
}

export async function deletePortalVault(
  userId: string,
  vault: string,
): Promise<{ deleted: true; vault: string }> {
  return permanentlyDeletePortalVault(userId, vault);
}

export async function permanentlyDeletePortalVault(
  userId: string,
  vault: string,
): Promise<{ deleted: true; vault: string }> {
  writeDirectVaultStatus(userId, vault, (current) => buildVaultStatusFromCurrent({
    vault,
    current,
    driverState: {
      selected: current?.driver?.selected ?? null,
      status: driverStatusForOperation("delete"),
      reason: "vault delete requested",
    },
  }));
  try {
    return await deleteVaultOwnedByUser(userId, vault);
  } catch (error) {
    const summary = loadVaultSummary(userId, vault);
    const selectedDriver = summary.status?.driver?.selected ?? null;
    const ref = selectedDriver
      ? vaultRefFromTarget(vault, selectedDriver)
      : null;
    const message = error instanceof Error ? error.message : String(error);
    logVaultEvent("error", "delete-failed", {
      userId,
      vault,
      ref: ref ?? undefined,
    }, {
      error: message,
    });
    try {
      await refreshPortalVaultStatus(userId, vault);
    } catch (refreshError) {
      logVaultEvent("warn", "delete-failed-refresh", {
        userId,
        vault,
        ref: ref ?? undefined,
      }, {
        error: refreshError instanceof Error ? refreshError.message : String(refreshError),
      });
    }
    throw error;
  }
}

export async function stopPortalVault(
  userId: string,
  vault: string,
): Promise<{ stopped: true }> {
  const summary = loadVaultSummary(userId, vault);
  const selectedDriver = summary.status?.driver?.selected ?? null;
  if (!selectedDriver) {
    throw new Error(`Vault '${vault}' does not have a selected driver`);
  }
  const ref = vaultRefFromTarget(vault, selectedDriver);
  writeCachedVaultStatusUpdate({
    userId,
    vault,
    reason: "vault-stopping",
    mutate: (current, currentSummary) => {
      if (!current) {
        return null;
      }
      return buildVaultStatusFromCurrent({
        vault,
        current,
        driver: current.driver
          ? {
              ...current.driver,
              selected: currentSummary.status?.driver?.selected
                ?? current.driver.selected,
            }
          : current.driver,
        driverState: {
          selected: current.driver?.selected ?? null,
          status: driverStatusForOperation("stop"),
          reason: "vault stop requested",
        },
      });
    },
  });
  const jobKey = vaultJobKey(userId, vault);
  if (stopJobs.has(jobKey)) {
    logInfo("executor", "vault-stop-joined", {
      userId,
      vault,
      ref,
    });
    return { stopped: true };
  }
    logVaultEvent("info", "stop-queued", {
      userId,
      vault,
      ref,
  });
  const job = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      void withVaultLifecycleLock(import.meta.url, userId, vault, async () => {
        await measureVaultPhase({
          context: { userId, vault, ref, backend: selectedDriver.backend, profile: selectedDriver.profile },
          phase: "stop-vault",
          execute: async () => {
            await stopCommand(ref, userId);
            await refreshPortalVaultStatus(userId, vault);
          },
        });
      }).then(resolve, reject);
    }, 0);
  })
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logVaultEvent("error", "stop-failed", {
        userId,
        vault,
        ref,
      }, {
        error: message,
      });
      try {
        await refreshPortalVaultStatus(userId, vault);
      } catch (refreshError) {
        logVaultEvent("warn", "stop-failed-refresh", {
          userId,
          vault,
          ref,
        }, {
          error: refreshError instanceof Error ? refreshError.message : String(refreshError),
        });
      }
      throw error;
    })
    .finally(() => {
      stopJobs.delete(jobKey);
    });
  stopJobs.set(jobKey, job);
  await job;
  return { stopped: true };
}

export async function startPortalVault(
  userId: string,
  vault: string,
): Promise<{ started: true }> {
  const summary = loadVaultSummary(userId, vault);
  const selectedDriver = summary.status?.driver?.selected ?? null;
  if (!selectedDriver) {
    throw new Error(`Vault '${vault}' does not have a selected driver`);
  }
  const ref = vaultRefFromTarget(vault, selectedDriver);
  try {
    return await withVaultLifecycleLock(import.meta.url, userId, vault, async () => {
      writeCachedVaultStatusUpdate({
        userId,
        vault,
        reason: "vault-starting",
        mutate: (current, currentSummary) => {
          if (!current) {
            return null;
          }
          return buildVaultStatusFromCurrent({
            vault,
            current,
            driver: current.driver
            ? {
                ...current.driver,
                  selected: currentSummary.status?.driver?.selected
                    ?? current.driver.selected,
              }
            : current.driver,
            driverState: {
              selected: current.driver?.selected ?? null,
              status: driverStatusForOperation("start"),
              reason: "vault start requested",
            },
          });
        },
      });
      await measureVaultPhase({
        context: { userId, vault, ref, backend: selectedDriver.backend, profile: selectedDriver.profile },
        phase: "start-vault",
        execute: async () => {
          await startCommand(ref, userId);
          await refreshPortalVaultStatus(userId, vault);
        },
      });
      return { started: true };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logVaultEvent("error", "start-failed", {
      userId,
      vault,
      ref,
    }, {
      error: message,
    });
    try {
      await refreshPortalVaultStatus(userId, vault);
    } catch (refreshError) {
      logVaultEvent("warn", "start-failed-refresh", {
        userId,
        vault,
        ref,
      }, {
        error: refreshError instanceof Error ? refreshError.message : String(refreshError),
      });
    }
    throw error;
  }
}

export async function rebuildPortalVault(
  userId: string,
  vault: string,
): Promise<{ rebuilt: true }> {
  const summary = loadVaultSummary(userId, vault);
  const selectedDriver = summary.status?.driver?.selected ?? null;
  if (!selectedDriver) {
    throw new Error(`Vault '${vault}' does not have a selected driver`);
  }
  const ref = vaultRefFromTarget(vault, selectedDriver);
  try {
    writeCachedVaultStatusUpdate({
      userId,
      vault,
      reason: "vault-rebuilding",
      mutate: (current, currentSummary) => {
        if (!current) {
          return null;
        }
        return buildVaultStatusFromCurrent({
          vault,
          current,
          driver: current.driver
            ? {
                ...current.driver,
                selected: currentSummary.status?.driver?.selected
                  ?? current.driver.selected,
              }
            : current.driver,
          driverState: {
            selected: current.driver?.selected ?? null,
            status: driverStatusForOperation("rebuild"),
            reason: "vault rebuild requested",
          },
        });
      },
    });
    await measureVaultPhase({
      context: { userId, vault, ref, backend: selectedDriver.backend, profile: selectedDriver.profile },
      phase: "rebuild-vault",
      execute: async () => {
        await rebuildCommand(ref, userId);
        await refreshPortalVaultStatus(userId, vault);
      },
    });
    return { rebuilt: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logVaultEvent("error", "rebuild-failed", {
      userId,
      vault,
      ref,
    }, {
      error: message,
    });
    try {
      await refreshPortalVaultStatus(userId, vault);
    } catch (refreshError) {
      logVaultEvent("warn", "rebuild-failed-refresh", {
        userId,
        vault,
        ref,
      }, {
        error: refreshError instanceof Error ? refreshError.message : String(refreshError),
      });
    }
    throw error;
  }
}

export async function switchPortalVaultLiveCredential(input: {
  userId: string;
  vault: string;
  harness: ManagedHarness;
  credentialId: string;
}): Promise<{
  switched: true;
  driver: string;
  credentialId: string;
}> {
  return withVaultLifecycleLock(
    import.meta.url,
    input.userId,
    input.vault,
    async () => {
      if (!supportsLiveCredentialSwitch(input.harness)) {
        throw new Error(
          `Live credential switching is not supported for harness '${input.harness}'`,
        );
      }
      const summary = loadVaultSummary(input.userId, input.vault);
      const target = summary.status?.driver?.selected ?? null;
      if (!target) {
        throw new Error(
          `Vault '${input.vault}' does not have a selected driver`,
        );
      }
      const vaultSpec = loadPortalVaultByTarget(
        input.userId,
        input.vault,
        target,
      );
      if (
        vaultSpec.backend.kind !== "docker" &&
        vaultSpec.backend.kind !== "pod"
      ) {
        throw new Error(
          `Live credential switching is not supported for backend '${vaultSpec.backend.kind}'`,
        );
      }
      const observation = await getBackendDriver(vaultSpec.backend.kind).inspect(
        vaultSpec,
      );
      if (!observation.backend.exists || !observation.backend.running) {
        throw new Error(
          `Vault '${input.vault}' is not running on ${vaultSpec.backend.kind}`,
        );
      }
      switchVaultLiveCredentialMaterial({
        vault: vaultSpec,
        userId: input.userId,
        credentialId: input.credentialId,
        harness: input.harness,
        requireSupported: true,
      });
      const ref = vaultRefFromTarget(input.vault, target);
      writeCachedVaultStatusUpdate({
        userId: input.userId,
        vault: input.vault,
        reason: "live-credential-switched",
        mutate: (current) => {
          if (!current?.credentials?.live) {
            return current;
          }
          const selectedByHarness = {
            ...(current.credentials.live.selectedByHarness ?? {}),
            [input.harness]: {
              credentialId: input.credentialId,
              label:
                current.credentials.live.selectedByHarness?.[input.harness]
                  ?.label ?? input.credentialId,
              source: "runtime-state" as const,
            },
          };
          return {
            ...current,
            credentials: {
              ...current.credentials,
              live: {
                ...current.credentials.live,
                selectedHarness: input.harness,
                selectedCredentialId: input.credentialId,
                selectedCredentialLabel: selectedByHarness[input.harness].label,
                source: "runtime-state",
                selectedByHarness,
              },
            },
          };
        },
      });
      void refreshPortalVaultStatus(input.userId, input.vault);
      return {
        switched: true,
        driver: ref,
        credentialId: input.credentialId,
      };
    },
  );
}

export async function getPortalVaultPaseoDiagnostic(input: {
  userId: string;
  vault: string;
}): Promise<PortalVaultPaseoDiagnostic> {
  return withVaultLifecycleLock(import.meta.url, input.userId, input.vault, async () =>
    collectVaultPaseoDiagnostic(input.userId, input.vault)
  );
}

export async function restartPortalVaultPaseoDaemon(input: {
  userId: string;
  vault: string;
}): Promise<{
  restarted: true;
  diagnostic: PortalVaultPaseoDiagnostic;
}> {
  return withVaultLifecycleLock(
    import.meta.url,
    input.userId,
    input.vault,
    async () => {
      const summary = loadVaultSummary(input.userId, input.vault);
      const target = summary.status?.driver?.selected ?? null;
      if (!target) {
        throw new Error(`Vault '${input.vault}' does not have a selected driver`);
      }
      const loaded = loadPortalVaultByTarget(input.userId, input.vault, target);
      runVaultShell(
        loaded,
        [
          "paseo_pid=$(sed -n 's/.*\"pid\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' /root/.paseo/paseo.pid 2>/dev/null | head -n 1)",
          "if [ -z \"$paseo_pid\" ]; then paseo_pid=$(cat /root/.paseo/paseo.pid 2>/dev/null | tr -cd '0-9'); fi",
          "if [ -n \"$paseo_pid\" ]; then pkill -TERM -P \"$paseo_pid\" 2>/dev/null || true; kill \"$paseo_pid\" 2>/dev/null || true; sleep 1; pkill -KILL -P \"$paseo_pid\" 2>/dev/null || true; kill -KILL \"$paseo_pid\" 2>/dev/null || true; fi",
          "rm -f /root/.paseo/paseo.pid /root/.paseo/daemon.log",
          "PASEO_HOME=/root/.paseo paseo daemon start --listen 0.0.0.0:6767",
        ].join("; "),
      );
      const diagnostic = collectVaultPaseoDiagnostic(input.userId, input.vault);
      return {
        restarted: true,
        diagnostic,
      };
    },
  );
}

export async function healthCheckPortalVaultExecutor(
  baseUrl: string,
  headers: HeadersInit,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/health`, {
      method: "GET",
      headers,
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Polaris executor health check failed for ${baseUrl}/health: ${cause}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Polaris executor health check failed (${response.status} ${response.statusText}) for ${baseUrl}/health: ${await response.text()}`,
    );
  }
  const payload = await response.json() as { ok?: boolean };
  if (payload.ok !== true) {
    throw new Error(
      `Polaris executor health check returned an unexpected payload for ${baseUrl}/health`,
    );
  }
}
