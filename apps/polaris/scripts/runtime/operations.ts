import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

const REPO_ROOT = repoRoot(import.meta.url);
const USER_ROOT = polarisUsersRoot(import.meta.url);
const provisionJobs = new Map<string, Promise<void>>();
const statusRefreshJobs = new Map<string, Promise<void>>();
const stopJobs = new Map<string, Promise<void>>();
let provisionQueueDrain: Promise<void> | null = null;
let provisionWorkerSequence = 0;

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

function provisionJobLeaseMs(): number {
  const raw = Number.parseInt(String(process.env.POLARIS_JOB_LEASE_MS ?? ""), 10);
  if (!Number.isFinite(raw)) return 30 * 60 * 1_000;
  return Math.max(60_000, Math.min(6 * 60 * 60 * 1_000, raw));
}

function provisionJobConcurrency(): number {
  const raw = Number.parseInt(String(process.env.POLARIS_JOB_CONCURRENCY ?? ""), 10);
  if (!Number.isFinite(raw)) return 2;
  return Math.max(1, Math.min(4, raw));
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
      const finalRef = vaultRefFromTarget(
        vault,
        summary.status?.driver?.selected ?? { backend: "docker" },
      );
      await captureStdout(() => statusCommand(finalRef, userId));
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
  const leaseMs = provisionJobLeaseMs();
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

async function runProvisionWorker(workerId: string): Promise<void> {
  const store = getPolarisControlStore(import.meta.url);
  for (;;) {
    const job = store.claimNextJob(workerId, provisionJobLeaseMs());
    if (!job) return;
    if (job.kind !== "vault-provision") {
      store.failJobPermanently(
        job.id,
        workerId,
        "unsupported-job-kind",
        `Unsupported durable job kind '${job.kind}'`,
      );
      continue;
    }
    await executeClaimedProvisionJob(job, workerId);
  }
}

/** Resume queued/leased provisioning after a Polaris process restart. */
export function resumeDurableVaultJobs(): Promise<void> {
  if (provisionQueueDrain) return provisionQueueDrain;
  const workerCount = provisionJobConcurrency();
  const workers = Array.from({ length: workerCount }, () => {
    provisionWorkerSequence += 1;
    return runProvisionWorker(`polaris-${process.pid}-provision-${provisionWorkerSequence}`);
  });
  provisionQueueDrain = Promise.all(workers)
    .then(() => undefined)
    .finally(() => {
      provisionQueueDrain = null;
    });
  provisionQueueDrain.catch((error) => {
    logError("executor", "durable-provision-worker-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return provisionQueueDrain;
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
