import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureCanonicalWorkspaceImage, ensureWorkspaceConfig } from "../config/provision.js";
import { assertProjectNameAvailableForUser } from "../config/project-ownership.js";
import { userProfileExists, workspaceConfigExists, workspaceConfigPath } from "../config/scaffold.js";
import { readManagedCredentialRecord } from "../config/credentials.js";
import {
  supportsLiveCredentialSwitch,
  type ManagedHarness,
} from "../config/credential-catalog.js";
import {
  SKILL_HARNESSES,
  isSkillHarness,
  listInstalledWorkspaceSkills,
  listUserSkills,
  readUserSkill,
  removeInstalledWorkspaceSkill,
  resolveWorkspaceSkillInstallRoot,
  type SkillHarness,
} from "../config/skills.js";
import {
  defaultMountPathForCredentialFile,
  stateStoragePathForMountPath,
} from "../core/identity-layout.js";
import {
  loadWorkspaceDetail,
  loadPortalWorkspaceByTarget,
  loadWorkspaceSummary,
  type PortalDriverTarget,
  type PortalWorkspaceDetail,
  type PortalWorkspacePaseoDiagnostic,
  updatePortalWorkspaceAgentBinding,
  workspaceRefFromTarget,
} from "../core/portal.js";
import { loadWorkspaceFromConfigPath } from "../config/load.js";
import { createWorkspaceForUser } from "../cli/commands/create.js";
import { performWorkspaceSwitch, type SwitchResult } from "../cli/commands/switch.js";
import {
  archiveWorkspaceOwnedByUser,
  deleteArchivedWorkspaceOwnedByUser,
  deleteWorkspaceOwnedByUser,
} from "../cli/commands/delete.js";
import {
  loadExecutableWorkspaceForCommand,
  loadWorkspaceForCommand,
} from "../cli/commands/shared.js";
import { startCommand } from "../cli/commands/start.js";
import { statusCommand } from "../cli/commands/status.js";
import { stopCommand } from "../cli/commands/stop.js";
import { rebuildCommand } from "../cli/commands/rebuild.js";
import { renderAndWriteDockerWorkspace } from "../backends/docker/render.js";
import { renderAndWritePodWorkspace } from "../backends/pod/render.js";
import { renderAndWriteKubevirtWorkspace } from "../backends/kubevirt/render.js";
import { getBackendDriver } from "../backends/index.js";
import type { WorkspaceCommandKind, WorkspaceSpec, WorkspaceStatus } from "../core/workspace.js";
import { workspaceRuntimeScopeName } from "../core/workspace-name.js";
import {
  parsePaseoDaemonStatus,
} from "../core/paseo.js";
import {
  writeWorkspaceLiveCredentialSelection,
  writeWorkspacePaseoPairing,
  writeWorkspacePaseoServerId,
  writeWorkspaceStatus,
} from "../output/state-store.js";
import { logError, logInfo, logWarn } from "../utils/log.js";
import { polarisUsersRoot, repoRoot } from "../utils/paths.js";
import { logWorkspaceEvent, measureWorkspacePhase } from "../utils/workspace-log.js";
import { withUserMutationLock } from "../utils/user-mutation-lock.js";
import {
  withWorkspaceLifecycleLock,
  withWorkspaceMutationLock,
} from "../utils/workspace-lifecycle-lock.js";

const REPO_ROOT = repoRoot(import.meta.url);
const USER_ROOT = polarisUsersRoot(import.meta.url);
const provisionJobs = new Map<string, Promise<void>>();
const statusRefreshJobs = new Map<string, Promise<void>>();
const stopJobs = new Map<string, Promise<void>>();

type WorkspaceOperationKind = NonNullable<WorkspaceStatus["operation"]>["kind"];

function workspaceJobKey(userId: string, workspace: string): string {
  return `${userId.trim()}:${workspace.trim()}`;
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
  workspace: string,
  phase: string,
): Promise<void> {
  const delayMs = provisionStepDelayMs();
  if (!delayMs) {
    return;
  }
  logInfo("executor", "workspace-provision-step-delay", {
    userId,
    workspace,
    phase,
    delayMs,
  });
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function rootKey(userId: string, workspace: string): string {
  return `${userId}:${workspace}`;
}

function pendingWorkspaceOperation(kind: WorkspaceOperationKind): NonNullable<WorkspaceStatus["operation"]> {
  return {
    kind,
    updatedAt: new Date().toISOString(),
  };
}

function buildWorkspaceStatusFromCurrent(args: {
  workspace: string;
  current: WorkspaceStatus | null;
  health?: Partial<WorkspaceStatus["health"]>;
  driver?: WorkspaceStatus["driver"];
  operation?: WorkspaceStatus["operation"] | null;
  credentials?: WorkspaceStatus["credentials"];
  details?: WorkspaceStatus["details"];
  evolution?: WorkspaceStatus["evolution"];
  assets?: WorkspaceStatus["assets"];
  attachments?: WorkspaceStatus["attachments"];
  runtimeAssembly?: WorkspaceStatus["runtimeAssembly"];
}): WorkspaceStatus {
  return {
    project: args.workspace,
    ...(args.driver ?? args.current?.driver ? { driver: args.driver ?? args.current?.driver } : {}),
    ...(args.operation === null
      ? {}
      : args.operation ?? args.current?.operation
        ? { operation: args.operation ?? args.current?.operation }
        : {}),
    health: {
      backendLiveness: args.health?.backendLiveness ?? args.current?.health.backendLiveness ?? "unknown",
      workspaceReadiness: args.health?.workspaceReadiness ?? args.current?.health.workspaceReadiness ?? "unknown",
      ...(Object.prototype.hasOwnProperty.call(args.health ?? {}, "reason")
        ? { reason: args.health?.reason }
        : args.current?.health.reason
          ? { reason: args.current.health.reason }
          : {}),
    },
    credentials: args.credentials ?? args.current?.credentials,
    details: args.details ?? args.current?.details ?? {},
    evolution: args.evolution ?? args.current?.evolution,
    assets: args.assets ?? args.current?.assets,
    attachments: args.attachments ?? args.current?.attachments,
    runtimeAssembly: args.runtimeAssembly ?? args.current?.runtimeAssembly,
  };
}

function portalRoot(userId: string, workspace: string): string {
  return path.join(USER_ROOT, userId, "workspaces", workspace);
}

function clearProvisionState(userId: string, workspace: string): void {
  fs.rmSync(path.join(portalRoot(userId, workspace), "state", "provision.json"), {
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
      errorCode: "workspace-provision-cancelled",
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
  if (/docker compose|workspace .* does not have a selected driver|Image '.*' is not available/i.test(message)) {
    return {
      message,
      errorCode: "workspace-runtime-failed",
      retryable: true,
    };
  }
  return {
    message,
    errorCode: "workspace-provision-failed",
    retryable: true,
  };
}

function writeDirectWorkspaceStatus(
  userId: string,
  workspace: string,
  mutate: (current: WorkspaceStatus | null) => WorkspaceStatus,
): WorkspaceStatus {
  const current = loadWorkspaceSummary(userId, workspace).status;
  const next = mutate(current);
  writeWorkspaceStatus(next, userId);
  return next;
}

function isStoppedContainerStatusRefreshError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("cannot exec in a stopped state");
}

function writeCachedWorkspaceStatusUpdate(args: {
  userId: string;
  workspace: string;
  mutate: (current: WorkspaceStatus | null, summary: PortalWorkspaceDetail | ReturnType<typeof loadWorkspaceSummary>) => WorkspaceStatus | null;
  reason: string;
}): void {
  const summary = loadWorkspaceSummary(args.userId, args.workspace);
  const next = args.mutate(summary.status, summary);
  if (!next) {
    return;
  }
  writeWorkspaceStatus(next, args.userId);
  logInfo("executor", "workspace-status-cached", {
    userId: args.userId,
    workspace: args.workspace,
    reason: args.reason,
    backendLiveness: next.health.backendLiveness,
    workspaceReadiness: next.health.workspaceReadiness,
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

function loadUserWorkspace(
  userId: string,
  workspace: string,
  backend: "docker" | "pod" | "kubevirt-vm",
  profileHint?: string,
): WorkspaceSpec {
  const projectRef =
    backend === "pod" && profileHint
      ? `${workspace}@${backend}:${profileHint}`
      : `${workspace}@${backend}`;
  const ensuredConfig = ensureWorkspaceConfig(projectRef, userId);
  const configPath =
    ensuredConfig?.configPath ?? workspaceConfigPath(workspace, backend, userId);
  return loadWorkspaceFromConfigPath(
    configPath,
    workspace,
    backend,
    profileHint,
  );
}

function runWorkspaceShell(workspace: WorkspaceSpec, script: string): { stdout: string; stderr: string } {
  const scope = workspaceRuntimeScopeName(
    workspace.userProfile.id,
    workspace.identity.projectName,
  );
  switch (workspace.backend.kind) {
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
      throw new Error(`Paseo daemon diagnostics are not supported for backend '${workspace.backend.kind}' yet`);
  }
}

function listWorkspaceSkillsScript(root: string): string {
  return [
    "set -euo pipefail",
    `if [ ! -d ${q(root)} ]; then exit 0; fi`,
    `find ${q(root)} -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' | sort`,
  ].join("\n");
}

async function listInstalledWorkspaceSkillsResolved(args: {
  workspace: WorkspaceSpec;
  harness?: SkillHarness;
}): Promise<Array<{ harness: SkillHarness; skills: string[] }>> {
  const harnesses = args.harness ? [args.harness] : [...SKILL_HARNESSES];
  const runningSupported =
    (args.workspace.backend.kind === "docker" || args.workspace.backend.kind === "pod");
  if (!runningSupported) {
    const installed = listInstalledWorkspaceSkills(args);
    logInfo("executor", "workspace-skill-list-resolved", {
      userId: args.workspace.userProfile.id,
      workspace: args.workspace.identity.projectName,
      backend: args.workspace.backend.kind,
      mode: "host-fallback-unsupported-backend",
      installed,
    });
    return installed;
  }
  const observation = await getBackendDriver(args.workspace.backend.kind).inspect(args.workspace);
  if (!observation.backend.exists || !observation.backend.running) {
    const installed = listInstalledWorkspaceSkills(args);
    logInfo("executor", "workspace-skill-list-resolved", {
      userId: args.workspace.userProfile.id,
      workspace: args.workspace.identity.projectName,
      backend: args.workspace.backend.kind,
      mode: "host-fallback-not-running",
      backendExists: observation.backend.exists,
      backendRunning: observation.backend.running,
      installed,
    });
    return installed;
  }
  const installed = harnesses.map((harness) => {
    const root = resolveWorkspaceSkillInstallRoot(args.workspace, harness);
    const output = runWorkspaceShell(
      args.workspace,
      listWorkspaceSkillsScript(root),
    ).stdout;
    const skills = output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith("."))
      .sort((left, right) => left.localeCompare(right));
    return { harness, skills };
  });
  logInfo("executor", "workspace-skill-list-resolved", {
    userId: args.workspace.userProfile.id,
    workspace: args.workspace.identity.projectName,
    backend: args.workspace.backend.kind,
    mode: "runtime-exec",
    installed,
  });
  return installed;
}

function removeWorkspaceSkillScript(root: string, skillId: string): string {
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

async function removeInstalledWorkspaceSkillResolved(args: {
  workspace: WorkspaceSpec;
  harness: SkillHarness;
  skillId: string;
}): Promise<{ harness: SkillHarness; skillId: string; removed: boolean }> {
  const runningSupported =
    (args.workspace.backend.kind === "docker" || args.workspace.backend.kind === "pod");
  if (!runningSupported) {
    return removeInstalledWorkspaceSkill(args);
  }
  const observation = await getBackendDriver(args.workspace.backend.kind).inspect(args.workspace);
  if (!observation.backend.exists || !observation.backend.running) {
    return removeInstalledWorkspaceSkill(args);
  }
  const root = resolveWorkspaceSkillInstallRoot(args.workspace, args.harness);
  const output = runWorkspaceShell(
    args.workspace,
    removeWorkspaceSkillScript(root, args.skillId),
  ).stdout.trim();
  return {
    harness: args.harness,
    skillId: args.skillId,
    removed: output === "true",
  };
}

function workspaceSkillInstallScript(args: {
  workspace: WorkspaceSpec;
  harness: SkillHarness;
  packageName: string;
  commandArgs: string[];
  skillId: string;
}): string {
  const installRoot = resolveWorkspaceSkillInstallRoot(args.workspace, args.harness);
  const assistantHome = path.posix.dirname(installRoot);
  const installTarget = path.posix.join(installRoot, args.skillId);
  const scratchHome = path.posix.join(
    args.workspace.attachments.workspaceData.mountRoot,
    ".runtime",
    "skills",
    args.workspace.identity.projectName,
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

function workspaceSkillInstallDebug(args: {
  workspace: WorkspaceSpec;
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
  const installRoot = resolveWorkspaceSkillInstallRoot(args.workspace, args.harness);
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

function assertWorkspaceSkillRuntimeSupported(workspace: WorkspaceSpec): void {
  if (workspace.backend.kind !== "docker" && workspace.backend.kind !== "pod") {
    throw new Error(
      `Workspace skill operations are not supported for backend '${workspace.backend.kind}'`,
    );
  }
}

async function loadRunningWorkspaceForSkillAction(args: {
  workspaceRef: string;
  userProfileId?: string;
}): Promise<WorkspaceSpec> {
  const { workspace } = loadWorkspaceForCommand(
    "status",
    args.workspaceRef,
    args.userProfileId,
  );
  assertWorkspaceSkillRuntimeSupported(workspace);
  const observation = await getBackendDriver(workspace.backend.kind).inspect(workspace);
  if (!observation.backend.exists || !observation.backend.running) {
    throw new Error(
      `Workspace '${workspace.identity.projectName}' is not running on ${workspace.backend.kind}`,
    );
  }
  return workspace;
}

function mutateWorkspaceSkillStatus(args: {
  userId: string;
  workspace: string;
  reason: string;
  installed: Array<{ harness: SkillHarness; skills: string[] }>;
}): void {
  writeCachedWorkspaceStatusUpdate({
    userId: args.userId,
    workspace: args.workspace,
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
          source: "workspace-runtime-state",
        },
      } as WorkspaceStatus & {
        skills: {
          installedByHarness: Record<string, string[]>;
          source: string;
        };
      };
    },
  });
}

function collectWorkspacePaseoDiagnostic(
  userId: string,
  workspace: string,
): PortalWorkspacePaseoDiagnostic {
  const summary = loadWorkspaceSummary(userId, workspace);
  const target = summary.selectedDriver;
  if (!target) {
    throw new Error(`Workspace '${workspace}' does not have a selected driver`);
  }
  const loaded = loadPortalWorkspaceByTarget(userId, workspace, target);
  const daemonStatusRaw = runWorkspaceShell(
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
  workspace: WorkspaceSpec,
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
        workspace.runtime.home,
        file.key,
      );
    const targetPath = stateStoragePathForMountPath({
      mountPath,
      runtimeHome: workspace.runtime.home,
      identityRoot: workspace.attachments.userIdentityState.mountRoot,
    });
    if (
      !targetPath
      || !targetPath.startsWith(
        `${workspace.attachments.userIdentityState.mountRoot}/`,
      )
    ) {
      throw new Error(
        `Credential '${credentialId}' file '${file.key}' does not map into workspace identity state`,
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
  workspace: WorkspaceSpec,
  files: Array<{ path: string; content: string }>,
): string {
  const payload = JSON.stringify(
    files.map((file) => ({
      path: file.path,
      content: Buffer.from(file.content, "utf8").toString("base64"),
    })),
  );
  const runtimeUser = workspace.runtime.user.trim() || "root";
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

function dockerContainerName(workspace: WorkspaceSpec): string {
  return `${workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName)}-docker`;
}

function runtimeScope(workspace: WorkspaceSpec): string {
  return workspaceRuntimeScopeName(workspace.userProfile.id, workspace.identity.projectName);
}

function runningPodName(workspace: WorkspaceSpec): string {
  return runChecked(
    "kubectl",
    [
      "-n",
      runtimeScope(workspace),
      "get",
      "pod",
      "-l",
      `app=${runtimeScope(workspace)}`,
      "-o",
      "jsonpath={.items[0].metadata.name}",
    ],
  ).stdout.trim();
}

function applyLiveRuntimeFiles(
  workspace: WorkspaceSpec,
  files: Array<{ path: string; content: string }>,
): void {
  const script = runtimeWriteScript(workspace, files);
  if (workspace.backend.kind === "docker") {
    const containerName = dockerContainerName(workspace);
    runChecked("docker", ["exec", containerName, "sh", "-lc", script]);
    return;
  }
  if (workspace.backend.kind === "pod") {
    const podName = runningPodName(workspace);
    if (!podName) {
      throw new Error(
        `Workspace '${workspace.identity.projectName}' does not have a running pod`,
      );
    }
    runChecked(
      "kubectl",
      [
        "-n",
        runtimeScope(workspace),
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
    `Live credential switching is not supported for backend '${workspace.backend.kind}'`,
  );
}

export function switchWorkspaceLiveCredentialMaterial(input: {
  workspace: WorkspaceSpec;
  userId: string;
  credentialId: string;
  harness?: ManagedHarness;
  requireSupported?: boolean;
}): {
  harness: ManagedHarness;
  credentialId: string;
} {
  const resolved = liveRuntimeCredentialFiles(
    input.workspace,
    input.userId,
    input.credentialId,
    input.harness,
    input.requireSupported ?? false,
  );
  applyLiveRuntimeFiles(input.workspace, resolved.files);
  writeWorkspaceLiveCredentialSelection(
    input.workspace.identity.projectName,
    resolved.harness,
    input.credentialId,
    input.userId,
  );
  return {
    harness: resolved.harness,
    credentialId: input.credentialId,
  };
}

export async function listWorkspaceSkills(input: {
  workspaceRef: string;
  userProfileId?: string;
  harness?: SkillHarness;
}): Promise<{
  workspace: string;
  userId: string;
  installed: Array<{ harness: SkillHarness; skills: string[] }>;
}> {
  const { workspace } = loadWorkspaceForCommand(
    "status",
    input.workspaceRef,
    input.userProfileId,
  );
  const installed = await listInstalledWorkspaceSkillsResolved({
    workspace,
    ...(input.harness ? { harness: input.harness } : {}),
  });
  return {
    workspace: workspace.identity.projectName,
    userId: workspace.userProfile.id,
    installed,
  };
}

export async function skillInstallWorkspace(input: {
  workspaceRef: string;
  userProfileId?: string;
  harness: SkillHarness;
  skillId: string;
}): Promise<{
  installed: true;
  workspace: string;
  userId: string;
  harness: SkillHarness;
  skillId: string;
  packageName: string;
}> {
  const workspace = await loadRunningWorkspaceForSkillAction(input);
  const skill = readUserSkill(workspace.userProfile.id, input.skillId);
  if (skill.harness !== input.harness) {
    throw new Error(
      `Skill '${input.skillId}' belongs to harness '${skill.harness}', not '${input.harness}'`,
    );
  }
  const debug = workspaceSkillInstallDebug({
    workspace,
    harness: input.harness,
    packageName: skill.packageName,
    commandArgs: skill.args,
    skillId: skill.id,
  });
  logInfo("executor", "workspace-skill-install-command", {
    userId: workspace.userProfile.id,
    workspace: workspace.identity.projectName,
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
  runWorkspaceShell(
    workspace,
    workspaceSkillInstallScript({
      workspace,
      harness: input.harness,
      packageName: skill.packageName,
      commandArgs: skill.args,
      skillId: skill.id,
    }),
  );
  const installed = await listInstalledWorkspaceSkillsResolved({
    workspace,
    harness: input.harness,
  });
  mutateWorkspaceSkillStatus({
    userId: workspace.userProfile.id,
    workspace: workspace.identity.projectName,
    reason: "workspace-skill-installed",
    installed,
  });
  return {
    installed: true,
    workspace: workspace.identity.projectName,
    userId: workspace.userProfile.id,
    harness: input.harness,
    skillId: skill.id,
    packageName: skill.packageName,
  };
}

export async function skillUninstallWorkspace(input: {
  workspaceRef: string;
  userProfileId?: string;
  harness: SkillHarness;
  skillId: string;
}): Promise<{
  uninstalled: true;
  workspace: string;
  userId: string;
  harness: SkillHarness;
  skillId: string;
  removed: boolean;
}> {
  const workspace = await loadRunningWorkspaceForSkillAction(input);
  const removed = await removeInstalledWorkspaceSkillResolved({
    workspace,
    harness: input.harness,
    skillId: input.skillId,
  });
  const installed = await listInstalledWorkspaceSkillsResolved({
    workspace,
    harness: input.harness,
  });
  mutateWorkspaceSkillStatus({
    userId: workspace.userProfile.id,
    workspace: workspace.identity.projectName,
    reason: "workspace-skill-uninstalled",
    installed,
  });
  return {
    uninstalled: true,
    workspace: workspace.identity.projectName,
    userId: workspace.userProfile.id,
    harness: input.harness,
    skillId: input.skillId,
    removed: removed.removed,
  };
}

export async function skillSyncWorkspace(input: {
  workspaceRef: string;
  userProfileId?: string;
  harness: SkillHarness;
}): Promise<{
  synced: true;
  workspace: string;
  userId: string;
  harness: SkillHarness;
  installed: string[];
  removed: string[];
}> {
  const workspace = await loadRunningWorkspaceForSkillAction(input);
  const declared = listUserSkills(workspace.userProfile.id)
    .filter((skill) => skill.harness === input.harness);
  const installedState = (await listInstalledWorkspaceSkillsResolved({
    workspace,
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
    const debug = workspaceSkillInstallDebug({
      workspace,
      harness: input.harness,
      packageName: skill.packageName,
      commandArgs: skill.args,
      skillId: skill.id,
    });
    logInfo("executor", "workspace-skill-sync-install-command", {
      userId: workspace.userProfile.id,
      workspace: workspace.identity.projectName,
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
    runWorkspaceShell(
      workspace,
      workspaceSkillInstallScript({
        workspace,
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
    await removeInstalledWorkspaceSkillResolved({
      workspace,
      harness: input.harness,
      skillId,
    });
    removedNow.push(skillId);
  }

  const installed = await listInstalledWorkspaceSkillsResolved({
    workspace,
    harness: input.harness,
  });
  mutateWorkspaceSkillStatus({
    userId: workspace.userProfile.id,
    workspace: workspace.identity.projectName,
    reason: "workspace-skill-synced",
    installed,
  });
  return {
    synced: true,
    workspace: workspace.identity.projectName,
    userId: workspace.userProfile.id,
    harness: input.harness,
    installed: installedNow,
    removed: removedNow,
  };
}

function renderWorkspaceTargets(
  userId: string,
  workspace: string,
  defaultDockerOnly = false,
): void {
  const dockerWorkspace = loadUserWorkspace(userId, workspace, "docker");
  renderAndWriteDockerWorkspace(dockerWorkspace);
  if (defaultDockerOnly) {
    return;
  }
  const podWorkspace = loadUserWorkspace(
    userId,
    workspace,
    "pod",
    "gvisor",
  );
  renderAndWritePodWorkspace(podWorkspace);
  const kubevirtWorkspace = loadUserWorkspace(
    userId,
    workspace,
    "kubevirt-vm",
  );
  renderAndWriteKubevirtWorkspace(kubevirtWorkspace);
}

function renderWorkspaceTarget(
  userId: string,
  workspace: string,
  target: PortalDriverTarget,
): void {
  if (target.backend === "docker") {
    renderAndWriteDockerWorkspace(loadUserWorkspace(userId, workspace, "docker"));
    return;
  }
  if (target.backend === "pod") {
    renderAndWritePodWorkspace(
      loadUserWorkspace(userId, workspace, "pod", target.profile ?? "gvisor"),
    );
    return;
  }
  renderAndWriteKubevirtWorkspace(
    loadUserWorkspace(userId, workspace, "kubevirt-vm"),
  );
}

async function shouldRecycleRunningWorkspace(
  userId: string,
  workspace: string,
  target: PortalDriverTarget,
): Promise<boolean> {
  const loaded = loadUserWorkspace(
    userId,
    workspace,
    target.backend,
    target.profile,
  );
  const observation = await getBackendDriver(loaded.backend.kind).inspect(loaded);
  return Boolean(observation.backend.exists && observation.backend.running);
}

function ensureWorkspaceImageTargets(
  userId: string,
  workspace: string,
  defaultDockerOnly = false,
): void {
  ensureCanonicalWorkspaceImage(`${workspace}@docker`, userId);
  if (defaultDockerOnly) {
    return;
  }
  ensureCanonicalWorkspaceImage(`${workspace}@pod:gvisor`, userId);
  ensureCanonicalWorkspaceImage(`${workspace}@kubevirt-vm`, userId);
  const kubevirtWorkspace = loadUserWorkspace(
    userId,
    workspace,
    "kubevirt-vm",
  );
  ensureImageRefAvailable(
    kubevirtWorkspace.runtime.rootdiskImage ??
      "quay.io/containerdisks/debian:13",
  );
}

function ensureWorkspaceTargetSpecs(
  userId: string,
  workspace: string,
  defaultDockerOnly = false,
): void {
  fs.mkdirSync(portalRoot(userId, workspace), { recursive: true });
  ensureWorkspaceConfig(`${workspace}@docker`, userId);
  if (!defaultDockerOnly) {
    ensureWorkspaceConfig(`${workspace}@pod:gvisor`, userId);
    ensureWorkspaceConfig(`${workspace}@kubevirt-vm`, userId);
  }
  const selectionPath = path.join(
    portalRoot(userId, workspace),
    "state",
    "selection.json",
  );
  if (!fs.existsSync(selectionPath)) {
    fs.mkdirSync(path.dirname(selectionPath), { recursive: true });
    fs.writeFileSync(
      selectionPath,
      `${JSON.stringify({ backend: "docker" }, null, 2)}\n`,
      "utf8",
    );
  }
}

async function provisionWorkspaceInternal(
  userId: string,
  workspace: string,
  options?: {
    defaultDockerOnly?: boolean;
    startAfterCreate?: boolean;
  },
): Promise<void> {
  return withWorkspaceMutationLock(
    import.meta.url,
    userId,
    workspace,
    async () => {
      const defaultDockerOnly = options?.defaultDockerOnly ?? false;
      const startAfterCreate = options?.startAfterCreate ?? false;
      writeDirectWorkspaceStatus(userId, workspace, (current) => buildWorkspaceStatusFromCurrent({
        workspace,
        current,
        operation: pendingWorkspaceOperation("create"),
        health: {
          backendLiveness: "missing",
          workspaceReadiness: "not-ready",
          reason: "workspace creation in progress",
        },
      }));
      if (!fs.existsSync(workspaceConfigPath(workspace, "docker", userId))) {
        await createWorkspaceForUser(workspace, userId);
      }
      await maybeDelayProvisionStep(userId, workspace, "specs");
      ensureWorkspaceTargetSpecs(userId, workspace, defaultDockerOnly);
      await maybeDelayProvisionStep(userId, workspace, "images");
      ensureWorkspaceImageTargets(userId, workspace, defaultDockerOnly);
      await maybeDelayProvisionStep(userId, workspace, "manifests");
      renderWorkspaceTargets(userId, workspace, defaultDockerOnly);
      await maybeDelayProvisionStep(userId, workspace, "status");
      await captureStdout(() => statusCommand(`${workspace}@docker`, userId));
      const summary = loadWorkspaceSummary(userId, workspace);
      if (summary.selectedDriver === null) {
        await maybeDelayProvisionStep(userId, workspace, "selection");
      }

      if (startAfterCreate) {
        await maybeDelayProvisionStep(userId, workspace, "start");
        await startCommand(`${workspace}@docker`, userId);
      }
      await maybeDelayProvisionStep(userId, workspace, "finalize");
      const finalRef = workspaceRefFromTarget(
        workspace,
        summary.selectedDriver ?? { backend: "docker" },
      );
      await captureStdout(() => statusCommand(finalRef, userId));
    },
  );
}

async function startWorkspaceWithoutWait(
  projectRef: string,
  userProfileId?: string,
): Promise<void> {
  const { workspace, driver } = await loadExecutableWorkspaceForCommand(
    "start",
    projectRef,
    userProfileId,
  );
  await driver.start(workspace);
}

export async function refreshPortalWorkspaceStatus(
  userId: string,
  workspace: string,
): Promise<void> {
  const key = rootKey(userId, workspace);
  const existing = statusRefreshJobs.get(key);
  if (existing) {
    return existing;
  }
  const job = (async () => {
    const summary = loadWorkspaceSummary(userId, workspace);
    if (!summary.selectedDriver) {
      logWorkspaceEvent("warn", "status-refresh-skipped", {
        userId,
        workspace,
      }, {
        reason: "no-selected-driver",
      });
      return;
    }
    const ref = workspaceRefFromTarget(workspace, summary.selectedDriver);
    logWorkspaceEvent("info", "status-refresh-requested", {
      userId,
      workspace,
      ref,
    });
    try {
      await measureWorkspacePhase({
        context: { userId, workspace, ref, backend: summary.selectedDriver.backend, profile: summary.selectedDriver.profile },
        phase: "status-refresh",
        execute: () => captureStdout(() => statusCommand(ref, userId)),
      });
      logWorkspaceEvent("info", "status-refresh-completed", {
        userId,
        workspace,
        ref,
      });
    } catch (error) {
      logWorkspaceEvent("warn", "status-refresh-failed", {
        userId,
        workspace,
        ref,
      }, {
        reason: error instanceof Error ? error.message : String(error),
      });
      if (isStoppedContainerStatusRefreshError(error)) {
        writeDirectWorkspaceStatus(userId, workspace, (current) => buildWorkspaceStatusFromCurrent({
          workspace,
          current,
          operation: null,
          health: {
            backendLiveness: "stopped",
            workspaceReadiness: "not-ready",
            reason: "workspace is stopped",
          },
        }));
        logWorkspaceEvent("info", "status-refresh-coerced-stopped", {
          userId,
          workspace,
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

export async function reportPortalWorkspaceStatus(input: {
  userId: string;
  workspace: string;
  status: Partial<WorkspaceStatus>;
  paseo?: {
    serverId?: string;
    pairingUrl?: string;
  };
}): Promise<{ reported: true }> {
  const summary = loadWorkspaceSummary(input.userId, input.workspace);
  const next: WorkspaceStatus = buildWorkspaceStatusFromCurrent({
    workspace: input.workspace,
    current: summary.status,
    driver: input.status.driver,
    operation: input.status.operation ?? summary.status?.operation,
    health: input.status.health,
    details: {
      ...(summary.status?.details ?? {}),
      ...(input.status.details ?? {}),
    },
    credentials: input.status.credentials ?? summary.status?.credentials,
    evolution: input.status.evolution ?? summary.status?.evolution,
    assets: input.status.assets ?? summary.status?.assets,
    attachments: input.status.attachments ?? summary.status?.attachments,
    runtimeAssembly: input.status.runtimeAssembly ?? summary.status?.runtimeAssembly,
  });
  writeWorkspaceStatus(next, input.userId);
  const normalizedServerId = String(input.paseo?.serverId ?? "").trim();
  if (normalizedServerId) {
    writeWorkspacePaseoServerId(input.workspace, normalizedServerId, input.userId);
  }
  const normalizedPairingUrl = String(input.paseo?.pairingUrl ?? "").trim();
  if (normalizedPairingUrl) {
    writeWorkspacePaseoPairing(
      input.workspace,
      { url: normalizedPairingUrl },
      input.userId,
    );
  }
  logWorkspaceEvent("info", "status-reported", {
    userId: input.userId,
    workspace: input.workspace,
  }, {
    backendLiveness: next.health.backendLiveness,
    workspaceReadiness: next.health.workspaceReadiness,
    serverId: normalizedServerId || undefined,
    pairingUrlPersisted: Boolean(normalizedPairingUrl),
  });
  return { reported: true };
}

export async function queueProvisionWorkspace(
  userId: string,
  workspace: string,
  options?: {
    defaultDockerOnly?: boolean;
    startAfterCreate?: boolean;
  },
): Promise<{ queued: true; workspace: string }> {
  return withUserMutationLock(import.meta.url, userId, async () => {
    if (!userProfileExists(userId)) {
      throw new Error(`User profile '${userId}' was not found. Create it first with user create.`);
    }
    const key = rootKey(userId, workspace);
    const existing = provisionJobs.get(key);
    if (existing) {
      logInfo("executor", "workspace-provision-queue-reused", {
        userId,
        workspace,
      });
      return { queued: true, workspace };
    }
    assertProjectNameAvailableForUser(workspace, userId);
    if (workspaceConfigExists(workspace, userId)) {
      throw new Error(`Workspace '${workspace}' already exists for user ${userId}.`);
    }
    await createWorkspaceForUser(workspace, userId);
    clearProvisionState(userId, workspace);
    logInfo("executor", "workspace-provision-queued", {
      userId,
      workspace,
      defaultDockerOnly: options?.defaultDockerOnly ?? false,
      startAfterCreate: options?.startAfterCreate ?? false,
    });
    void startProvisionWorkspace(userId, workspace, options);
    return { queued: true, workspace };
  });
}

export function startProvisionWorkspace(
  userId: string,
  workspace: string,
  options?: {
    defaultDockerOnly?: boolean;
    startAfterCreate?: boolean;
  },
): Promise<void> {
  const key = rootKey(userId, workspace);
  const existing = provisionJobs.get(key);
  if (existing) {
    return existing;
  }
  const job = (async () => {
    try {
      clearProvisionState(userId, workspace);
      await provisionWorkspaceInternal(userId, workspace, options);
    } catch (error) {
      const classified = classifyProvisionError(error);
      writeDirectWorkspaceStatus(userId, workspace, (current) => buildWorkspaceStatusFromCurrent({
        workspace,
        current,
        operation: null,
        health: {
          backendLiveness: current?.health.backendLiveness ?? "missing",
          workspaceReadiness: "not-ready",
          reason: classified.message,
        },
      }));
      logWorkspaceEvent("warn", "provision-failed", {
        userId,
        workspace,
      }, {
        errorCode: classified.errorCode,
        reason: classified.message,
      });
      throw error;
    } finally {
      clearProvisionState(userId, workspace);
      provisionJobs.delete(key);
    }
  })();
  job.catch(() => undefined);
  provisionJobs.set(key, job);
  return job;
}

export async function switchPortalWorkspace(
  userId: string,
  workspace: string,
  target: PortalDriverTarget,
): Promise<SwitchResult> {
  const ref = workspaceRefFromTarget(workspace, target);
  return performWorkspaceSwitch(ref, userId);
}

export async function deletePortalWorkspace(
  userId: string,
  workspace: string,
): Promise<{
  archived: true;
  archiveId: string;
  archivedAt: string;
  workspace: string;
}> {
  try {
    writeDirectWorkspaceStatus(userId, workspace, (current) => buildWorkspaceStatusFromCurrent({
      workspace,
      current,
      operation: pendingWorkspaceOperation("archive"),
      health: {
        backendLiveness: current?.health.backendLiveness ?? "unknown",
        workspaceReadiness: "not-ready",
        reason: "workspace archive requested",
      },
    }));
    return await archiveWorkspaceOwnedByUser(userId, workspace);
  } catch (error) {
    await refreshPortalWorkspaceStatus(userId, workspace);
    throw error;
  }
}

export async function permanentlyDeletePortalWorkspace(
  userId: string,
  workspace: string,
): Promise<{ deleted: true; workspace: string }> {
  writeDirectWorkspaceStatus(userId, workspace, (current) => buildWorkspaceStatusFromCurrent({
    workspace,
    current,
    operation: pendingWorkspaceOperation("delete"),
    health: {
      backendLiveness: current?.health.backendLiveness ?? "unknown",
      workspaceReadiness: "not-ready",
      reason: "workspace delete requested",
    },
  }));
  return deleteWorkspaceOwnedByUser(userId, workspace);
}

export async function permanentlyDeletePortalArchivedWorkspace(
  userId: string,
  archiveId: string,
): Promise<{ deleted: true; archiveId: string }> {
  return deleteArchivedWorkspaceOwnedByUser(userId, archiveId);
}

export async function stopPortalWorkspace(
  userId: string,
  workspace: string,
): Promise<{ stopped: true }> {
  const summary = loadWorkspaceSummary(userId, workspace);
  const selectedDriver = summary.selectedDriver;
  if (!selectedDriver) {
    throw new Error(`Workspace '${workspace}' does not have a selected driver`);
  }
  const ref = workspaceRefFromTarget(workspace, selectedDriver);
  writeCachedWorkspaceStatusUpdate({
    userId,
    workspace,
    reason: "workspace-stopping",
    mutate: (current, currentSummary) => {
      if (!current) {
        return null;
      }
      return buildWorkspaceStatusFromCurrent({
        workspace,
        current,
        driver: current.driver
          ? {
              ...current.driver,
              backend: currentSummary.selectedDriver?.backend ?? current.driver.backend,
              profile: currentSummary.selectedDriver?.profile ?? current.driver.profile,
            }
          : current.driver,
        operation: pendingWorkspaceOperation("stop"),
        health: {
          backendLiveness: current.health.backendLiveness,
          workspaceReadiness: "not-ready",
          reason: "workspace stop requested",
        },
      });
    },
  });
  const jobKey = workspaceJobKey(userId, workspace);
  if (stopJobs.has(jobKey)) {
    logInfo("executor", "workspace-stop-joined", {
      userId,
      workspace,
      ref,
    });
    return { stopped: true };
  }
    logWorkspaceEvent("info", "stop-queued", {
      userId,
      workspace,
      ref,
  });
  const job = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      void withWorkspaceLifecycleLock(import.meta.url, userId, workspace, async () => {
        await measureWorkspacePhase({
          context: { userId, workspace, ref, backend: selectedDriver.backend, profile: selectedDriver.profile },
          phase: "stop-workspace",
          execute: async () => {
            await stopCommand(ref, userId);
            await refreshPortalWorkspaceStatus(userId, workspace);
          },
        });
      }).then(resolve, reject);
    }, 0);
  })
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logWorkspaceEvent("error", "stop-failed", {
        userId,
        workspace,
        ref,
      }, {
        error: message,
      });
      try {
        await refreshPortalWorkspaceStatus(userId, workspace);
      } catch (refreshError) {
        logWorkspaceEvent("warn", "stop-failed-refresh", {
          userId,
          workspace,
          ref,
        }, {
          error: refreshError instanceof Error ? refreshError.message : String(refreshError),
        });
      }
    })
    .finally(() => {
      stopJobs.delete(jobKey);
    });
  stopJobs.set(jobKey, job);
  return { stopped: true };
}

export async function startPortalWorkspace(
  userId: string,
  workspace: string,
): Promise<{ started: true }> {
  const summary = loadWorkspaceSummary(userId, workspace);
  const selectedDriver = summary.selectedDriver;
  if (!selectedDriver) {
    throw new Error(`Workspace '${workspace}' does not have a selected driver`);
  }
  const ref = workspaceRefFromTarget(workspace, selectedDriver);
  try {
    return await withWorkspaceLifecycleLock(import.meta.url, userId, workspace, async () => {
      writeCachedWorkspaceStatusUpdate({
        userId,
        workspace,
        reason: "workspace-starting",
        mutate: (current, currentSummary) => {
          if (!current) {
            return null;
          }
          return buildWorkspaceStatusFromCurrent({
            workspace,
            current,
            driver: current.driver
              ? {
                  ...current.driver,
                  backend: currentSummary.selectedDriver?.backend ?? current.driver.backend,
                  profile: currentSummary.selectedDriver?.profile ?? current.driver.profile,
                }
              : current.driver,
            operation: pendingWorkspaceOperation("start"),
            health: {
              backendLiveness: current.health.backendLiveness,
              workspaceReadiness: "not-ready",
              reason: "workspace start requested",
            },
          });
        },
      });
      await measureWorkspacePhase({
        context: { userId, workspace, ref, backend: selectedDriver.backend, profile: selectedDriver.profile },
        phase: "start-workspace",
        execute: async () => {
          await startCommand(ref, userId);
          await refreshPortalWorkspaceStatus(userId, workspace);
        },
      });
      return { started: true };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWorkspaceEvent("error", "start-failed", {
      userId,
      workspace,
      ref,
    }, {
      error: message,
    });
    try {
      await refreshPortalWorkspaceStatus(userId, workspace);
    } catch (refreshError) {
      logWorkspaceEvent("warn", "start-failed-refresh", {
        userId,
        workspace,
        ref,
      }, {
        error: refreshError instanceof Error ? refreshError.message : String(refreshError),
      });
    }
    throw error;
  }
}

export async function rebuildPortalWorkspace(
  userId: string,
  workspace: string,
): Promise<{ rebuilt: true }> {
  const summary = loadWorkspaceSummary(userId, workspace);
  const selectedDriver = summary.selectedDriver;
  if (!selectedDriver) {
    throw new Error(`Workspace '${workspace}' does not have a selected driver`);
  }
  const ref = workspaceRefFromTarget(workspace, selectedDriver);
  try {
    writeCachedWorkspaceStatusUpdate({
      userId,
      workspace,
      reason: "workspace-rebuilding",
      mutate: (current, currentSummary) => {
        if (!current) {
          return null;
        }
        return buildWorkspaceStatusFromCurrent({
          workspace,
          current,
          driver: current.driver
            ? {
                ...current.driver,
                backend: currentSummary.selectedDriver?.backend ?? current.driver.backend,
                profile: currentSummary.selectedDriver?.profile ?? current.driver.profile,
              }
            : current.driver,
          operation: pendingWorkspaceOperation("rebuild"),
          health: {
            backendLiveness: current.health.backendLiveness,
            workspaceReadiness: "not-ready",
            reason: "workspace rebuild requested",
          },
        });
      },
    });
    await measureWorkspacePhase({
      context: { userId, workspace, ref, backend: selectedDriver.backend, profile: selectedDriver.profile },
      phase: "rebuild-workspace",
      execute: async () => {
        await rebuildCommand(ref, userId);
        await refreshPortalWorkspaceStatus(userId, workspace);
      },
    });
    return { rebuilt: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWorkspaceEvent("error", "rebuild-failed", {
      userId,
      workspace,
      ref,
    }, {
      error: message,
    });
    try {
      await refreshPortalWorkspaceStatus(userId, workspace);
    } catch (refreshError) {
      logWorkspaceEvent("warn", "rebuild-failed-refresh", {
        userId,
        workspace,
        ref,
      }, {
        error: refreshError instanceof Error ? refreshError.message : String(refreshError),
      });
    }
    throw error;
  }
}

export async function switchPortalWorkspaceLiveCredential(input: {
  userId: string;
  workspace: string;
  harness: ManagedHarness;
  credentialId: string;
}): Promise<{
  switched: true;
  driver: string;
  credentialId: string;
}> {
  return withWorkspaceLifecycleLock(
    import.meta.url,
    input.userId,
    input.workspace,
    async () => {
      if (!supportsLiveCredentialSwitch(input.harness)) {
        throw new Error(
          `Live credential switching is not supported for harness '${input.harness}'`,
        );
      }
      const summary = loadWorkspaceSummary(input.userId, input.workspace);
      const target = summary.selectedDriver;
      if (!target) {
        throw new Error(
          `Workspace '${input.workspace}' does not have a selected driver`,
        );
      }
      const workspaceSpec = loadPortalWorkspaceByTarget(
        input.userId,
        input.workspace,
        target,
      );
      if (
        workspaceSpec.backend.kind !== "docker" &&
        workspaceSpec.backend.kind !== "pod"
      ) {
        throw new Error(
          `Live credential switching is not supported for backend '${workspaceSpec.backend.kind}'`,
        );
      }
      const observation = await getBackendDriver(workspaceSpec.backend.kind).inspect(
        workspaceSpec,
      );
      if (!observation.backend.exists || !observation.backend.running) {
        throw new Error(
          `Workspace '${input.workspace}' is not running on ${workspaceSpec.backend.kind}`,
        );
      }
      switchWorkspaceLiveCredentialMaterial({
        workspace: workspaceSpec,
        userId: input.userId,
        credentialId: input.credentialId,
        harness: input.harness,
        requireSupported: true,
      });
      const ref = workspaceRefFromTarget(input.workspace, target);
      writeCachedWorkspaceStatusUpdate({
        userId: input.userId,
        workspace: input.workspace,
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
      void refreshPortalWorkspaceStatus(input.userId, input.workspace);
      return {
        switched: true,
        driver: ref,
        credentialId: input.credentialId,
      };
    },
  );
}

export async function getPortalWorkspacePaseoDiagnostic(input: {
  userId: string;
  workspace: string;
}): Promise<PortalWorkspacePaseoDiagnostic> {
  return withWorkspaceLifecycleLock(import.meta.url, input.userId, input.workspace, async () =>
    collectWorkspacePaseoDiagnostic(input.userId, input.workspace)
  );
}

export async function restartPortalWorkspacePaseoDaemon(input: {
  userId: string;
  workspace: string;
}): Promise<{
  restarted: true;
  diagnostic: PortalWorkspacePaseoDiagnostic;
}> {
  return withWorkspaceLifecycleLock(
    import.meta.url,
    input.userId,
    input.workspace,
    async () => {
      const summary = loadWorkspaceSummary(input.userId, input.workspace);
      const target = summary.selectedDriver;
      if (!target) {
        throw new Error(`Workspace '${input.workspace}' does not have a selected driver`);
      }
      const loaded = loadPortalWorkspaceByTarget(input.userId, input.workspace, target);
      runWorkspaceShell(
        loaded,
        [
          "paseo_pid=$(sed -n 's/.*\"pid\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' /root/.paseo/paseo.pid 2>/dev/null | head -n 1)",
          "if [ -z \"$paseo_pid\" ]; then paseo_pid=$(cat /root/.paseo/paseo.pid 2>/dev/null | tr -cd '0-9'); fi",
          "if [ -n \"$paseo_pid\" ]; then pkill -TERM -P \"$paseo_pid\" 2>/dev/null || true; kill \"$paseo_pid\" 2>/dev/null || true; sleep 1; pkill -KILL -P \"$paseo_pid\" 2>/dev/null || true; kill -KILL \"$paseo_pid\" 2>/dev/null || true; fi",
          "rm -f /root/.paseo/paseo.pid /root/.paseo/daemon.log",
          "PASEO_HOME=/root/.paseo paseo daemon start --listen 0.0.0.0:6767",
        ].join("; "),
      );
      const diagnostic = collectWorkspacePaseoDiagnostic(input.userId, input.workspace);
      return {
        restarted: true,
        diagnostic,
      };
    },
  );
}

export async function healthCheckPortalWorkspaceExecutor(
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
