import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { loadVaultFromConfigPath, resolveVaultConfigPath } from "../scripts/config/load.js";
import { ensureCanonicalVaultImage, ensureVaultConfig } from "../scripts/config/provision.js";
import { createManagedSshCredential } from "../scripts/config/credentials.js";
import { assertNoProjectNameCollision, assertProjectNameAvailableForUser } from "../scripts/config/project-ownership.js";
import { getBackendDriver } from "../scripts/backends/index.js";
import {
  WANGHAI_CACHE_RUNTIME_ROOT,
  scaffoldDockerVault,
  scaffoldUserProfileById,
  syncVaultDockerfileTemplate,
  WANGHAI_BACKUP_RUNTIME_ROOT,
  WANGHAI_PROFILE_ENV_FILE_KEY,
  WANGHAI_PROFILE_ENV_MOUNT_PATH,
  WANGHAI_PROFILE_ENV_SOURCE_PATH,
  WANGHAI_VAULTS_RUNTIME_ROOT,
  vaultConfigPath,
  vaultImageRef,
} from "../scripts/config/scaffold.js";
import { EvolutionStore } from "../scripts/evolution/store.js";
import { generatedOutputPath } from "../scripts/output/write-generated.js";
import {
  vaultEvolutionStateDir,
  vaultLiveCredentialsPath,
  vaultPaseoStateDir,
  vaultSelectionPath,
  vaultStatusPath,
  writeVaultDriverSelection,
  writeVaultLiveCredentialSelection,
  writeVaultStatus,
} from "../scripts/output/state-store.js";
import { renderAndWritePodVault } from "../scripts/backends/pod/render.js";
import { renderAndWriteDockerVault } from "../scripts/backends/docker/render.js";
import { renderAndWriteKubevirtVault, renderKubevirtVault } from "../scripts/backends/kubevirt/render.js";
import { kubevirtProbePassword } from "../scripts/backends/kubevirt/probe-access.js";
import { runCli } from "../scripts/cli/main.js";
import { startCommand } from "../scripts/cli/commands/start.js";
import { waitForVaultReady } from "../scripts/cli/commands/shared.js";
import { buildReconcilePlan, computeVaultDrift, synthesizeVaultStatus } from "../scripts/core/runtime-controller.js";
import {
  vaultRuntimeResourceName,
  vaultRuntimeScopeName,
} from "../scripts/core/vault-name.js";
import { polarisNetfsLocalExportRoot, polarisUsersRoot } from "../scripts/utils/paths.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const USER_ROOT = polarisUsersRoot(import.meta.url);
const STDOUT_CAPTURE_QUEUE_KEY = "__polaris_stdout_capture_queue__";
const DEMO_USER_PROFILE_ID = "100000000000000001";
const DEMO_USER_PROFILE_PATH = path.join(
  USER_ROOT,
  "profiles",
  `${DEMO_USER_PROFILE_ID}.yaml`,
);
const DEMO_USER_ROOT = path.join(
  USER_ROOT,
  DEMO_USER_PROFILE_ID,
);
const DEMO_USER_DOCKERFILE = path.join(
  DEMO_USER_ROOT,
  "docker",
  "vault-prebuilt.Dockerfile",
);
const DEMO_GITHUB_SSH_CREDENTIAL_PATH = path.join(
  DEMO_USER_ROOT,
  "credentials",
  "github-ssh.yaml",
);
const DEMO_VAULT_EXPORT_ROOT = polarisNetfsLocalExportRoot(import.meta.url);
const DEMO_VAULT_EXPORT_PATH = path.join(DEMO_VAULT_EXPORT_ROOT, "demo");
const SHARED_VAULT_DOCKERFILE = path.join(
  REPO_ROOT,
  "config",
  "docker",
  "vault-prebuilt.Dockerfile",
);

function repoRelative(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, "/") || ".";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sharedVaultImageRefForTest(dockerfilePath: string): string {
  const digest = createHash("sha256")
    .update(fs.readFileSync(dockerfilePath))
    .digest("hex");
  return `ttl.sh/polaris-vault-prebuilt-${digest.slice(0, 32)}:24h`;
}

function rewriteVaultDataExportRoot(configPath: string, exportRoot: string): void {
  const doc = (yaml.load(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<string, any>;
  const source = doc.attachments?.["vault-data"]?.source;
  if (!source || typeof source !== "object") {
    return;
  }
  if ((source as Record<string, any>).export_path === exportRoot) {
    return;
  }
  (source as Record<string, any>).export_path = exportRoot;
  fs.writeFileSync(configPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
}

function ensureDemoVaultFixtures(): void {
  if (!fs.existsSync(DEMO_USER_PROFILE_PATH)) {
    scaffoldUserProfileById({
      id: DEMO_USER_PROFILE_ID,
      name: "Demo User",
      email: "demo@example.com",
    });
  }

  if (!fs.existsSync(DEMO_GITHUB_SSH_CREDENTIAL_PATH)) {
    createManagedSshCredential({
      userProfileId: DEMO_USER_PROFILE_ID,
      credentialId: "github-ssh",
      label: "GitHub SSH",
      activate: true,
    });
  }

  syncVaultDockerfileTemplate(DEMO_USER_PROFILE_ID);

  const dockerConfigPath = vaultConfigPath("demo", "docker", DEMO_USER_PROFILE_ID);
  if (!fs.existsSync(dockerConfigPath)) {
    scaffoldDockerVault("demo", DEMO_USER_PROFILE_ID);
  }
  rewriteVaultDataExportRoot(dockerConfigPath, DEMO_VAULT_EXPORT_ROOT);

  const podConfigPath = vaultConfigPath("demo", "pod", DEMO_USER_PROFILE_ID);
  fs.rmSync(podConfigPath, { force: true });
  ensureVaultConfig("demo@pod:gvisor", DEMO_USER_PROFILE_ID);
  rewriteVaultDataExportRoot(podConfigPath, DEMO_VAULT_EXPORT_ROOT);

  const kubevirtConfigPath = vaultConfigPath("demo", "kubevirt-vm", DEMO_USER_PROFILE_ID);
  fs.rmSync(kubevirtConfigPath, { force: true });
  ensureVaultConfig("demo@kubevirt-vm", DEMO_USER_PROFILE_ID);
  rewriteVaultDataExportRoot(kubevirtConfigPath, DEMO_VAULT_EXPORT_ROOT);
}

function loadVaultFromRefForTest(projectRef: string) {
  ensureDemoVaultFixtures();
  const resolved = resolveVaultConfigPath(projectRef);
  return loadVaultFromConfigPath(
    resolved.configPath,
    resolved.project,
    resolved.backendHint,
    resolved.profileHint,
  );
}

function getStdoutCaptureQueue(): Promise<void> {
  const existing = (globalThis as Record<string, unknown>)[STDOUT_CAPTURE_QUEUE_KEY];
  return existing instanceof Promise ? (existing as Promise<void>) : Promise.resolve();
}

function setStdoutCaptureQueue(queue: Promise<void>): void {
  (globalThis as Record<string, unknown>)[STDOUT_CAPTURE_QUEUE_KEY] = queue;
}

async function cleanupCliTestUser(input: {
  userId: string;
  profilePath: string;
  userRoot: string;
  userMapPath?: string;
  originalUserMap?: string | null;
}): Promise<void> {
  try {
    await runCli(["user", "delete", input.userId]);
  } catch {
    // Some tests intentionally leave vault/archive state behind, which
    // makes the formal delete path reject. Fall back to direct cleanup.
  } finally {
    fs.rmSync(input.profilePath, { force: true });
    fs.rmSync(input.userRoot, { recursive: true, force: true });
    if (input.userMapPath) {
      if (input.originalUserMap === null || input.originalUserMap === undefined) {
        fs.rmSync(input.userMapPath, { force: true });
      } else {
        fs.writeFileSync(input.userMapPath, input.originalUserMap, "utf8");
      }
    }
  }
}

async function withFakeCommands(
  commands: Record<string, string>,
  fn: (ctx: { commandLogPath: string; readCommandLog: () => string[] }) => Promise<void> | void,
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-test-"));
  const commandLogPath = path.join(tempDir, "commands.log");
  const originalPath = process.env.PATH || "";

  for (const [commandName, scriptBody] of Object.entries(commands)) {
    const commandPath = path.join(tempDir, commandName);
    fs.writeFileSync(
      commandPath,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(commandLogPath)}
${scriptBody}
`,
      { mode: 0o755 },
    );
  }

  process.env.PATH = `${tempDir}:${originalPath}`;
  try {
    await fn({
      commandLogPath,
      readCommandLog: () =>
        fs.existsSync(commandLogPath)
          ? fs.readFileSync(commandLogPath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean)
          : [],
    });
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const previous = getStdoutCaptureQueue();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  setStdoutCaptureQueue(next);
  await previous;
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    const callback = args.find((arg) => typeof arg === "function") as (() => void) | undefined;
    callback?.();
    return true;
  }) as typeof process.stdout.write;

  try {
    await fn();
    return chunks.join("");
  } finally {
    process.stdout.write = originalWrite;
    release();
  }
}

function parseJsonOutput<T>(stdout: string): T {
  const trimmed = stdout.trim();
  const end = trimmed.lastIndexOf("}");
  if (end === -1) {
    throw new Error(`No JSON object found in stdout: ${JSON.stringify(trimmed)}`);
  }
  for (let start = trimmed.lastIndexOf("{", end); start !== -1; start = trimmed.lastIndexOf("{", start - 1)) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    } catch {
      continue;
    }
  }
  throw new Error(`No JSON object found in stdout: ${JSON.stringify(trimmed)}`);
}

function uniqueProjectName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

function cleanupStatusFile(project: string): void {
  fs.rmSync(vaultStatusPath(project, DEMO_USER_PROFILE_ID), { force: true });
  fs.rmSync(path.join(REPO_ROOT, "config", "state", `${project}.status.json`), { force: true });
}

function cleanupDriverSelectionState(project: string): void {
  cleanupStatusFile(project);
  fs.rmSync(vaultSelectionPath(project, DEMO_USER_PROFILE_ID), { force: true });
  fs.rmSync(path.join(REPO_ROOT, "config", "state", `${project}.selection.json`), { force: true });
}

function cleanupLiveCredentialsFile(project: string): void {
  fs.rmSync(vaultLiveCredentialsPath(project, DEMO_USER_PROFILE_ID), { force: true });
  fs.rmSync(path.join(REPO_ROOT, "config", "state", `${project}.live-credentials.json`), { force: true });
}

function loadDefaultDemoVault() {
  cleanupDriverSelectionState("demo");
  return loadVaultFromRefForTest("demo");
}

async function withTempVaultSpec(
  project: string,
  backendKind: "docker" | "pod" | "kubevirt-vm",
  fn: () => Promise<void> | void,
): Promise<void> {
  ensureDemoVaultFixtures();
  const outputPath = vaultConfigPath(project, backendKind, DEMO_USER_PROFILE_ID);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const sourcePath = vaultConfigPath("demo", backendKind, DEMO_USER_PROFILE_ID);
  const doc = (yaml.load(fs.readFileSync(sourcePath, "utf8")) ?? {}) as Record<string, any>;
  doc.project = project;
  doc.backend = {
    ...(doc.backend ?? {}),
    kind: backendKind,
  };
  doc.runtime = {
    ...(doc.runtime ?? {}),
    base_image: vaultImageRef(DEMO_USER_PROFILE_ID, project),
  };
  if (backendKind === "docker") {
    doc.runtime = {
      ...(doc.runtime ?? {}),
      class: "docker",
      docker_enabled: true,
    };
  }

  fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
  const generatedPath = generatedOutputPath(loadVaultFromRefForTest(`${project}@${backendKind}`));
  try {
    await fn();
  } finally {
    fs.rmSync(outputPath, { force: true });
    fs.rmSync(generatedPath, { force: true });
    cleanupStatusFile(project);
    cleanupLiveCredentialsFile(project);
  }
}

test("loadVault normalizes demo pod config through the TypeScript control plane", () => {
  const vault = loadDefaultDemoVault();
  assert.equal(vault.identity.projectName, "demo");
  assert.equal(vault.profile.name, "morpheus");
  assert.match(vault.userProfile.id, /^\d{18}$/);
  assert.ok(vault.userProfile.name.length > 0);
  assert.match(vault.userProfile.email, /@/);
  assert.ok(fs.existsSync(path.join(USER_ROOT, vault.userProfile.id, "vaults", "demo")));
  assert.equal(vault.backend.kind, "pod");
  assert.equal(vault.backend.profile, "gvisor");
  assert.equal(vault.health.readinessMode, "daemon-port");
  assert.ok(vault.runtimeContract.staleRuntimeArtifacts.some((entry) => entry.endsWith(".paseo/paseo.pid")));
  assert.equal(vault.attachments.vaultData.scope, "vault");
  assert.equal(vault.attachments.vaultRuntimeState.scope, "vault");
  assert.equal(vault.attachments.userIdentityState.scope, "user");
  assert.equal(vault.attachments.userIdentityState.sharing, "cross-vault");
  assert.ok(vault.attachments.userIdentityState.durablePaths.includes("/identity/ssh"));
  assert.equal(vault.attachments.vaultData.mountRoot, "/vault/project");
  assert.equal(vault.attachments.vaultData.source.kind, "netfs");
  assert.equal(vault.attachments.vaultData.source.server, "netfs.local");
  assert.equal(vault.attachments.vaultData.source.exportPath, DEMO_VAULT_EXPORT_ROOT);
  assert.equal(vault.attachments.vaultData.source.subPath, "demo");
  assert.ok(!vault.userProfile.github.account || vault.userProfile.github.account.length > 0);
  assert.equal(vault.credentialBindings.length, 1);
  assert.equal(vault.credentialBindings[0]?.purpose, "git-auth");
  assert.equal(vault.resolvedCredentialBindings[0]?.source, "registry");
  assert.equal(vault.resolvedCredentialBindings[0]?.attachmentKind, "user-identity-state");
});

test("backend registry resolves pod driver", () => {
  const driver = getBackendDriver("pod");
  assert.equal(driver.kind, "pod");
});

test("runCli rejects empty argv and missing project", async () => {
  await assert.rejects(() => runCli([]), /Usage:/);
  await assert.rejects(() => runCli(["status"]), /Usage:/);
});

test("scaffoldUserProfileById adds the optional Wanghai env profile entry", () => {
  const userProfileId = uniqueProjectName("wanghai-profile-scaffold");
  const profilePath = path.join(USER_ROOT, "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(USER_ROOT, userProfileId);

  try {
    scaffoldUserProfileById({
      id: userProfileId,
      name: "Wanghai Scaffold User",
      email: "wanghai-scaffold@example.com",
    });
    const profileDoc = (yaml.load(fs.readFileSync(profilePath, "utf8")) ?? {}) as {
      auth?: { files?: Array<Record<string, unknown>> };
    };
    assert.equal(fs.existsSync(path.join(userRoot, "wanghai")), true);
    assert.deepEqual(
      profileDoc.auth?.files?.find((entry) => entry.key === WANGHAI_PROFILE_ENV_FILE_KEY),
      {
        key: WANGHAI_PROFILE_ENV_FILE_KEY,
        mount_path: WANGHAI_PROFILE_ENV_MOUNT_PATH,
        source_path: WANGHAI_PROFILE_ENV_SOURCE_PATH,
        optional: true,
      },
    );
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("runCli user create scaffolds a user profile and default credentials", async () => {
  const userProfileId = uniqueProjectName("cli-user");
  const profilePath = path.join(USER_ROOT, "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(USER_ROOT, userProfileId);

  try {
    const stdout = await captureStdout(async () => {
      await runCli([
        "user",
        "create",
        userProfileId,
        "--name",
        "CLI User",
        "--email",
        `${userProfileId}@polaris.local`,
      ]);
    });
    const parsed = parseJsonOutput<{
      userProfile: { id: string; created: boolean };
      credentials: { defaults: string[] };
    }>(stdout);

    assert.equal(parsed.userProfile.id, userProfileId);
    assert.equal(parsed.userProfile.created, true);
    assert.deepEqual(parsed.credentials.defaults, ["github-ssh"]);
    assert.equal(fs.existsSync(profilePath), true);
    assert.equal(fs.existsSync(path.join(userRoot, "credentials", "github-ssh.yaml")), true);
    assert.equal(fs.existsSync(path.join(userRoot, "credentials", "ssh", "github-ssh", "id_ed25519")), true);
    assert.equal(fs.existsSync(path.join(userRoot, "credentials", "ssh", "github-ssh", "id_ed25519.pub")), true);
    assert.equal(fs.existsSync(path.join(userRoot, "wanghai")), true);
    const profileDoc = (yaml.load(fs.readFileSync(profilePath, "utf8")) ?? {}) as {
      auth?: { files?: Array<Record<string, unknown>> };
    };
    assert.deepEqual(
      profileDoc.auth?.files?.find((entry) => entry.key === WANGHAI_PROFILE_ENV_FILE_KEY),
      {
        key: WANGHAI_PROFILE_ENV_FILE_KEY,
        mount_path: WANGHAI_PROFILE_ENV_MOUNT_PATH,
        source_path: WANGHAI_PROFILE_ENV_SOURCE_PATH,
        optional: true,
      },
    );
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("vault load skips the optional user Wanghai env when the file is absent", async () => {
  const project = uniqueProjectName("wanghai-profile-missing");
  const profileId = uniqueProjectName("wanghai-profile-user");
  const profilePath = path.join(USER_ROOT, "profiles", `${profileId}.yaml`);
  const userRoot = path.join(USER_ROOT, profileId);

  await withTempVaultSpec(project, "docker", async () => {
    scaffoldUserProfileById({
      id: profileId,
      name: "Wanghai Profile User",
      email: "wanghai-profile@example.com",
    });
    const outputPath = vaultConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
    const doc = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as Record<string, any>;
    doc.user_profile = profileId;
    delete doc.credentials;
    fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");

    const vault = loadVaultFromRefForTest(`${project}@docker`);
    assert.equal(
      vault.runtime.authFiles.some((file) => file.key === WANGHAI_PROFILE_ENV_FILE_KEY),
      false,
    );
  }).finally(() => {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  });
});

test("vault load mounts the user Wanghai env when the file exists", async () => {
  const project = uniqueProjectName("wanghai-profile-present");
  const profileId = uniqueProjectName("wanghai-profile-user");
  const profilePath = path.join(USER_ROOT, "profiles", `${profileId}.yaml`);
  const userRoot = path.join(USER_ROOT, profileId);

  await withTempVaultSpec(project, "docker", async () => {
    scaffoldUserProfileById({
      id: profileId,
      name: "Wanghai Mounted User",
      email: "wanghai-mounted@example.com",
    });
    fs.writeFileSync(
      path.join(userRoot, "wanghai", ".env"),
      "CUSTOM_WANGHAI_FLAG=1\n",
      "utf8",
    );
    const outputPath = vaultConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
    const doc = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as Record<string, any>;
    doc.user_profile = profileId;
    delete doc.credentials;
    fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");

    const vault = loadVaultFromRefForTest(`${project}@docker`);
    const wanghaiEnv = vault.runtime.authFiles.find((file) => file.key === WANGHAI_PROFILE_ENV_FILE_KEY);
    assert.equal(wanghaiEnv?.mountPath, WANGHAI_PROFILE_ENV_MOUNT_PATH);
    assert.equal(wanghaiEnv?.sourcePath, path.join(userRoot, "wanghai", ".env"));
    assert.match(wanghaiEnv?.content || "", /CUSTOM_WANGHAI_FLAG=1/);

    const rendered = fs.readFileSync(renderAndWriteDockerVault(vault), "utf8");
    assert.match(rendered, /if \[ ! -f \/opt\/wanghai\/\.env \]; then python3 -c /);
    assert.match(rendered, /chown root:root \/opt\/wanghai\/\.env \|\| true/);
    assert.match(rendered, /chmod 600 \/opt\/wanghai\/\.env \|\| true/);
  }).finally(() => {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  });
});

test("docker render bind-mounts Wanghai data roots from POLARIS_WANGHAI_DATA_ROOT", async () => {
  const project = uniqueProjectName("wanghai-profile-data-root");
  const profileId = uniqueProjectName("wanghai-profile-data-root-user");
  const profilePath = path.join(USER_ROOT, "profiles", `${profileId}.yaml`);
  const userRoot = path.join(USER_ROOT, profileId);
  const previousHostDataRoot = process.env.POLARIS_WANGHAI_DATA_ROOT;
  const hostDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-wanghai-host-data-"));

  await withTempVaultSpec(project, "docker", async () => {
    try {
      process.env.POLARIS_WANGHAI_DATA_ROOT = hostDataRoot;
      scaffoldUserProfileById({
        id: profileId,
        name: "Wanghai Data Root User",
        email: "wanghai-data-root@example.com",
      });
      fs.writeFileSync(
        path.join(userRoot, "wanghai", ".env"),
        [
          "WANGHAI_VAULTS_ROOT=/host/wanghai/vaults",
          "WANGHAI_BACKUP_ROOT=/host/wanghai/backups",
          "WANGHAI_CACHE_ROOT=/host/wanghai/cache",
          "CUSTOM_WANGHAI_FLAG=1",
          "",
        ].join("\n"),
        "utf8",
      );
      scaffoldDockerVault(project, DEMO_USER_PROFILE_ID, { line: "vertical" });
      const outputPath = vaultConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
      const doc = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as Record<string, any>;
      doc.user_profile = profileId;
      delete doc.credentials;
      fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");

      const vault = loadVaultFromRefForTest(`${project}@docker`);
      const rendered = fs.readFileSync(renderAndWriteDockerVault(vault), "utf8");
      const expectedVaultsRoot = path.join(hostDataRoot, "vaults");
      const expectedBackupRoot = path.join(hostDataRoot, "backups");
      const expectedCacheRoot = path.join(hostDataRoot, "cache");
      assert.match(
        rendered,
        new RegExp(`source: "${escapeRegExp(expectedVaultsRoot)}"`),
      );
      assert.match(
        rendered,
        new RegExp(`target: "${WANGHAI_VAULTS_RUNTIME_ROOT.replace(/\//g, "\\/")}"`),
      );
      assert.match(
        rendered,
        new RegExp(`source: "${escapeRegExp(expectedBackupRoot)}"`),
      );
      assert.match(
        rendered,
        new RegExp(`target: "${WANGHAI_BACKUP_RUNTIME_ROOT.replace(/\//g, "\\/")}"`),
      );
      assert.match(
        rendered,
        new RegExp(`source: "${escapeRegExp(expectedCacheRoot)}"`),
      );
      assert.match(
        rendered,
        new RegExp(`target: "${WANGHAI_CACHE_RUNTIME_ROOT.replace(/\//g, "\\/")}"`),
      );
      assert.doesNotMatch(rendered, /source: "\/host\/wanghai\/vaults"/);
      assert.doesNotMatch(rendered, /source: "\/host\/wanghai\/backups"/);
      assert.doesNotMatch(rendered, /source: "\/host\/wanghai\/cache"/);
    } finally {
      if (previousHostDataRoot === undefined) {
        delete process.env.POLARIS_WANGHAI_DATA_ROOT;
      } else {
        process.env.POLARIS_WANGHAI_DATA_ROOT = previousHostDataRoot;
      }
      fs.rmSync(hostDataRoot, { recursive: true, force: true });
    }
  }).finally(() => {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  });
});

test("runCli user defaults read omits the retired docker base image setting", async () => {
  const userProfileId = uniqueProjectName("cli-user-defaults");
  const profilePath = path.join(USER_ROOT, "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(USER_ROOT, userProfileId);

  try {
    await runCli([
      "user",
      "create",
      userProfileId,
      "--name",
      "CLI User Defaults",
      "--email",
      `${userProfileId}@polaris.local`,
    ]);

    const readStdout = await captureStdout(async () => {
      await runCli(["user", "defaults", "read", userProfileId]);
    });
    const readParsed = parseJsonOutput<{
      vaultDefaults: Record<string, never>;
    }>(readStdout);
    assert.deepEqual(readParsed.vaultDefaults, {});

    await assert.rejects(
      runCli(["user", "defaults", "set", userProfileId]),
      /no longer stores a user default docker base image/i,
    );
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("runCli user list returns sorted user profiles", async () => {
  const firstUserId = uniqueProjectName("cli-user-list-b");
  const secondUserId = uniqueProjectName("cli-user-list-a");
  const firstProfilePath = path.join(USER_ROOT, "profiles", `${firstUserId}.yaml`);
  const secondProfilePath = path.join(USER_ROOT, "profiles", `${secondUserId}.yaml`);
  const firstUserRoot = path.join(USER_ROOT, firstUserId);
  const secondUserRoot = path.join(USER_ROOT, secondUserId);

  try {
    await runCli([
      "user",
      "create",
      firstUserId,
      "--name",
      "CLI User List B",
      "--email",
      `${firstUserId}@polaris.local`,
    ]);
    await runCli([
      "user",
      "create",
      secondUserId,
      "--name",
      "CLI User List A",
      "--email",
      `${secondUserId}@polaris.local`,
    ]);

    const stdout = await captureStdout(async () => {
      await runCli(["user", "list"]);
    });
    const parsed = parseJsonOutput<{
      users: Array<{ id: string; name: string; email: string; vaults: string[] }>;
    }>(stdout);

    const listedUserIds = parsed.users.map((user) => user.id);
    const firstIndex = listedUserIds.indexOf(firstUserId);
    const secondIndex = listedUserIds.indexOf(secondUserId);

    assert.notEqual(firstIndex, -1);
    assert.notEqual(secondIndex, -1);
    assert.ok(secondIndex < firstIndex);
    assert.deepEqual(parsed.users[firstIndex]?.vaults, []);
    assert.deepEqual(parsed.users[secondIndex]?.vaults, []);
  } finally {
    await cleanupCliTestUser({
      userId: firstUserId,
      profilePath: firstProfilePath,
      userRoot: firstUserRoot,
    });
    await cleanupCliTestUser({
      userId: secondUserId,
      profilePath: secondProfilePath,
      userRoot: secondUserRoot,
    });
  }
});

test("runCli vault list returns a user's vault names", async () => {
  const userId = uniqueProjectName("cli-vault-list");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const vaultRoot = path.join(USER_ROOT, userId, "vaults");

  try {
    await runCli(["user", "create", userId, "--name", "Vault List User"]);
    for (const vault of ["beta", "alpha"]) {
      const vaultPath = path.join(vaultRoot, vault);
      fs.mkdirSync(vaultPath, { recursive: true });
      fs.writeFileSync(path.join(vaultPath, "docker.agent.yaml"), "project: test\n", "utf8");
    }

    const stdout = await captureStdout(async () => {
      await runCli(["vault", "list", "--user", userId]);
    });
    const parsed = parseJsonOutput<{
      userId: string;
      vaults: Array<{
        name: string;
        raw: {
          dockerAgentYaml: string | null;
          podAgentYaml: string | null;
          kubevirtAgentYaml: string | null;
          status: unknown;
        };
      }>;
    }>(stdout);

    assert.equal(parsed.userId, userId);
    assert.deepEqual(parsed.vaults.map((vault) => vault.name), ["alpha", "beta"]);
    assert.equal(parsed.vaults[0]?.raw.dockerAgentYaml, "project: test\n");
    assert.equal(parsed.vaults[0]?.raw.podAgentYaml, null);
    assert.equal(parsed.vaults[0]?.raw.status, null);
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(path.join(USER_ROOT, userId), { recursive: true, force: true });
  }
});

test("runCli user create adds the default RightCode codex credential when configured", async () => {
  const previousApiKey = process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY;
  const previousScript = process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY_SCRIPT;
  const previousQuotaLimit = process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_QUOTA_LIMIT;
  const previousAllowedPrefixes = process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_ALLOWED_PREFIXES;
  delete process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY;
  process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY_SCRIPT = "node -e \"console.log(JSON.stringify({ apiKey: 'test-default-rightcode-key' }))\" --";
  process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_QUOTA_LIMIT = "20";
  process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_ALLOWED_PREFIXES = "/codex,/draw";
  const userProfileId = uniqueProjectName("cli-user-codex-default");
  const profilePath = path.join(USER_ROOT, "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(USER_ROOT, userProfileId);

  try {
    const stdout = await captureStdout(async () => {
      await runCli([
        "user",
        "create",
        userProfileId,
        "--name",
        "CLI Default Codex User",
        "--email",
        `${userProfileId}@polaris.local`,
      ]);
    });
    const parsed = parseJsonOutput<{
      credentials: { defaults: string[] };
    }>(stdout);

    assert.deepEqual(parsed.credentials.defaults, ["github-ssh", "codex-rightcode"]);
    assert.equal(fs.existsSync(path.join(userRoot, "credentials", "codex-rightcode.yaml")), true);

    const codexRegistry = (yaml.load(
      fs.readFileSync(path.join(userRoot, "credentials", "codex-rightcode.yaml"), "utf8"),
    ) ?? {}) as {
      metadata?: { active?: boolean; harness?: string; presetId?: string };
    };
    assert.equal(codexRegistry.metadata?.active, true);
    assert.equal(codexRegistry.metadata?.harness, "codex");
    assert.equal(codexRegistry.metadata?.presetId, "rightcode");
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY;
    } else {
      process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY = previousApiKey;
    }
    if (previousScript === undefined) {
      delete process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY_SCRIPT;
    } else {
      process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY_SCRIPT = previousScript;
    }
    if (previousQuotaLimit === undefined) {
      delete process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_QUOTA_LIMIT;
    } else {
      process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_QUOTA_LIMIT = previousQuotaLimit;
    }
    if (previousAllowedPrefixes === undefined) {
      delete process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_ALLOWED_PREFIXES;
    } else {
      process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_ALLOWED_PREFIXES = previousAllowedPrefixes;
    }
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("runCli create allows the same vault name under a different user", async () => {
  const vault = uniqueProjectName("cli-shared-vault");
  const firstUserId = uniqueProjectName("cli-shared-user-a");
  const secondUserId = uniqueProjectName("cli-shared-user-b");
  const firstProfilePath = path.join(USER_ROOT, "profiles", `${firstUserId}.yaml`);
  const secondProfilePath = path.join(USER_ROOT, "profiles", `${secondUserId}.yaml`);
  const firstUserRoot = path.join(USER_ROOT, firstUserId);
  const secondUserRoot = path.join(USER_ROOT, secondUserId);

  try {
    await runCli([
      "user",
      "create",
      firstUserId,
      "--name",
      "CLI Shared User A",
      "--email",
      `${firstUserId}@polaris.local`,
    ]);
    await runCli([
      "user",
      "create",
      secondUserId,
      "--name",
      "CLI Shared User B",
      "--email",
      `${secondUserId}@polaris.local`,
    ]);

    await runCli(["create", vault, "--user", firstUserId]);
    await runCli(["create", vault, "--user", secondUserId]);
    assert.equal(
      fs.existsSync(path.join(secondUserRoot, "vaults", vault, "docker.agent.yaml")),
      true,
    );
  } finally {
    await cleanupCliTestUser({
      userId: firstUserId,
      profilePath: firstProfilePath,
      userRoot: firstUserRoot,
    });
    await cleanupCliTestUser({
      userId: secondUserId,
      profilePath: secondProfilePath,
      userRoot: secondUserRoot,
    });
  }
});

test("runCli vault create scaffolds a vault through the namespaced command", async () => {
  const vault = uniqueProjectName("cli-vault-command");
  const userProfileId = uniqueProjectName("cli-vault-user");
  const profilePath = path.join(USER_ROOT, "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(USER_ROOT, userProfileId);

  try {
    await runCli([
      "user",
      "create",
      userProfileId,
      "--name",
      "CLI Vault User",
      "--email",
      `${userProfileId}@polaris.local`,
    ]);

    await runCli(["vault", "create", vault, "--user", userProfileId]);

    assert.equal(
      fs.existsSync(path.join(userRoot, "vaults", vault, "docker.agent.yaml")),
      true,
    );
  } finally {
    await cleanupCliTestUser({
      userId: userProfileId,
      profilePath,
      userRoot,
    });
  }
});

test("runCli create ignores a retired user default docker base image when scaffolding a vault", async () => {
  const vault = uniqueProjectName("cli-default-base-vault");
  const userProfileId = uniqueProjectName("cli-default-base-user");
  const profilePath = path.join(USER_ROOT, "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(USER_ROOT, userProfileId);
  const configPath = vaultConfigPath(vault, "docker", userProfileId);
  const dockerfilePath = path.join(USER_ROOT, userProfileId, "docker", "vault-prebuilt.Dockerfile");
  const baseImage = "wanghai-admin-portal:latest";

  try {
    await runCli([
      "user",
      "create",
      userProfileId,
      "--name",
      "CLI Default Base User",
      "--email",
      `${userProfileId}@polaris.local`,
    ]);
    const profile = (yaml.load(fs.readFileSync(profilePath, "utf8")) ?? {}) as Record<string, any>;
    profile.vault_defaults = {
      docker: {
        runtime: {
          base_image: baseImage,
        },
      },
    };
    fs.writeFileSync(profilePath, yaml.dump(profile, { lineWidth: 120, noRefs: true }), "utf8");

    await runCli(["create", vault, "--user", userProfileId]);

    const doc = (yaml.load(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<string, any>;
    assert.equal(doc.runtime?.base_image, vaultImageRef(userProfileId, vault));
    assert.equal(fs.existsSync(dockerfilePath), true);
  } finally {
    await cleanupCliTestUser({
      userId: userProfileId,
      profilePath,
      userRoot,
    });
  }
});

test("runCli create --base-image still overrides a retired vault default image", async () => {
  const vault = uniqueProjectName("cli-override-base-vault");
  const userProfileId = uniqueProjectName("cli-override-base-user");
  const profilePath = path.join(USER_ROOT, "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(USER_ROOT, userProfileId);
  const configPath = vaultConfigPath(vault, "docker", userProfileId);
  const dockerfilePath = path.join(USER_ROOT, userProfileId, "docker", "vault-prebuilt.Dockerfile");
  const defaultBaseImage = "wanghai-admin-portal:latest";
  const overrideBaseImage = "wanghai-admin-portal:custom";

  try {
    await runCli([
      "user",
      "create",
      userProfileId,
      "--name",
      "CLI Override Base User",
      "--email",
      `${userProfileId}@polaris.local`,
    ]);
    const profile = (yaml.load(fs.readFileSync(profilePath, "utf8")) ?? {}) as Record<string, any>;
    profile.vault_defaults = {
      docker: {
        runtime: {
          base_image: defaultBaseImage,
        },
      },
    };
    fs.writeFileSync(profilePath, yaml.dump(profile, { lineWidth: 120, noRefs: true }), "utf8");

    const stdout = await captureStdout(async () => {
      await runCli([
        "create",
        vault,
        "--user",
        userProfileId,
        "--base-image",
        overrideBaseImage,
      ]);
    });
    const parsed = parseJsonOutput<{
      baseImage?: string;
    }>(stdout);

    const doc = (yaml.load(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<string, any>;
    assert.equal(parsed.baseImage, overrideBaseImage);
    assert.equal(doc.runtime?.base_image, overrideBaseImage);
    assert.equal(fs.existsSync(dockerfilePath), false);
  } finally {
    await cleanupCliTestUser({
      userId: userProfileId,
      profilePath,
      userRoot,
    });
  }
});

test("runCli user delete removes the user profile, secrets root, and Clerk mapping", async () => {
  const userProfileId = uniqueProjectName("cli-user-delete");
  const clerkUsername = `${userProfileId}-clerk`;
  const profilePath = path.join(USER_ROOT, "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(USER_ROOT, userProfileId);
  const userMapPath = path.join(USER_ROOT, "user-map.json");
  const originalUserMap = fs.existsSync(userMapPath) ? fs.readFileSync(userMapPath, "utf8") : null;

  try {
    await runCli([
      "user",
      "create",
      userProfileId,
      "--name",
      "CLI User Delete",
      "--email",
      `${userProfileId}@polaris.local`,
      "--clerk",
      clerkUsername,
    ]);

    const stdout = await captureStdout(async () => {
      await runCli(["user", "delete", userProfileId]);
    });
    const parsed = parseJsonOutput<{
      userProfile: { id: string; removed: boolean };
      mappings: { removedClerkUsernames: string[] };
    }>(stdout);

    assert.equal(parsed.userProfile.id, userProfileId);
    assert.equal(parsed.userProfile.removed, true);
    assert.deepEqual(parsed.mappings.removedClerkUsernames, [clerkUsername]);
    assert.equal(fs.existsSync(profilePath), false);
    assert.equal(fs.existsSync(userRoot), false);
  } finally {
    await cleanupCliTestUser({
      userId: userProfileId,
      profilePath,
      userRoot,
      userMapPath,
      originalUserMap,
    });
  }
});

test("runCli user create rolls back scaffolded state when the Clerk mapping conflicts", async () => {
  const firstUserId = uniqueProjectName("cli-user-conflict-a");
  const secondUserId = uniqueProjectName("cli-user-conflict-b");
  const clerkUsername = `${uniqueProjectName("cli-clerk-conflict")}-clerk`;
  const firstProfilePath = path.join(USER_ROOT, "profiles", `${firstUserId}.yaml`);
  const secondProfilePath = path.join(USER_ROOT, "profiles", `${secondUserId}.yaml`);
  const firstUserRoot = path.join(USER_ROOT, firstUserId);
  const secondUserRoot = path.join(USER_ROOT, secondUserId);
  const userMapPath = path.join(USER_ROOT, "user-map.json");
  const originalUserMap = fs.existsSync(userMapPath) ? fs.readFileSync(userMapPath, "utf8") : null;

  try {
    await runCli([
      "user",
      "create",
      firstUserId,
      "--name",
      "CLI Conflict A",
      "--email",
      `${firstUserId}@polaris.local`,
      "--clerk",
      clerkUsername,
    ]);

    await assert.rejects(
      async () => {
        await runCli([
          "user",
          "create",
          secondUserId,
          "--name",
          "CLI Conflict B",
          "--email",
          `${secondUserId}@polaris.local`,
          "--clerk",
          clerkUsername,
        ]);
      },
      /already mapped/i,
    );

    assert.equal(fs.existsSync(secondProfilePath), false);
    assert.equal(fs.existsSync(secondUserRoot), false);
  } finally {
    await cleanupCliTestUser({
      userId: firstUserId,
      profilePath: firstProfilePath,
      userRoot: firstUserRoot,
      userMapPath,
      originalUserMap,
    });
    await cleanupCliTestUser({
      userId: secondUserId,
      profilePath: secondProfilePath,
      userRoot: secondUserRoot,
      userMapPath,
      originalUserMap,
    });
  }
});

test("runCli user delete rejects users that still have vault data", async () => {
  const userProfileId = uniqueProjectName("cli-user-delete-blocked");
  const vault = uniqueProjectName("cli-user-delete-vault");
  const profilePath = path.join(USER_ROOT, "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(USER_ROOT, userProfileId);

  try {
    await runCli([
      "user",
      "create",
      userProfileId,
      "--name",
      "CLI User Delete Blocked",
      "--email",
      `${userProfileId}@polaris.local`,
    ]);
    await runCli(["create", vault, "--user", userProfileId]);

    await assert.rejects(
      async () => {
        await runCli(["user", "delete", userProfileId]);
      },
      /cannot be deleted while vault data still exists/i,
    );
  } finally {
    await cleanupCliTestUser({
      userId: userProfileId,
      profilePath,
      userRoot,
    });
  }
});

test("runCli delete removes a vault without creating an archive", async () => {
  const userProfileId = uniqueProjectName("cli-delete-user");
  const vault = uniqueProjectName("cli-delete-vault");
  const profilePath = path.join(
    REPO_ROOT,
    "config",
    "users",
    "profiles",
    `${userProfileId}.yaml`,
  );
  const userRoot = path.join(USER_ROOT, userProfileId);
  const vaultRoot = path.join(userRoot, "vaults", vault);
  const archivedRoot = path.join(userRoot, "archives", "vaults");

  try {
    await runCli([
      "user",
      "create",
      userProfileId,
      "--name",
      "CLI Delete User",
      "--email",
      `${userProfileId}@polaris.local`,
    ]);
    await runCli(["create", vault, "--user", userProfileId]);

    await runCli(["delete", vault]);

    assert.equal(fs.existsSync(vaultRoot), false);
    const archiveEntries = fs.existsSync(archivedRoot)
      ? fs.readdirSync(archivedRoot)
      : [];
    assert.equal(archiveEntries.some((entry) => entry.endsWith(`-${vault}`)), false);
  } finally {
    await cleanupCliTestUser({
      userId: userProfileId,
      profilePath,
      userRoot,
    });
  }
});

test("runCli user credential add, list, and activate manage codex credentials explicitly", async () => {
  const userProfileId = uniqueProjectName("cli-user-credential");
  const profilePath = path.join(USER_ROOT, "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(USER_ROOT, userProfileId);

  try {
    await runCli([
      "user",
      "create",
      userProfileId,
      "--name",
      "CLI Credential User",
      "--email",
      `${userProfileId}@polaris.local`,
    ]);

    const addStdout = await captureStdout(async () => {
      await runCli([
        "user",
        "credential",
        "add",
        userProfileId,
        "--harness",
        "codex",
        "--credential-id",
        "codex-rightcode",
        "--label",
        "RightCode",
        "--provider-name",
        "rightcode",
        "--base-url",
        "https://right.codes/codex/v1",
        "--api-key",
        "test-api-key",
      ]);
    });
    const added = parseJsonOutput<{
      credential: { id: string; active: boolean; paths: string[] };
    }>(addStdout);
    assert.equal(added.credential.id, "codex-rightcode");
    assert.equal(added.credential.active, false);
    assert.deepEqual(added.credential.paths, [
      "credentials/codex/codex-rightcode/auth.json",
      "credentials/codex/codex-rightcode/config.toml",
    ]);

    const activateStdout = await captureStdout(async () => {
      await runCli([
        "user",
        "credential",
        "activate",
        userProfileId,
        "codex-rightcode",
      ]);
    });
    const activated = parseJsonOutput<{
      credential: { id: string; active: boolean };
    }>(activateStdout);
    assert.equal(activated.credential.id, "codex-rightcode");
    assert.equal(activated.credential.active, true);

    const listStdout = await captureStdout(async () => {
      await runCli([
        "user",
        "credential",
        "list",
        userProfileId,
      ]);
    });
    const listed = parseJsonOutput<{
      credentials: Array<{ id: string; active: boolean; harness: string }>;
    }>(listStdout);
    assert.ok(listed.credentials.some((credential) =>
      credential.id === "github-ssh" && credential.harness === "ssh"
    ));
    assert.ok(listed.credentials.some((credential) =>
      credential.id === "codex-rightcode" && credential.active === true && credential.harness === "codex"
    ));

    const codexRegistry = (yaml.load(
      fs.readFileSync(path.join(userRoot, "credentials", "codex-rightcode.yaml"), "utf8"),
    ) ?? {}) as {
      metadata?: { active?: boolean; harness?: string };
    };
    assert.equal(codexRegistry.metadata?.active, true);
    assert.equal(codexRegistry.metadata?.harness, "codex");
  } finally {
    await cleanupCliTestUser({
      userId: userProfileId,
      profilePath,
      userRoot,
    });
  }
});

test("runCli user credential read and write manage credential material directly", async () => {
  const userProfileId = uniqueProjectName("cli-user-credential-read-write");
  const profilePath = path.join(
    REPO_ROOT,
    "config",
    "users",
    "profiles",
    `${userProfileId}.yaml`,
  );
  const userRoot = path.join(USER_ROOT, userProfileId);

  try {
    await runCli([
      "user",
      "create",
      userProfileId,
      "--name",
      "CLI Credential Read Write User",
      "--email",
      `${userProfileId}@polaris.local`,
    ]);

    await runCli([
      "user",
      "credential",
      "add",
      userProfileId,
      "--harness",
      "codex",
      "--credential-id",
      "codex-read-write",
      "--label",
      "Read Write",
      "--provider-name",
      "rightcode",
      "--base-url",
      "https://right.codes/codex/v1",
      "--api-key",
      "initial-api-key",
    ]);

    const readStdout = await captureStdout(async () => {
      await runCli([
        "user",
        "credential",
        "read",
        userProfileId,
        "codex-read-write",
      ]);
    });
    const readPayload = parseJsonOutput<{
      credential: {
        summary: { id: string };
        files: Array<{ key: string; content: string }>;
      };
    }>(readStdout);
    assert.equal(readPayload.credential.summary.id, "codex-read-write");
    assert.ok(
      readPayload.credential.files.some((file) =>
        file.key === "codex-auth.json" && file.content.includes("initial-api-key")
      ),
    );

    const writeStdout = await captureStdout(async () => {
      await runCli([
        "user",
        "credential",
        "write",
        userProfileId,
        "codex-read-write",
        "codex-auth.json",
        "--content",
        JSON.stringify({
          OPENAI_API_KEY: "updated-api-key",
        }, null, 2),
      ]);
    });
    const writePayload = parseJsonOutput<{
      credential: {
        credential: { id: string };
        file: { key: string; content: string };
      };
    }>(writeStdout);
    assert.equal(writePayload.credential.credential.id, "codex-read-write");
    assert.equal(writePayload.credential.file.key, "codex-auth.json");
    assert.ok(writePayload.credential.file.content.includes("updated-api-key"));

    const authPath = path.join(
      userRoot,
      "credentials",
      "codex",
      "codex-read-write",
      "auth.json",
    );
    const authContent = fs.readFileSync(authPath, "utf8");
    assert.ok(authContent.includes("updated-api-key"));
  } finally {
    await cleanupCliTestUser({
      userId: userProfileId,
      profilePath,
      userRoot,
    });
  }
});

test("runCli user credential add supports non-codex harness inventory entries", async () => {
  const userProfileId = uniqueProjectName("cli-user-credential-claude");
  const profilePath = path.join(
    REPO_ROOT,
    "config",
    "users",
    "profiles",
    `${userProfileId}.yaml`,
  );
  const userRoot = path.join(USER_ROOT, userProfileId);

  try {
    await runCli([
      "user",
      "create",
      userProfileId,
      "--name",
      "CLI Claude User",
      "--email",
      `${userProfileId}@polaris.local`,
    ]);

    const addStdout = await captureStdout(async () => {
      await runCli([
        "user",
        "credential",
        "add",
        userProfileId,
        "--harness",
        "claude",
        "--credential-id",
        "claude-team",
        "--label",
        "Claude Team",
        "--provider-name",
        "anthropic",
        "--api-key",
        "claude-secret",
      ]);
    });
    const added = parseJsonOutput<{
      credential: {
        id: string;
        harness: string;
        active: boolean;
        paths: string[];
      };
    }>(addStdout);
    assert.equal(added.credential.id, "claude-team");
    assert.equal(added.credential.harness, "claude");
    assert.equal(added.credential.active, false);
    assert.deepEqual(added.credential.paths, [
      "credentials/claude/claude-team/credential.json",
    ]);

    const listStdout = await captureStdout(async () => {
      await runCli(["user", "credential", "list", userProfileId]);
    });
    const listed = parseJsonOutput<{
      credentials: Array<{ id: string; harness: string }>;
    }>(listStdout);
    assert.ok(
      listed.credentials.some((credential) =>
        credential.id === "claude-team" && credential.harness === "claude"
      ),
    );

    const material = JSON.parse(
      fs.readFileSync(
        path.join(userRoot, "credentials", "claude", "claude-team", "credential.json"),
        "utf8",
      ),
    ) as { harness?: string; providerName?: string; apiKey?: string };
    assert.equal(material.harness, "claude");
    assert.equal(material.providerName, "anthropic");
    assert.equal(material.apiKey, "claude-secret");
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("runCli user skill add, list, and remove manage declarative skill registry entries", async () => {
  const userProfileId = uniqueProjectName("cli-user-skill");
  const profilePath = path.join(USER_ROOT, "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(USER_ROOT, userProfileId);

  try {
    await runCli([
      "user",
      "create",
      userProfileId,
      "--name",
      "CLI Skill User",
      "--email",
      `${userProfileId}@polaris.local`,
    ]);

    const addStdout = await captureStdout(async () => {
      await runCli([
        "user",
        "skill",
        "add",
        userProfileId,
        "--source",
        "vercel-labs/agent-skills",
        "--skill",
        "use-polaris",
      ]);
    });
    const added = parseJsonOutput<{
      skill: { id: string; packageName: string; args: string[]; harness: string };
    }>(addStdout);
    assert.equal(added.skill.id, "use-polaris");
    assert.equal(added.skill.packageName, "skills");
    assert.deepEqual(added.skill.args, [
      "add",
      "vercel-labs/agent-skills",
      "--copy",
      "-y",
      "--agent",
      "codex",
      "--skill",
      "use-polaris",
    ]);
    assert.equal(added.skill.harness, "codex");

    const listStdout = await captureStdout(async () => {
      await runCli(["user", "skill", "list", userProfileId]);
    });
    const listed = parseJsonOutput<{
      skills: Array<{ id: string; command: string[] }>;
    }>(listStdout);
    assert.deepEqual(listed.skills[0]?.command, [
      "npx",
      "-y",
      "skills",
      "add",
      "vercel-labs/agent-skills",
      "--copy",
      "-y",
      "--agent",
      "codex",
      "--skill",
      "use-polaris",
    ]);

    const registry = (yaml.load(
      fs.readFileSync(path.join(userRoot, "skills", "use-polaris.yaml"), "utf8"),
    ) ?? {}) as { packageName?: string; args?: string[]; source?: string; selectedSkillName?: string };
    assert.equal(registry.packageName, "skills");
    assert.deepEqual(registry.args, [
      "add",
      "vercel-labs/agent-skills",
      "--copy",
      "-y",
      "--agent",
      "codex",
      "--skill",
      "use-polaris",
    ]);
    assert.equal(registry.source, "vercel-labs/agent-skills");
    assert.equal(registry.selectedSkillName, "use-polaris");

    const removeStdout = await captureStdout(async () => {
      await runCli(["user", "skill", "remove", userProfileId, "use-polaris"]);
    });
    const removed = parseJsonOutput<{
      skill: { id: string; removed: boolean };
    }>(removeStdout);
    assert.equal(removed.skill.id, "use-polaris");
    assert.equal(removed.skill.removed, true);
    assert.equal(fs.existsSync(path.join(userRoot, "skills", "use-polaris.yaml")), false);
  } finally {
    await cleanupCliTestUser({
      userId: userProfileId,
      profilePath,
      userRoot,
    });
  }
});

test("runCli live-switch stages non-codex material into user identity state", async () => {
  const project = uniqueProjectName("cli-live-switch");
  const scriptLogPath = path.join(os.tmpdir(), `${project}-live-switch-script.log`);

  await withTempVaultSpec(project, "docker", async () => {
    try {
      await runCli([
        "user",
        "credential",
        "add",
        DEMO_USER_PROFILE_ID,
        "--harness",
        "claude",
        "--credential-id",
        "claude-live",
        "--label",
        "Claude Live",
        "--provider-name",
        "anthropic",
        "--api-key",
        "claude-live-secret",
      ]);

      await withFakeCommands(
        {
          docker: `
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf '${project}-docker-id'
  exit 0
fi
if [[ "$*" == *"inspect ${project}-docker-id"* ]]; then
  printf '[{"State":{"Running":true}}]'
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  printf '%s\n' "$5" >> ${JSON.stringify(scriptLogPath)}
  exit 0
fi
exit 0
`,
        },
        async ({ readCommandLog }) => {
          const expectedContainerName =
            `${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}-docker`;
          const stdout = await captureStdout(async () => {
            await runCli([
              "live-switch",
              `${project}@docker`,
              "claude-live",
              "--harness",
              "claude",
            ]);
          });
          const payload = parseJsonOutput<{
            switched: boolean;
            vault: string;
            harness: string;
            credentialId: string;
          }>(stdout);
          assert.equal(payload.switched, true);
          assert.equal(payload.vault, project);
          assert.equal(payload.harness, "claude");
          assert.equal(payload.credentialId, "claude-live");
          assert.ok(
            readCommandLog().some((entry) =>
              entry.includes(`exec ${expectedContainerName} sh -lc`),
            ),
          );
          assert.match(
            fs.readFileSync(scriptLogPath, "utf8"),
            /\/identity\/claude\/credential\.json/,
          );
        },
      );
    } finally {
      fs.rmSync(scriptLogPath, { force: true });
      fs.rmSync(
        path.join(
          REPO_ROOT,
          "config",
          "users",
          DEMO_USER_PROFILE_ID,
          "vaults",
          project,
          "state",
          "live-credentials.json",
        ),
        { force: true },
      );
      fs.rmSync(
        path.join(USER_ROOT, DEMO_USER_PROFILE_ID, "credentials", "claude", "claude-live"),
        { recursive: true, force: true },
      );
      fs.rmSync(
        path.join(USER_ROOT, DEMO_USER_PROFILE_ID, "credentials", "claude-live.yaml"),
        { force: true },
      );
    }
  });
});

test("writeVaultStatus persists a structured state file", () => {
  const project = uniqueProjectName("sample-agent");
  const statusPath = writeVaultStatus({
    schemaVersion: 1.1,
    project,
    driver: {
      selected: { backend: "pod", profile: "gvisor" },
      status: "unknown",
      baseImage: "ttl.sh/example:24h",
      runtimeKind: "kubernetes-pod",
      runtimeRef: "deployment/example",
    },
    paseo: {
      daemon: "unknown",
      web: "unavailable",
      reconnectMode: "unknown",
      liveTarget: null,
      reconnectTarget: null,
    },
    details: {
      driver: "pod",
    },
  }, DEMO_USER_PROFILE_ID);

  assert.ok(fs.existsSync(statusPath));
  const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8")) as {
    project: string;
    schemaVersion?: number;
    driver?: { selected?: { backend?: string; profile?: string } };
  };
  assert.equal(parsed.project, project);
  assert.equal(parsed.schemaVersion, 1.1);
  assert.equal(parsed.driver?.selected?.backend, "pod");
  assert.equal(parsed.driver?.selected?.profile, "gvisor");

  cleanupStatusFile(project);
});

test("writeVaultStatus replaces stale fields instead of merging previous status", () => {
  const project = uniqueProjectName("replace-status");
  const statusPath = writeVaultStatus({
    schemaVersion: 1.1,
    project,
    driver: {
      selected: null,
      status: "starting",
      reason: "vault start requested",
    },
    paseo: {
      daemon: "absent",
      web: "unavailable",
      reconnectMode: "unknown",
      liveTarget: null,
      reconnectTarget: null,
    },
    details: {
      stale: "yes",
    },
  }, DEMO_USER_PROFILE_ID);

  writeVaultStatus({
    schemaVersion: 1.1,
    project,
    driver: {
      selected: null,
      status: "running",
    },
    paseo: {
      daemon: "ready",
      web: "connectable",
      reconnectMode: "reconnectable",
      liveTarget: "https://app.paseo.sh/#offer=test",
      reconnectTarget: "https://app.paseo.sh/h/srv_test?scope=demo",
    },
    details: {},
  }, DEMO_USER_PROFILE_ID);

  const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8")) as {
    driver?: { status?: string; reason?: string };
    paseo: { daemon: string; web: string };
    details: Record<string, string>;
  };
  assert.equal(parsed.driver?.status, "running");
  assert.equal(parsed.driver?.reason, undefined);
  assert.equal(parsed.paseo.daemon, "ready");
  assert.equal(parsed.paseo.web, "connectable");
  assert.deepEqual(parsed.details, {});

  cleanupStatusFile(project);
});

test("driver selection persists a default backend control", () => {
  const project = uniqueProjectName("driver-selection");
  const statusPath = writeVaultDriverSelection(
    project,
    { backend: "pod", profile: "gvisor" },
    DEMO_USER_PROFILE_ID,
  );
  assert.equal(fs.existsSync(statusPath), true);
  const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8")) as {
    driver?: { selected?: { backend?: string; profile?: string } };
  };
  assert.equal(parsed.driver?.selected?.backend, "pod");
  assert.equal(parsed.driver?.selected?.profile, "gvisor");
  cleanupStatusFile(project);
});

test("vaultImageRef derives a neutral deterministic ttl.sh reference", () => {
  assert.equal(
    vaultImageRef("100000000000000001", "example-project"),
    "ttl.sh/user-001-example-project:24h",
  );
  assert.equal(
    vaultImageRef("local-example-user@example.com", "Feature Preview"),
    "ttl.sh/user-local-example-user-examp-feature-preview:24h",
  );
  assert.equal(
    vaultImageRef(
      "portal-live-create-user-267278-1785764441231",
      "portal-live-create-vault-267278-1785764441231",
    ),
    "ttl.sh/user-portal-live-create-user-portal-live-create-vault-267278:24h",
  );
});

test("ensureVaultConfig synthesizes a pod spec from the docker source of truth", () => {
  const project = uniqueProjectName("synth-pod");
  const dockerPath = vaultConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
  const podPath = vaultConfigPath(project, "pod", DEMO_USER_PROFILE_ID);
  fs.mkdirSync(path.dirname(dockerPath), { recursive: true });
  fs.copyFileSync(vaultConfigPath("demo", "docker", DEMO_USER_PROFILE_ID), dockerPath);

  const sourceDoc = (yaml.load(fs.readFileSync(dockerPath, "utf8")) ?? {}) as Record<string, any>;
  sourceDoc.project = project;
  fs.writeFileSync(dockerPath, yaml.dump(sourceDoc, { lineWidth: 120, noRefs: true }), "utf8");

  try {
    const synthesized = ensureVaultConfig(`${project}@pod:gvisor`);
    assert.equal(fs.existsSync(podPath), true);
    assert.equal(synthesized?.configPath, podPath);
    const podDoc = (yaml.load(fs.readFileSync(podPath, "utf8")) ?? {}) as Record<string, any>;
    assert.equal(podDoc.backend.kind, "pod");
    assert.equal(podDoc.runtime.class, "gvisor");
    assert.equal(podDoc.runtime.base_image, sourceDoc.runtime.base_image);
    assert.equal(podDoc.attachments["vault-data"].source.kind, "netfs");
    assert.equal(podDoc.attachments["vault-data"].source.server, "netfs.local");
    assert.equal(
      podDoc.attachments["vault-data"].source.export_path,
      DEMO_VAULT_EXPORT_ROOT,
    );
    assert.equal(podDoc.attachments["vault-data"].source.sub_path, project);
    assert.equal(
      podDoc.attachments["vault-runtime-state"].source.volume_ref,
      vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vault-runtime-state"),
    );
  } finally {
    fs.rmSync(dockerPath, { force: true });
    fs.rmSync(podPath, { force: true });
  }
});

test("ensureCanonicalVaultImage builds the canonical docker image locally when it is missing", async () => {
  ensureDemoVaultFixtures();
  const project = uniqueProjectName("image-provision");
  const imageRef = vaultImageRef(DEMO_USER_PROFILE_ID, project);
  const dockerPath = vaultConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
  const sharedImageRef = sharedVaultImageRefForTest(DEMO_USER_DOCKERFILE);
  fs.mkdirSync(path.dirname(dockerPath), { recursive: true });
  fs.copyFileSync(vaultConfigPath("demo", "docker", DEMO_USER_PROFILE_ID), dockerPath);

  const doc = (yaml.load(fs.readFileSync(dockerPath, "utf8")) ?? {}) as Record<string, any>;
  doc.project = project;
  doc.user_profile = DEMO_USER_PROFILE_ID;
  doc.runtime.base_image = imageRef;
  fs.writeFileSync(dockerPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");

  try {
    await withFakeCommands(
      {
        docker: `
if [[ "$1 $2 $3" == "image inspect ${imageRef}" ]]; then
  exit 1
fi
if [[ "$1" == "pull" && "$2" == "${imageRef}" ]]; then
  exit 1
fi
if [[ "$1 $2 $3" == "image inspect ${sharedImageRef}" ]]; then
  exit 1
fi
if [[ "$1" == "pull" && "$2" == "${sharedImageRef}" ]]; then
  exit 1
fi
exit 0
`,
      },
      async ({ readCommandLog }) => {
        ensureCanonicalVaultImage(`${project}@docker`);
        const commandLog = readCommandLog();
        assert.equal(commandLog[0], `image inspect ${sharedImageRef}`);
        assert.equal(commandLog[1], `pull ${sharedImageRef}`);
        assert.ok(
          commandLog.some((entry) =>
          entry.startsWith("build ")
            && entry.includes(`--cache-from ${sharedImageRef}`)
            && entry.includes(`--cache-from ${imageRef}`)
            && entry.includes(`-f ${DEMO_USER_DOCKERFILE}`)
            && entry.includes(`-t ${sharedImageRef} .`),
        ),
        );
        assert.equal(commandLog.at(-1), `tag ${sharedImageRef} ${imageRef}`);
      },
    );
  } finally {
    fs.rmSync(dockerPath, { force: true });
    fs.rmSync(path.join(USER_ROOT, DEMO_USER_PROFILE_ID, "vaults", project), {
      recursive: true,
      force: true,
    });
  }
});

test("ensureCanonicalVaultImage skips managed image provisioning for external base images", async () => {
  const userProfileId = uniqueProjectName("external-image-user");
  const project = uniqueProjectName("external-image-project");
  const profilePath = path.join(USER_ROOT, "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(USER_ROOT, userProfileId);
  const baseImage = "wanghai-admin-portal:latest";

  try {
    await runCli([
      "user",
      "create",
      userProfileId,
      "--name",
      "External Image User",
      "--email",
      `${userProfileId}@polaris.local`,
    ]);

    await runCli([
      "create",
      project,
      "--user",
      userProfileId,
      "--base-image",
      baseImage,
    ]);

    await withFakeCommands(
      {
        docker: `
printf 'unexpected docker call for external base image\\n' >&2
exit 1
`,
      },
      async ({ readCommandLog }) => {
        ensureCanonicalVaultImage(`${project}@docker`, userProfileId);
        assert.deepEqual(readCommandLog(), []);
      },
    );
  } finally {
    await cleanupCliTestUser({
      userId: userProfileId,
      profilePath,
      userRoot,
    });
  }
});

test("syncVaultDockerfileTemplate refreshes a stale user Dockerfile from the shared template", () => {
  const userProfileId = uniqueProjectName("dockerfile-sync");
  const userDockerfile = path.join(USER_ROOT, userProfileId, "docker", "vault-prebuilt.Dockerfile");
  const templateDockerfile = SHARED_VAULT_DOCKERFILE;
  const templateStat = fs.statSync(templateDockerfile);
  fs.mkdirSync(path.dirname(userDockerfile), { recursive: true });
  fs.writeFileSync(userDockerfile, "FROM scratch\n", "utf8");
  const older = new Date(templateStat.mtimeMs - 60_000);
  const newer = new Date(Date.now() + 60_000);
  fs.utimesSync(userDockerfile, older, older);
  fs.utimesSync(templateDockerfile, newer, newer);

  try {
    const result = syncVaultDockerfileTemplate(userProfileId);
    assert.equal(result.created, false);
    assert.equal(result.refreshed, true);
    assert.equal(result.path, userDockerfile);
    assert.equal(
      fs.readFileSync(userDockerfile, "utf8"),
      fs.readFileSync(templateDockerfile, "utf8"),
    );
  } finally {
    fs.utimesSync(templateDockerfile, templateStat.atime, templateStat.mtime);
    fs.rmSync(path.join(USER_ROOT, userProfileId), { recursive: true, force: true });
  }
});

test("vault prebuilt Dockerfile delegates shared base tool installation", () => {
  const templateDockerfile = SHARED_VAULT_DOCKERFILE;
  const rendered = fs.readFileSync(templateDockerfile, "utf8");
  assert.match(rendered, /COPY config\/docker\/base-tools \/tmp\/polaris-base-tools/);
  assert.match(rendered, /RUN bash \/tmp\/polaris-base-tools\/install-base-tools\.sh/);
  assert.equal(
    fs.existsSync(path.join(REPO_ROOT, "config", "docker", "base-tools", "apt-packages.txt")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(REPO_ROOT, "config", "docker", "base-tools", "python-packages.txt")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(REPO_ROOT, "config", "docker", "base-tools", "node-packages.txt")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(REPO_ROOT, "config", "docker", "base-tools", "install-base-tools.sh")),
    true,
  );
});

test("startCommand does not provision or rebuild vault images", async () => {
  const project = uniqueProjectName("start-no-provision");
  const previousExportRoot = process.env.POLARIS_NETFS_LOCAL_EXPORT_ROOT;
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-start-export-"));
  await withTempVaultSpec(project, "docker", async () => {
    const dockerPath = vaultConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
    const doc = (yaml.load(fs.readFileSync(dockerPath, "utf8")) ?? {}) as Record<string, any>;
    doc.attachments["vault-data"].source.export_path = exportRoot;
    fs.writeFileSync(dockerPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
    const expectedIdentityVolume = `polaris-${DEMO_USER_PROFILE_ID}-identity`;
    try {
      process.env.POLARIS_NETFS_LOCAL_EXPORT_ROOT = exportRoot;
      await withFakeCommands(
        {
          docker: `
if [[ "$1" == "volume" && "$2" == "inspect" && "$3" == "${expectedIdentityVolume}" ]]; then
  exit 1
fi
if [[ "$1" == "volume" && "$2" == "create" && "$3" == "${expectedIdentityVolume}" ]]; then
  printf '%s' "$3"
  exit 0
fi
if [[ "$*" == *"compose"* && "$*" == *"up -d"* ]]; then
  exit 0
fi
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf 'abc123'
  exit 0
fi
if [[ "$*" == *"inspect abc123"* ]]; then
  printf '[{"State":{"Running":true}}]'
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  if [[ "$5" == *"cat /root/.paseo/server-id"* ]]; then
    printf 'srv_start_test'
    exit 0
  fi
  if [[ "$5" == *"cat /root/.paseo/pairing.json"* ]]; then
    printf '{"url":"https://app.paseo.test/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9zdGFydF90ZXN0In0","serverId":"srv_start_test"}'
    exit 0
  fi
  exit 0
fi
if [[ "$1" == "image" || "$1" == "pull" || "$1" == "tag" || "$1" == "build" ]]; then
  printf 'unexpected image provisioning during start' >&2
  exit 1
fi
exit 0
`,
        },
        async ({ readCommandLog }) => {
          await startCommand(`${project}@docker`, DEMO_USER_PROFILE_ID);
          const commands = readCommandLog();
          const paseoRoot = vaultPaseoStateDir(project, DEMO_USER_PROFILE_ID);
          assert.equal(
            commands.some((entry) =>
              entry.startsWith("image inspect ")
              || entry.startsWith("pull ")
              || entry.startsWith("tag ")
              || entry.startsWith("build ")
            ),
            false,
          );
          assert.ok(
            commands.some((entry) => entry.includes("compose") && entry.includes(" up -d")),
          );
          assert.equal(
            fs.readFileSync(path.join(paseoRoot, "server-id"), "utf8").trim(),
            "srv_start_test",
          );
          assert.deepEqual(
            JSON.parse(fs.readFileSync(path.join(paseoRoot, "pairing.json"), "utf8")) as Record<string, unknown>,
            {
              url: "https://app.paseo.test/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9zdGFydF90ZXN0In0",
              serverId: "srv_start_test",
            },
          );
        },
      );
    } finally {
      if (previousExportRoot === undefined) {
        delete process.env.POLARIS_NETFS_LOCAL_EXPORT_ROOT;
      } else {
        process.env.POLARIS_NETFS_LOCAL_EXPORT_ROOT = previousExportRoot;
      }
      fs.rmSync(exportRoot, { recursive: true, force: true });
    }
  });
});

test("waitForVaultReady persists Paseo metadata before declaring runtime ready", async () => {
  const project = uniqueProjectName("wait-ready-paseo-persist");
  await withTempVaultSpec(project, "docker", async () => {
    const vault = loadVaultFromRefForTest(`${project}@docker`);
    const paseoRoot = vaultPaseoStateDir(project, DEMO_USER_PROFILE_ID);
    fs.rmSync(paseoRoot, { recursive: true, force: true });

    await withFakeCommands(
      {
        docker: `
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf 'abc123'
  exit 0
fi
if [[ "$*" == *"inspect abc123"* ]]; then
  printf '[{"State":{"Running":true}}]'
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  if [[ "$5" == *"cat /root/.paseo/server-id"* ]]; then
    printf 'srv_wait_ready'
    exit 0
  fi
  if [[ "$5" == *"cat /root/.paseo/pairing.json"* ]]; then
    printf '{"url":"https://app.paseo.test/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl93YWl0X3JlYWR5In0","serverId":"srv_wait_ready"}'
    exit 0
  fi
  exit 0
fi
exit 0
`,
      },
      async ({ readCommandLog }) => {
        await waitForVaultReady(vault, 50, 0);

        const commands = readCommandLog();
        assert.ok(
          commands.some((entry) => entry.includes("cat /root/.paseo/server-id")),
        );
        assert.ok(
          commands.some((entry) => entry.includes("cat /root/.paseo/pairing.json")),
        );
        assert.equal(
          fs.readFileSync(path.join(paseoRoot, "server-id"), "utf8").trim(),
          "srv_wait_ready",
        );
        assert.deepEqual(
          JSON.parse(fs.readFileSync(path.join(paseoRoot, "pairing.json"), "utf8")) as Record<string, unknown>,
          {
            url: "https://app.paseo.test/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl93YWl0X3JlYWR5In0",
            serverId: "srv_wait_ready",
          },
        );
      },
    );
  });
});

test("ensureCanonicalVaultImage rebuilds when the user Dockerfile is refreshed from the template", async () => {
  const userProfileId = uniqueProjectName("dockerfile-rebuild");
  const project = uniqueProjectName("image-refresh");
  const imageRef = vaultImageRef(userProfileId, project);
  const dockerPath = vaultConfigPath(project, "docker", userProfileId);
  const userDockerfile = path.join(USER_ROOT, userProfileId, "docker", "vault-prebuilt.Dockerfile");
  const templateDockerfile = SHARED_VAULT_DOCKERFILE;
  const sharedImageRef = sharedVaultImageRefForTest(templateDockerfile);
  const templateStat = fs.statSync(templateDockerfile);
  fs.mkdirSync(path.dirname(dockerPath), { recursive: true });
  fs.copyFileSync(vaultConfigPath("demo", "docker", DEMO_USER_PROFILE_ID), dockerPath);
  const doc = (yaml.load(fs.readFileSync(dockerPath, "utf8")) ?? {}) as Record<string, any>;
  doc.project = project;
  doc.user_profile = userProfileId;
  doc.runtime.base_image = imageRef;
  fs.writeFileSync(dockerPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
  fs.mkdirSync(path.dirname(userDockerfile), { recursive: true });
  fs.writeFileSync(userDockerfile, "FROM scratch\n", "utf8");
  const older = new Date(templateStat.mtimeMs - 60_000);
  const newer = new Date(Date.now() + 60_000);
  fs.utimesSync(userDockerfile, older, older);
  fs.utimesSync(templateDockerfile, newer, newer);

  try {
    await withFakeCommands(
      {
        docker: `
if [[ "$1 $2 $3" == "image inspect ${imageRef}" ]]; then
  exit 0
fi
if [[ "$1" == "pull" && "$2" == "${imageRef}" ]]; then
  exit 0
fi
if [[ "$1 $2 $3" == "image inspect ${sharedImageRef}" ]]; then
  exit 1
fi
if [[ "$1" == "pull" && "$2" == "${sharedImageRef}" ]]; then
  exit 1
fi
exit 0
`,
      },
      async ({ readCommandLog }) => {
        ensureCanonicalVaultImage(`${project}@docker`);
        const commandLog = readCommandLog();
        assert.equal(commandLog[0], `image inspect ${sharedImageRef}`);
        assert.equal(commandLog[1], `pull ${sharedImageRef}`);
        assert.match(commandLog[2] ?? "", new RegExp(`--cache-from ${sharedImageRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        assert.match(commandLog[2] ?? "", new RegExp(`--cache-from ${imageRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        assert.match(commandLog[2] ?? "", new RegExp(`-f ${userDockerfile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `));
        assert.match(commandLog[2] ?? "", new RegExp(`-t ${sharedImageRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\.`));
        assert.equal(commandLog.at(-1), `tag ${sharedImageRef} ${imageRef}`);
        assert.equal(
          fs.readFileSync(userDockerfile, "utf8"),
          fs.readFileSync(templateDockerfile, "utf8"),
        );
      },
    );
  } finally {
    fs.utimesSync(templateDockerfile, templateStat.atime, templateStat.mtime);
    fs.rmSync(dockerPath, { force: true });
    fs.rmSync(path.join(USER_ROOT, userProfileId), { recursive: true, force: true });
  }
});

test("ensureCanonicalVaultImage rebuilds when a local image exists without matching build state", async () => {
  const userProfileId = uniqueProjectName("image-state-user");
  const project = uniqueProjectName("image-state-project");
  const imageRef = vaultImageRef(userProfileId, project);
  const dockerPath = vaultConfigPath(project, "docker", userProfileId);
  const userDockerfile = path.join(
    USER_ROOT,
    userProfileId,
    "docker",
    "vault-prebuilt.Dockerfile",
  );
  fs.mkdirSync(path.dirname(dockerPath), { recursive: true });
  fs.copyFileSync(vaultConfigPath("demo", "docker", DEMO_USER_PROFILE_ID), dockerPath);
  const doc = (yaml.load(fs.readFileSync(dockerPath, "utf8")) ?? {}) as Record<string, any>;
  doc.project = project;
  doc.user_profile = userProfileId;
  doc.runtime.base_image = imageRef;
  fs.writeFileSync(dockerPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
  fs.mkdirSync(path.dirname(userDockerfile), { recursive: true });
  fs.copyFileSync(
    SHARED_VAULT_DOCKERFILE,
    userDockerfile,
  );
  const sharedImageRef = sharedVaultImageRefForTest(userDockerfile);

  try {
    await withFakeCommands(
      {
        docker: `
if [[ "$1 $2 $3" == "image inspect ${imageRef}" ]]; then
  exit 0
fi
if [[ "$1" == "pull" && "$2" == "${imageRef}" ]]; then
  exit 0
fi
if [[ "$1 $2 $3" == "image inspect ${sharedImageRef}" ]]; then
  exit 1
fi
if [[ "$1" == "pull" && "$2" == "${sharedImageRef}" ]]; then
  exit 1
fi
exit 0
`,
      },
      async ({ readCommandLog }) => {
        ensureCanonicalVaultImage(`${project}@docker`);
        const commandLog = readCommandLog();
        assert.equal(commandLog[0], `image inspect ${sharedImageRef}`);
        assert.equal(commandLog[1], `pull ${sharedImageRef}`);
        assert.match(commandLog[2] ?? "", new RegExp(`--cache-from ${sharedImageRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        assert.match(commandLog[2] ?? "", new RegExp(`--cache-from ${imageRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        assert.match(commandLog[2] ?? "", new RegExp(`-f ${userDockerfile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `));
        assert.match(commandLog[2] ?? "", new RegExp(`-t ${sharedImageRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\.`));
        assert.equal(commandLog.at(-1), `tag ${sharedImageRef} ${imageRef}`);
      },
    );
  } finally {
    fs.rmSync(path.join(USER_ROOT, userProfileId), {
      recursive: true,
      force: true,
    });
  }
});

test("ensureCanonicalVaultImage reuses a shared prebuilt image from another vault with the same Dockerfile", async () => {
  const userProfileId = uniqueProjectName("shared-image-user");
  const sourceProject = uniqueProjectName("shared-image-source");
  const targetProject = uniqueProjectName("shared-image-target");
  const sourceImageRef = vaultImageRef(userProfileId, sourceProject);
  const targetImageRef = vaultImageRef(userProfileId, targetProject);
  const sourceDockerPath = vaultConfigPath(sourceProject, "docker", userProfileId);
  const targetDockerPath = vaultConfigPath(targetProject, "docker", userProfileId);
  const userDockerfile = path.join(
    REPO_ROOT,
    "config",
    "users",
    userProfileId,
    "docker",
    "vault-prebuilt.Dockerfile",
  );
  fs.mkdirSync(path.dirname(sourceDockerPath), { recursive: true });
  fs.mkdirSync(path.dirname(targetDockerPath), { recursive: true });
  fs.copyFileSync(vaultConfigPath("demo", "docker", DEMO_USER_PROFILE_ID), sourceDockerPath);
  fs.copyFileSync(vaultConfigPath("demo", "docker", DEMO_USER_PROFILE_ID), targetDockerPath);
  fs.mkdirSync(path.dirname(userDockerfile), { recursive: true });
  fs.copyFileSync(
    SHARED_VAULT_DOCKERFILE,
    userDockerfile,
  );
  const sharedImageRef = sharedVaultImageRefForTest(userDockerfile);
  const dockerfileDigest = createHash("sha256")
    .update(fs.readFileSync(userDockerfile))
    .digest("hex");
  fs.mkdirSync(path.join(path.dirname(sourceDockerPath), "state"), { recursive: true });
  fs.writeFileSync(
    path.join(path.dirname(sourceDockerPath), "state", "image-build.json"),
    `${JSON.stringify({
      imageRef: sourceImageRef,
      sharedImageRef,
      dockerfileDigest,
      dockerfilePath: path.relative(REPO_ROOT, userDockerfile),
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );

  const targetDoc = (yaml.load(fs.readFileSync(targetDockerPath, "utf8")) ?? {}) as Record<string, any>;
  targetDoc.project = targetProject;
  targetDoc.user_profile = userProfileId;
  targetDoc.runtime.base_image = targetImageRef;
  fs.writeFileSync(targetDockerPath, yaml.dump(targetDoc, { lineWidth: 120, noRefs: true }), "utf8");

  try {
    await withFakeCommands(
      {
        docker: `
if [[ "$1 $2 $3" == "image inspect ${targetImageRef}" ]]; then
  exit 1
fi
if [[ "$1" == "pull" && "$2" == "${targetImageRef}" ]]; then
  exit 1
fi
if [[ "$1 $2 $3" == "image inspect ${sharedImageRef}" ]]; then
  exit 0
fi
if [[ "$1" == "pull" && "$2" == "${sharedImageRef}" ]]; then
  exit 0
fi
exit 0
`,
      },
      async ({ readCommandLog }) => {
        ensureCanonicalVaultImage(`${targetProject}@docker`);
        assert.deepEqual(readCommandLog(), [
          `image inspect ${sharedImageRef}`,
          `tag ${sharedImageRef} ${targetImageRef}`,
        ]);
      },
    );
  } finally {
    fs.rmSync(path.join(USER_ROOT, userProfileId), {
      recursive: true,
      force: true,
    });
  }
});

test("project ownership check rejects collisions across users", () => {
  const project = uniqueProjectName("collision");
  const firstPath = vaultConfigPath(project, "docker", "111111111111111111");
  const secondPath = vaultConfigPath(project, "docker", "222222222222222222");
  fs.mkdirSync(path.dirname(firstPath), { recursive: true });
  fs.mkdirSync(path.dirname(secondPath), { recursive: true });
  fs.writeFileSync(firstPath, "project: collision\n", "utf8");
  fs.writeFileSync(secondPath, "project: collision\n", "utf8");

  try {
    assert.throws(() => assertNoProjectNameCollision(project), /Project name collision/);
  } finally {
    fs.rmSync(path.join(USER_ROOT, "111111111111111111"), { recursive: true, force: true });
    fs.rmSync(path.join(USER_ROOT, "222222222222222222"), { recursive: true, force: true });
  }
});

test("stored pod driver selection influences default vault loading", () => {
  const project = "demo";
  writeVaultDriverSelection(project, { backend: "pod", profile: "kata" }, DEMO_USER_PROFILE_ID);
  try {
    const vault = loadVaultFromRefForTest(project);
    assert.equal(vault.backend.kind, "pod");
    assert.equal(vault.backend.profile, "kata-qemu");
  } finally {
    cleanupDriverSelectionState(project);
  }
});

test("stored docker driver selection influences default vault loading", () => {
  const project = "demo";
  writeVaultDriverSelection(project, { backend: "docker" }, DEMO_USER_PROFILE_ID);
  try {
    const vault = loadVaultFromRefForTest(project);
    assert.equal(vault.backend.kind, "docker");
  } finally {
    cleanupDriverSelectionState(project);
  }
});

test("status command exposes evolution explainability details", async () => {
  const project = uniqueProjectName("explained-status");
  await withTempVaultSpec(project, "docker", async () => {
    const vault = loadVaultFromRefForTest(`${project}@docker`);
    const evolutionDir = vaultEvolutionStateDir(
      vault.identity.projectName,
      vault.userProfile.id,
    );
    const dbPath = path.join(evolutionDir, "store.db");
    try {
      const store = await EvolutionStore.open(dbPath);
      const now = new Date().toISOString();
      try {
        store.upsertMemoryEntry({
          id: "vault-memory:Validation:run-verifier-first:test",
          vaultId: vault.identity.projectName,
          userProfileId: vault.userProfile.id,
          target: "vault-memory",
          section: "Validation",
          key: "run-verifier-first",
          title: "Explained lesson",
          body: "Use the verifier before retrying.",
          confidence: 0.95,
          status: "active",
          sourceSessionId: "session-1",
          createdAt: now,
          updatedAt: now,
          metadata: {
            retrieval: {
              reasons: ["vault-memory", "matched tags: verifier"],
            },
            curator: {
              action: "promoted",
              reason: "high-confidence memory entry",
            },
            explainability: {
              existsBecause: "Recovered from a successful validation workflow.",
            },
          },
        });
      } finally {
        store.close();
      }

      await withFakeCommands(
        {
          docker: `
if [[ "$1" == "compose" ]]; then
  printf 'abc123'
  exit 0
fi
if [[ "$*" == *"inspect abc123"* ]]; then
  printf '[{"State":{"Running":true}}]'
  exit 0
fi
if [[ "$*" == *"successfully authenticated"* ]]; then
  exit 1
fi
if [[ "$1" == "exec" ]]; then
  exit 0
fi
exit 0
`,
        },
        async () => {
          const output = await captureStdout(async () => {
            await runCli(["status", `${project}@docker`]);
          });
          const parsed = parseJsonOutput<{ evolution?: { latestArtifacts?: Array<{ title: string; whyRetrieved?: string[]; curatorAction?: string; whyExists?: string }> } }>(output);
          assert.ok(parsed.evolution?.latestArtifacts);
          assert.ok(parsed.evolution?.latestArtifacts?.some((item) => item.title === "Explained lesson"));
          const artifact = parsed.evolution?.latestArtifacts?.find((item) => item.title === "Explained lesson");
          assert.deepEqual(artifact?.whyRetrieved, ["vault-memory", "matched tags: verifier"]);
          assert.equal(artifact?.curatorAction, "promoted");
          assert.equal(artifact?.whyExists, "Recovered from a successful validation workflow.");
        },
      );
    } finally {
      fs.rmSync(evolutionDir, { recursive: true, force: true });
    }
  });
});

test("status reports managed-key ssh metadata for github account profiles", async () => {
  const project = uniqueProjectName("ssh-status");
  await withTempVaultSpec(project, "docker", async () => {
    const profilePath = path.join(USER_ROOT, "profiles", "ssh-status-test.yaml");
    fs.writeFileSync(
      profilePath,
      yaml.dump({
        id: "ssh-status-test",
        name: "SSH Status User",
        email: "ssh-status@example.com",
        github: {
          account: "example-account",
        },
        ssh: {
          mode: "managed-key",
          comment: "ssh-status@example.com",
        },
        auth: {
          files: [
            {
              key: "codex-auth.json",
              mount_path: "/root/.codex/auth.json",
              content: "{}",
            },
            {
              key: "codex-config.toml",
              mount_path: "/root/.codex/config.toml",
              content: "model = 'gpt-5'\n",
            },
            {
              key: "claude-settings.json",
              mount_path: "/root/.claude/settings.json",
              content: "{}",
            },
          ],
        },
      }),
      "utf8",
    );
    try {
      const outputPath = vaultConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
      const doc = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as Record<string, any>;
      doc.user_profile = "ssh-status-test";
      delete doc.credentials;
      fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");

      const output = await captureStdout(async () => {
        await runCli(["status", `${project}@docker`]);
      });
      const parsed = parseJsonOutput<{
        credentials?: {
          ssh?: {
            mode?: string;
            githubAccount?: string;
            selfCheck?: { state?: string; message?: string };
          };
        };
      }>(output);
      assert.equal(parsed.credentials?.ssh?.mode, "managed-key");
      assert.equal(parsed.credentials?.ssh?.githubAccount, "example-account");
      assert.equal(parsed.credentials?.ssh?.selfCheck?.state, "warning");
      assert.match(
        parsed.credentials?.ssh?.selfCheck?.message || "",
        /not proven until the generated public key is registered/i,
      );
    } finally {
      fs.rmSync(profilePath, { force: true });
    }
  });
});

test("pod render writes a TypeScript-generated manifest", () => {
  const vault = loadDefaultDemoVault();
  const outputPath = renderAndWritePodVault(vault);
  const rendered = fs.readFileSync(outputPath, "utf8");
  assert.match(rendered, /Generated by polaris\.ts/);
  assert.match(rendered, /kind: Deployment/);
  assert.match(rendered, /mountPath: \/vault\/project/);
  assert.match(rendered, /mountPath: \/vault\/state/);
  assert.match(rendered, /mountPath: \/identity/);
  assert.doesNotMatch(rendered, /mountPath: \/ssh/);
  assert.match(rendered, /ln -sfn \/identity\/ssh \/root\/\.ssh/);
  assert.match(rendered, /ln -sfn \/identity\/codex \/root\/\.codex/);
  assert.match(rendered, /ln -sfn \/identity\/copilot \/root\/\.copilot/);
  assert.match(rendered, /ln -sfn \/identity\/pi \/root\/\.pi/);
  assert.match(rendered, /ln -sfn \/identity\/opencode\/config \/root\/\.config\/opencode/);
  assert.match(rendered, /ln -sfn \/vault\/state\/paseo \/root\/\.paseo/);
});

test("attachment model distinguishes durable vault state from ephemeral runtime state", () => {
  const vault = loadDefaultDemoVault();
  assert.deepEqual(vault.attachments.vaultRuntimeState.durablePaths, [
    "/vault/state/paseo",
    "/vault/state/paseo/evolution",
  ]);
  assert.ok(vault.attachments.ephemeralRuntime.staleArtifacts.includes("/run/vault/pids/paseo.pid"));
  assert.ok(vault.runtimeContract.minimalInvariants.some((entry) => entry.includes("user-identity-state")));
});

test("user identity attachments do not include vault-scoped paseo state", () => {
  const vault = loadDefaultDemoVault();
  assert.equal(vault.attachments.userIdentityState.durablePaths.some((entry) => entry.includes("paseo")), false);
  assert.equal(vault.attachments.vaultRuntimeState.durablePaths.some((entry) => entry.includes("paseo")), true);
});

test("attachment lifecycle semantics encode cross-vault user state and exclusive vault state", () => {
  const vault = loadDefaultDemoVault();
  assert.equal(vault.attachments.vaultData.sharing, "exclusive");
  assert.equal(vault.attachments.vaultRuntimeState.sharing, "exclusive");
  assert.equal(vault.attachments.userIdentityState.sharing, "cross-vault");
  assert.equal(vault.attachments.vaultData.scope, "vault");
  assert.equal(vault.attachments.userIdentityState.scope, "user");
});

test("direct attachment config is present in migrated saved specs", () => {
  const vault = loadDefaultDemoVault();
  assert.equal(vault.profile.name, "morpheus");
  assert.equal(vault.attachments.vaultData.source.kind, "netfs");
  assert.equal(vault.attachments.vaultRuntimeState.source.kind, "persistent-volume");
  assert.equal(vault.attachments.userIdentityState.mountRoot, "/identity");
  assert.ok(vault.attachments.userIdentityState.durablePaths.includes("/identity/ssh"));
  assert.ok(vault.attachments.userIdentityState.durablePaths.includes("/identity/copilot"));
  assert.ok(vault.attachments.userIdentityState.durablePaths.includes("/identity/opencode/config"));
  assert.ok(vault.attachments.userIdentityState.durablePaths.includes("/identity/opencode/data"));
  assert.ok(vault.attachments.userIdentityState.durablePaths.includes("/identity/pi/agent"));
  assert.ok(vault.attachments.userIdentityState.durablePaths.includes("/identity/codex-xdg/config"));
  assert.ok(vault.attachments.userIdentityState.durablePaths.includes("/identity/codex-xdg/data"));
  assert.ok(vault.attachments.userIdentityState.durablePaths.includes("/identity/codex-xdg/state"));
});

test("profile defaults drive renderer behavior instead of vault-name checks", () => {
  const vault = loadDefaultDemoVault();
  assert.equal(vault.profile.vaultAlias, "Morpheus");
  assert.equal(vault.userProfile.ssh.comment, vault.userProfile.email);
});

test("vault compatibility path derives a legacy user profile from inline git identity", async () => {
  const project = uniqueProjectName("compat-user");
  await withTempVaultSpec(project, "docker", async () => {
    const outputPath = vaultConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
    const doc = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as Record<string, any>;
    delete doc.user_profile;
    delete doc.credentials;
    doc.auth = {
      files: [
        {
          key: "codex-auth.json",
          mount_path: "/root/.codex/auth.json",
          content: "{}",
        },
        {
          key: "codex-config.toml",
          mount_path: "/root/.codex/config.toml",
          content: "model = 'gpt-5'\n",
        },
        {
          key: "claude-settings.json",
          mount_path: "/root/.claude/settings.json",
          content: "{}",
        },
      ],
    };
    doc.tooling = {
      ...(doc.tooling ?? {}),
      git_user_name: "Legacy User",
      git_user_email: "legacy@example.com",
    };
    fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");

    const vault = loadVaultFromRefForTest(`${project}@docker`);
    assert.equal(vault.userProfile.id, "legacy-legacy-example.com");
    assert.equal(vault.userProfile.name, "Legacy User");
    assert.equal(vault.userProfile.email, "legacy@example.com");
    assert.equal(vault.resolvedCredentialBindings[0]?.source, "compatibility");
    assert.equal(vault.resolvedCredentialBindings[0]?.purpose, "agent-auth");
  });
});

test("registry-backed credentials override legacy auth for the same purpose", async () => {
  const project = uniqueProjectName("credential-binding");
  const profileId = `${project}-user`;
  const profilePath = path.join(USER_ROOT, "profiles", `${profileId}.yaml`);
  const secretsRoot = path.join(USER_ROOT, profileId);
  const registryDir = path.join(USER_ROOT, "credentials", profileId);
  await withTempVaultSpec(project, "docker", async () => {
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.mkdirSync(path.join(secretsRoot, "codex"), { recursive: true });
    fs.mkdirSync(path.join(secretsRoot, "claude"), { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(secretsRoot, "codex", "auth.json"), "{\"source\":\"registry\"}\n", "utf8");
    fs.writeFileSync(path.join(secretsRoot, "codex", "config.toml"), "model = 'gpt-5'\n", "utf8");
    fs.writeFileSync(path.join(secretsRoot, "claude", "settings.json"), "{\"provider\":\"registry\"}\n", "utf8");
    fs.writeFileSync(
      profilePath,
      yaml.dump({
        id: profileId,
        name: "Credential User",
        email: "credential@example.com",
        auth: {
          files: [
            {
              key: "codex-auth.json",
              mount_path: "/root/.codex/auth.json",
              content: "{\"source\":\"legacy\"}\n",
            },
          ],
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(registryDir, "codex-default.yaml"),
      yaml.dump({
        id: "codex-default",
        userId: profileId,
        kind: "codex-auth",
        label: "Registry Codex auth",
        purposes: ["agent-auth"],
        materialRef: {
          type: "file",
          key: "user-identity-state/default",
          files: [
            {
              key: "codex-auth.json",
              source_path: "codex/auth.json",
            },
            {
              key: "codex-config.toml",
              source_path: "codex/config.toml",
            },
            {
              key: "claude-settings.json",
              source_path: "claude/settings.json",
            },
          ],
        },
        status: "ready",
      }),
      "utf8",
    );

    const outputPath = vaultConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
    const doc = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as Record<string, any>;
    doc.user_profile = profileId;
    doc.credentials = {
      bindings: [
        {
          purpose: "agent-auth",
          credential_id: "codex-default",
          required: true,
        },
      ],
    };
    fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");

    const vault = loadVaultFromRefForTest(`${project}@docker`);
    const codexAuth = vault.runtime.authFiles.find((file) => file.key === "codex-auth.json");
    assert.equal(codexAuth?.content, "{\"source\":\"registry\"}\n");
    assert.equal(vault.resolvedCredentialBindings[0]?.credential.id, "codex-default");
  }).finally(() => {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(secretsRoot, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  });
});

test("credential registry rejects cross-user ownership mismatches", async () => {
  const project = uniqueProjectName("credential-owner");
  const profileId = `${project}-user`;
  const profilePath = path.join(USER_ROOT, "profiles", `${profileId}.yaml`);
  const registryDir = path.join(USER_ROOT, "credentials", profileId);
  await withTempVaultSpec(project, "docker", async () => {
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      profilePath,
      yaml.dump({
        id: profileId,
        name: "Owner User",
        email: "owner@example.com",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(registryDir, "codex-default.yaml"),
      yaml.dump({
        id: "codex-default",
        userId: "someone-else",
        kind: "codex-auth",
        label: "Wrong owner",
        purposes: ["agent-auth"],
        materialRef: {
          type: "file",
          key: "user-identity-state/default",
          files: [
            {
              key: "codex-auth.json",
              source_path: "codex/auth.json",
            },
          ],
        },
        status: "ready",
      }),
      "utf8",
    );

    const outputPath = vaultConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
    const doc = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as Record<string, any>;
    doc.user_profile = profileId;
    doc.credentials = {
      bindings: [
        {
          purpose: "agent-auth",
          credential_id: "codex-default",
          required: true,
        },
      ],
    };
    fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");

    assert.throws(
      () => loadVaultFromRefForTest(`${project}@docker`),
      /must be owned by user/,
    );
  }).finally(() => {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  });
});

test("credential registry rejects inline secret material", async () => {
  const project = uniqueProjectName("credential-inline-secret");
  const profileId = `${project}-user`;
  const profilePath = path.join(USER_ROOT, "profiles", `${profileId}.yaml`);
  const registryDir = path.join(USER_ROOT, "credentials", profileId);
  await withTempVaultSpec(project, "docker", async () => {
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      profilePath,
      yaml.dump({
        id: profileId,
        name: "Secret User",
        email: "secret@example.com",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(registryDir, "codex-default.yaml"),
      yaml.dump({
        id: "codex-default",
        userId: profileId,
        kind: "codex-auth",
        label: "Inline secret",
        purposes: ["agent-auth"],
        materialRef: {
          type: "file",
          key: "user-identity-state/default",
          files: [
            {
              key: "codex-auth.json",
              source_path: "codex/auth.json",
              content: "{\"token\":\"inline\"}",
            },
          ],
        },
        status: "ready",
      }),
      "utf8",
    );

    const outputPath = vaultConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
    const doc = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as Record<string, any>;
    doc.user_profile = profileId;
    doc.credentials = {
      bindings: [
        {
          purpose: "agent-auth",
          credential_id: "codex-default",
          required: true,
        },
      ],
    };
    fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");

    assert.throws(
      () => loadVaultFromRefForTest(`${project}@docker`),
      /must externalize secret material/,
    );
  }).finally(() => {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  });
});

test("provided-key user profile requires staged SSH private-key material", async () => {
  const project = uniqueProjectName("provided-key");
  await withTempVaultSpec(project, "docker", async () => {
    const profilePath = path.join(USER_ROOT, "profiles", "provided-key-test.yaml");
    fs.writeFileSync(
      profilePath,
      yaml.dump({
        id: "provided-key-test",
        name: "Provided Key User",
        email: "provided@example.com",
        ssh: {
          mode: "provided-key",
          comment: "provided@polaris",
        },
      }),
      "utf8",
    );
    try {
      const outputPath = vaultConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
      const doc = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as Record<string, any>;
      doc.user_profile = "provided-key-test";
      delete doc.credentials;
      doc.auth = {
        files: [
          {
            key: "codex-auth.json",
            mount_path: "/root/.codex/auth.json",
            content: "{}",
          },
          {
            key: "codex-config.toml",
            mount_path: "/root/.codex/config.toml",
            content: "model = 'gpt-5'\n",
          },
          {
            key: "claude-settings.json",
            mount_path: "/root/.claude/settings.json",
            content: "{}",
          },
        ],
      };
      fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
      assert.throws(() => loadVaultFromRefForTest(`${project}@docker`), /provided-key/);
    } finally {
      fs.rmSync(profilePath, { force: true });
    }
  });
});

test("provided-key user profile requires matching public-key comment", async () => {
  const project = uniqueProjectName("provided-key-comment");
  await withTempVaultSpec(project, "docker", async () => {
    const profileId = "provided-key-comment-test";
    const profilePath = path.join(USER_ROOT, "profiles", `${profileId}.yaml`);
    const userRoot = path.join(USER_ROOT, profileId);
    const credentialRoot = path.join(userRoot, "credentials");
    const codexAuth = path.join(userRoot, "credentials", "codex", "auth.json");
    const codexConfig = path.join(userRoot, "credentials", "codex", "config.toml");
    const claudeSettings = path.join(userRoot, "credentials", "claude", "settings.json");
    const privateKey = path.join(userRoot, "credentials", "ssh", "github-ssh", "id_ed25519");
    const publicKey = path.join(userRoot, "credentials", "ssh", "github-ssh", "id_ed25519.pub");

    fs.mkdirSync(path.dirname(privateKey), { recursive: true });
    fs.mkdirSync(credentialRoot, { recursive: true });
    fs.mkdirSync(path.dirname(codexAuth), { recursive: true });
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.writeFileSync(
      profilePath,
      yaml.dump({
        id: profileId,
        name: "Provided Key User",
        email: "provided@example.com",
        ssh: {
          mode: "provided-key",
          comment: "expected@example.com",
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(credentialRoot, "codex-default.yaml"),
      yaml.dump({
        id: "codex-default",
        userId: profileId,
        kind: "codex-auth",
        label: "Default Codex auth",
        purposes: ["agent-auth"],
        materialRef: {
          type: "file",
          key: "user-identity-state/default",
          files: [
            {
              key: "codex-auth.json",
              source_path: "credentials/codex/auth.json",
            },
            {
              key: "codex-config.toml",
              source_path: "credentials/codex/config.toml",
            },
            {
              key: "claude-settings.json",
              source_path: "credentials/claude/settings.json",
            },
          ],
        },
        status: "ready",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(credentialRoot, "github-ssh.yaml"),
      yaml.dump({
        id: "github-ssh",
        userId: profileId,
        kind: "ssh-key",
        label: "GitHub SSH key",
        purposes: ["git-auth", "ssh-auth"],
        materialRef: {
          type: "file",
          key: "github-ssh",
          files: [
            {
              key: "id_ed25519",
              source_path: "credentials/ssh/github-ssh/id_ed25519",
            },
            {
              key: "id_ed25519.pub",
              source_path: "credentials/ssh/github-ssh/id_ed25519.pub",
            },
          ],
        },
        status: "ready",
      }),
      "utf8",
    );
    fs.writeFileSync(codexAuth, "{}\n", "utf8");
    fs.writeFileSync(codexConfig, "model = 'gpt-5'\n", "utf8");
    fs.writeFileSync(claudeSettings, "{}\n", "utf8");
    fs.writeFileSync(privateKey, "dummy-private-key\n", "utf8");
    fs.writeFileSync(publicKey, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey wrong@example.com\n", "utf8");

    try {
      const outputPath = vaultConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
      const doc = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as Record<string, any>;
      doc.user_profile = profileId;
      doc.credentials = {
        bindings: [
          {
            purpose: "agent-auth",
            credential_id: "codex-default",
            required: true,
          },
          {
            purpose: "git-auth",
            credential_id: "github-ssh",
            required: true,
          },
        ],
      };
      fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
      assert.throws(() => loadVaultFromRefForTest(`${project}@docker`), /public-key comment 'expected@example.com'/);
    } finally {
      fs.rmSync(profilePath, { force: true });
      fs.rmSync(userRoot, { recursive: true, force: true });
    }
  });
});

test("docker render keys user-scoped identity volumes by user profile id", () => {
  const vault = loadVaultFromRefForTest("demo@docker");
  const outputPath = renderAndWriteDockerVault(vault);
  const rendered = fs.readFileSync(outputPath, "utf8");
  const escapedId = vault.userProfile.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(rendered, new RegExp(`polaris-${escapedId}-identity`));
  assert.match(rendered, /external: true/);
  assert.doesNotMatch(rendered, /bootstrap-secrets/);
});

test("demo specs reuse the demo profile across docker, pod, and kubevirt backends", () => {
  const dockerVault = loadVaultFromRefForTest("demo@docker");
  const podVault = loadVaultFromRefForTest("demo@pod");
  const kubevirtVault = loadVaultFromRefForTest("demo@kubevirt-vm");

  for (const vault of [dockerVault, podVault, kubevirtVault]) {
    assert.equal(vault.identity.projectName, "demo");
    assert.equal(vault.userProfile.id, "100000000000000001");
    assert.equal(vault.userProfile.name, "Demo User");
    assert.equal(vault.userProfile.email, "demo@example.com");
    assert.equal(vault.runtime.gitUserName, "Demo User");
    assert.equal(vault.runtime.gitUserEmail, "demo@example.com");
  }

  assert.equal(
    dockerVault.attachments.vaultData.source.volumeRef,
    vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "vault-data"),
  );
  assert.equal(dockerVault.attachments.vaultData.source.kind, "netfs");
  assert.equal(podVault.attachments.vaultData.source.kind, "netfs");
  assert.equal(kubevirtVault.attachments.vaultData.source.kind, "netfs");
  assert.equal(
    podVault.attachments.vaultRuntimeState.source.volumeRef,
    vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "vault-runtime-state"),
  );
  assert.equal(
    kubevirtVault.attachments.vaultRuntimeState.source.volumeRef,
    vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "vault-runtime-state"),
  );
});

test("docker render uses stable named volumes for reusable demo attachments", () => {
  const vault = loadVaultFromRefForTest("demo@docker");
  const outputPath = renderAndWriteDockerVault(vault);
  const rendered = fs.readFileSync(outputPath, "utf8");
  const expectedVaultExport = DEMO_VAULT_EXPORT_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expectedRuntimeVolumeName = `${vaultRuntimeScopeName(
    DEMO_USER_PROFILE_ID,
    "demo",
  )}-vault-runtime-state`;
  const expectedRuntimeVolumePattern = expectedRuntimeVolumeName.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );

  assert.match(rendered, new RegExp(`source: "${expectedVaultExport}"`));
  assert.match(rendered, new RegExp(`source: ${expectedRuntimeVolumePattern}\\b`));
  assert.match(
    rendered,
    new RegExp(`${expectedRuntimeVolumePattern}:\\n    name: ${expectedRuntimeVolumePattern}`),
  );
});

test("loadVault rejects a netfs vault-data attachment without a server", () => {
  const project = uniqueProjectName("netfs-missing-server");
  const outputPath = vaultConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.copyFileSync(vaultConfigPath("demo", "docker", DEMO_USER_PROFILE_ID), outputPath);

  try {
    const doc = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as Record<string, any>;
    doc.project = project;
    delete doc.attachments["vault-data"].source.server;
    fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
    assert.throws(
      () => loadVaultFromRefForTest(`${project}@docker`),
      /vault-data netfs source requires a server/,
    );
  } finally {
    fs.rmSync(outputPath, { force: true });
  }
});

test("pod render mounts demo vault data through netfs", () => {
  const vault = loadVaultFromRefForTest("demo@pod");
  const outputPath = renderAndWritePodVault(vault);
  const rendered = fs.readFileSync(outputPath, "utf8");
  const expectedVaultExport = DEMO_VAULT_EXPORT_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.doesNotThrow(() => yaml.loadAll(rendered));

  assert.match(rendered, /- name: vault-data\n        nfs:/);
  assert.match(rendered, /server: netfs\.local/);
  assert.match(rendered, new RegExp(`path: ${expectedVaultExport}`));
});

test("kubevirt render bridges netfs vault data through a PV and PVC", () => {
  const vault = loadVaultFromRefForTest("demo@kubevirt-vm");
  const outputPath = renderAndWriteKubevirtVault(vault);
  const rendered = fs.readFileSync(outputPath, "utf8");

  assert.match(rendered, /kind: PersistentVolume/);
  assert.match(
    rendered,
    new RegExp(`name: ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "vault-data")}-pv`),
  );
  assert.match(rendered, /kind: PersistentVolumeClaim/);
  assert.match(
    rendered,
    new RegExp(`name: ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "vault-data")}`),
  );
  assert.match(rendered, /server: netfs\.local/);
  assert.match(
    rendered,
    new RegExp(
      `path: ${DEMO_VAULT_EXPORT_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ),
  );
  assert.match(rendered, new RegExp(`password: ${kubevirtProbePassword(vault)}`));
  assert.match(rendered, /mount -t virtiofs vault-runtime-state \/mnt\/polaris-shared\/vault-runtime-state/);
  assert.match(rendered, /polaris-sync-shared-state/);
  assert.match(rendered, /run_rsync_with_mount_gid/);
  assert.doesNotMatch(rendered, /BEGIN OPENSSH PRIVATE KEY/);
  assert.doesNotMatch(rendered, /authorized_keys/);
  assert.doesNotMatch(rendered, /ssh-keygen -q -t ed25519/);
});

test("docker full bootstrap installs agent tooling on plain debian images", async () => {
  const project = uniqueProjectName("docker-full");
  await withTempVaultSpec(project, "docker", async () => {
    const outputPath = vaultConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
    const doc = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as Record<string, any>;
    doc.runtime = {
      ...(doc.runtime ?? {}),
      base_image: "debian:13",
    };
    doc.tooling = {
      ...(doc.tooling ?? {}),
      bootstrap_profile: "full",
      apt_packages: ["neovim", "zsh", "tmux"],
    };
    fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");

    const vault = loadVaultFromRefForTest(`${project}@docker`);
    const rendered = fs.readFileSync(renderAndWriteDockerVault(vault), "utf8");
    assert.match(
      rendered,
      /apt-get update && apt-get install -y openssh-client ca-certificates curl git nodejs npm procps python3 ripgrep neovim zsh tmux/,
    );
    assert.match(
      rendered,
      /npm_config_cache=\/tmp\/npm-cache npm install -g --prefix \/vault\/state\/tooling\/polaris @openai\/codex @anthropic-ai\/claude-code @github\/copilot opencode-ai @earendil-works\/pi-coding-agent @fission-ai\/openspec@latest pnpm skills/,
    );
    assert.match(
      rendered,
      /npm_config_cache=\/tmp\/npm-cache npm install -g --prefix \/vault\/state\/tooling\/polaris @getpaseo\/cli@latest/,
    );
    assert.match(rendered, /exec \/vault\/state\/tooling\/polaris\/bin\/codex "\$\$@"/);
    assert.match(rendered, /exec \/vault\/state\/tooling\/polaris\/bin\/claude "\$\$@"/);
    assert.match(rendered, /PASEO_HOME=\/root\/\.paseo paseo daemon start --listen 0\.0\.0\.0:6767/);
    assert.match(rendered, /paseo daemon status --json 2>\/dev\/null \|\| true/);
  });
});

test("docker vertical bootstrap starts the Wanghai portal after Paseo", async () => {
  const project = uniqueProjectName("docker-vertical");
  const outputPath = scaffoldDockerVault(project, DEMO_USER_PROFILE_ID, {
    line: "vertical",
  });
  const vault = loadVaultFromRefForTest(`${project}@docker`);
  const renderedOutputPath = generatedOutputPath(vault);
  try {
    const rendered = fs.readFileSync(renderAndWriteDockerVault(vault), "utf8");
    assert.ok(
      vault.connectivity.servicePorts.some((port) => port.containerPort === "9090"),
    );
    assert.match(rendered, /PASEO_HOME=\/root\/\.paseo paseo daemon start --listen 0\.0\.0\.0:6767/);
    assert.match(rendered, /curl -fsS http:\/\/127\.0\.0\.1:9090\/ >/);
    assert.match(
      rendered,
      /wanghai-entrypoint pnpm --dir \/opt\/wanghai\/apps\/admin-portal run start --hostname 0\.0\.0\.0 --port 9090/,
    );
  } finally {
    fs.rmSync(path.dirname(outputPath), { recursive: true, force: true });
    fs.rmSync(renderedOutputPath, { force: true });
  }
});

test("pod backend returns structured observations", async () => {
  const vault = loadDefaultDemoVault();
  const driver = getBackendDriver("pod");
  await withFakeCommands(
    {
      kubectl: `
if [[ "$*" == *"get deployment ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '{"metadata":{"name":"${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$*" == *"paseo daemon status --json"* ]]; then
  printf '{"serverId":"srv_demo","localDaemon":"running","connectedDaemon":"reachable"}'
  exit 0
fi
if [[ "$*" == *"paseo daemon pair --json"* ]]; then
  printf '{"url":"https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kZW1vIn0"}'
  exit 0
fi
if [[ "$*" == *"cat /root/.paseo/server-id"* ]]; then
  printf 'srv_demo'
  exit 0
fi
if [[ "$*" == *"cat /root/.paseo/pairing.json"* ]]; then
  printf '{"url":"https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kZW1vIn0"}'
  exit 0
fi
if [[ "$1" == "-n" && "$4" == "exec" ]] || [[ "$*" == *" exec "* ]]; then
  exit 0
fi
if [[ "$*" == *"get svc ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}'
  exit 0
fi
exit 0
`,
    },
    async () => {
      const observation = await driver.inspect(vault);
      assert.equal(observation.backend.kind, "pod");
      assert.ok("vaultData" in observation.attachments);
      assert.ok("projectRoot" in observation.vaultAssembly);
      assert.ok("manager" in observation.daemon);
    },
  );
});

test("runtime controller computes degraded status and reconcile plan from observations when daemon is missing", async () => {
  cleanupDriverSelectionState("demo");
  const vault = {
    ...loadDefaultDemoVault(),
    backend: {
      kind: "pod",
      profile: "gvisor",
    },
    agent: {
      ...loadDefaultDemoVault().agent,
      pairingFile: "/root/.paseo/pairing.json",
    },
  };
  const driver = getBackendDriver("pod");

  await withFakeCommands(
    {
      kubectl: `
if [[ "$*" == *"get deployment ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '{"metadata":{"name":"${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$*" == *"test -f /tmp/.ready && test -f /root/.paseo/pairing.json"* ]]; then
  exit 1
fi
if [[ "$1" == "-n" && "$4" == "exec" ]] || [[ "$*" == *" exec "* ]]; then
  exit 0
fi
if [[ "$*" == *"get svc ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}'
  exit 0
fi
exit 0
`,
    },
    async () => {
      const observation = await driver.inspect(vault);
      const drift = computeVaultDrift(vault, observation);
      const status = synthesizeVaultStatus(vault, observation, drift);
      const plan = buildReconcilePlan(vault, drift);

      assert.equal(status.driver?.selected?.backend, "pod");
      assert.equal(status.driver?.status, "running");
      assert.equal(status.paseo.daemon, "unknown");
      assert.equal(status.paseo.web, "unavailable");
      assert.match(status.driver?.reason || "", /vault manager assembly missing|missing|service/i);
      assert.ok(plan.actions.length >= 1);
      assert.ok(plan.actions.some((action) => action.kind === "restart-runtime"));
      assert.equal(plan.requiresRestart, true);
    },
  );
  cleanupDriverSelectionState("demo");
});

test("status includes the daemon pairing URL when the runtime exposes one", async () => {
  cleanupDriverSelectionState("demo");
  cleanupStatusFile("demo");

  await withFakeCommands(
    {
      kubectl: `
if [[ "$*" == *"get deployment ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '{"metadata":{"name":"${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$*" == *"paseo daemon status --json"* ]]; then
  printf '{"serverId":"srv_demo","localDaemon":"running","connectedDaemon":"reachable"}'
  exit 0
fi
if [[ "$*" == *"paseo daemon pair --json"* ]]; then
  printf '{"url":"https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kZW1vIn0"}'
  exit 0
fi
if [[ "$*" == *"cat /root/.paseo/server-id"* ]]; then
  printf 'srv_demo'
  exit 0
fi
if [[ "$*" == *"cat /root/.paseo/pairing.json"* ]]; then
  printf '{"url":"https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kZW1vIn0"}'
  exit 0
fi
if [[ "$1" == "-n" && "$4" == "exec" ]] || [[ "$*" == *" exec "* ]]; then
  exit 0
fi
if [[ "$*" == *"get svc ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}'
  exit 0
fi
exit 0
`,
    },
    async () => {
      const output = await captureStdout(async () => {
        await runCli(["status", "demo@pod"]);
      });
      const parsed = parseJsonOutput<{
        paseo?: { liveTarget?: string | null };
      }>(output);
      assert.equal(parsed.paseo?.liveTarget, "https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kZW1vIn0");
    },
  );
});

test("kubevirt status succeeds when runtime state exposes daemon pairing metadata", async () => {
  const project = uniqueProjectName("vm-pair-url");
  await withTempVaultSpec(project, "kubevirt-vm", async () => {
    await withFakeCommands(
      {
        kubectl: `
if [[ "$*" == *"get vm ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf '${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}'
  exit 0
fi
if [[ "$*" == *"get vmi ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf 'Running'
  exit 0
fi
if [[ "$*" == *"get svc ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf '${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}'
  exit 0
fi
if [[ "$*" == *"get secret ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm-cloudinit")}"* ]]; then
  printf '${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm-cloudinit")}'
  exit 0
fi
if [[ "$*" == *"port-forward svc/${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* && "$*" == *":22"* ]]; then
  printf 'Forwarding from 127.0.0.1:40022 -> 22\n'
  exit 0
fi
if [[ "$*" == *"logs"* ]]; then
  exit 0
fi
exit 0
`,
        sshpass: `
if [[ "$*" == *"guestReachable=1"* ]]; then
  printf 'guestReachable=1\n'
  printf 'daemonStatusRaw<<EOF\n{"serverId":"srv_vmtest","localDaemon":"running","connectedDaemon":"reachable"}\nEOF\n'
  printf 'persistedServerId<<EOF\nsrv_vmtest\nEOF\n'
  printf 'pairingRaw<<EOF\n{"url":"https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl92bXRlc3QifQ"}\nEOF\n'
  printf 'vaultDataObserved=1\nvaultRuntimeObserved=1\nuserIdentityObserved=1\nuserSshObserved=1\nhomeObserved=1\nprojectRootObserved=1\nmanagerStateObserved=1\nevolutionStateObserved=1\ncodexObserved=1\nclaudeObserved=1\nsshObserved=1\n'
  exit 0
fi
exit 1
`,
      },
      async () => {
        const output = await captureStdout(async () => {
          await runCli(["status", `${project}@kubevirt-vm`]);
        });
      const parsed = parseJsonOutput<{
        driver?: {
          selected?: { backend?: string };
          runtimeRef?: string;
          status?: string;
        };
        paseo?: { daemon?: string; web?: string };
      }>(output);
      assert.equal(parsed.driver?.selected?.backend, "kubevirt-vm");
      assert.equal(parsed.driver?.runtimeRef, `vm/${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}`);
      assert.equal(parsed.driver?.status, "running");
        assert.equal(parsed.paseo?.daemon, "pending");
        assert.equal(parsed.paseo?.web, "pairing-required");
      },
    );
  });
});

test("kubevirt render reuses persisted daemon pairing metadata", async () => {
  const project = uniqueProjectName("vm-pair-bootstrap");
  await withTempVaultSpec(project, "kubevirt-vm", async () => {
    const vault = loadVaultFromRefForTest(`${project}@kubevirt-vm`);
    const rendered = renderKubevirtVault(vault);
    assert.doesNotMatch(rendered, /paseo daemon pair --json/);
    assert.match(rendered, /test -f \/root\/\.paseo\/pairing\.json/);
  });
});

test("CLI status defaults to the status command and persists ready pod status", async () => {
  cleanupDriverSelectionState("demo");
  cleanupStatusFile("demo");
  const expectedStatusFile = vaultStatusPath("demo", DEMO_USER_PROFILE_ID);

  await withFakeCommands(
    {
      kubectl: `
if [[ "$*" == *"get deployment ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '{"metadata":{"name":"${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$*" == *"paseo daemon status --json"* ]]; then
  printf '{"serverId":"srv_demo","localDaemon":"running","connectedDaemon":"reachable"}'
  exit 0
fi
if [[ "$*" == *"paseo daemon pair --json"* ]]; then
  printf '{"url":"https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kZW1vIn0"}'
  exit 0
fi
if [[ "$*" == *"cat /root/.paseo/server-id"* ]]; then
  printf 'srv_demo'
  exit 0
fi
if [[ "$*" == *"cat /root/.paseo/pairing.json"* ]]; then
  printf '{"url":"https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kZW1vIn0"}'
  exit 0
fi
if [[ "$1" == "-n" && "$4" == "exec" ]] || [[ "$*" == *" exec "* ]]; then
  exit 0
fi
if [[ "$*" == *"get svc ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}'
  exit 0
fi
exit 0
`,
    },
    async () => {
      await captureStdout(async () => {
        await runCli(["demo"]);
      });

      assert.equal(fs.existsSync(expectedStatusFile), true);
      const parsed = JSON.parse(fs.readFileSync(expectedStatusFile, "utf8")) as {
        project: string;
        driver?: {
          selected?: {
            backend: string;
            profile?: string;
          };
          status?: string;
          baseImage: string;
          runtimeKind: string;
          runtimeRef: string;
        };
        paseo: { daemon: string; web: string };
        evolution?: { artifactCount: number };
      };

      assert.equal(parsed.project, "demo");
      assert.equal(parsed.driver?.selected?.backend, "pod");
      assert.equal(parsed.driver?.selected?.profile, "gvisor");
      assert.equal(parsed.driver?.runtimeKind, "kubernetes-pod");
      assert.equal(parsed.driver?.runtimeRef, "pod/pod-1");
      assert.equal(parsed.driver?.baseImage, vaultImageRef(DEMO_USER_PROFILE_ID, "demo"));
      assert.equal(parsed.driver?.status, "running");
      assert.equal(parsed.paseo.daemon, "pending");
      assert.equal(parsed.paseo.web, "pairing-required");
      assert.ok(parsed.evolution);
    },
  );

  cleanupStatusFile("demo");
  cleanupDriverSelectionState("demo");
});

test("status stays not-ready when no active codex credential is selected and persisted Paseo metadata is missing", () => {
  const base = loadDefaultDemoVault();
  const paseoStateRoot = vaultPaseoStateDir(
    base.identity.projectName,
    base.userProfile.id,
  );
  fs.rmSync(paseoStateRoot, { recursive: true, force: true });
  const vault = {
    ...base,
    credentialBindings: base.credentialBindings.filter((binding) => binding.purpose !== "agent-auth"),
    resolvedCredentialBindings: base.resolvedCredentialBindings.filter((binding) => binding.purpose !== "agent-auth"),
    runtime: {
      ...base.runtime,
      authFiles: base.runtime.authFiles.filter((entry) =>
        !entry.mountPath.startsWith(`${base.runtime.home}/.codex/`)
        && !entry.mountPath.startsWith(`${base.runtime.home}/.claude/`)
      ),
    },
  };
  const observation = {
    backend: {
      kind: vault.backend.kind,
      exists: true,
      running: true,
      detail: "pod/pod-1",
    },
    attachments: {
      vaultData: { observed: true, detail: vault.attachments.vaultData.mountRoot },
      vaultRuntimeState: { observed: true, detail: vault.attachments.vaultRuntimeState.mountRoot },
      userIdentityState: { observed: true, detail: vault.attachments.userIdentityState.mountRoot },
    },
    vaultAssembly: {
      home: { observed: true, detail: vault.runtime.home },
      projectRoot: { observed: true, detail: `${vault.runtime.home}/vault` },
      managerState: { observed: true, detail: vault.agent.runtime.stateRoot },
      evolutionState: { observed: true, detail: vault.agent.runtime.evolutionRoot },
      codex: { observed: false, detail: `${vault.runtime.home}/.codex` },
      claude: { observed: false, detail: `${vault.runtime.home}/.claude` },
      ssh: { observed: true, detail: `${vault.runtime.home}/.ssh` },
    },
    daemon: {
      manager: { observed: true, detail: vault.agent.runtime.readyFile ?? "/tmp/.ready" },
      pairing: {
        observed: true,
        detail: "paseo daemon pair",
        url: "https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kZW1vIn0",
      },
    },
    services: {
      declared: 1,
      observed: 1,
      detail: "observed 1 service objects",
    },
  };

  const drift = computeVaultDrift(vault, observation);
  const status = synthesizeVaultStatus(vault, observation, drift);

  assert.equal(drift.hasWarnings, true);
  assert.match(
    drift.items.map((item) => item.message).join("\n"),
    /persisted Paseo (server-id|pairing metadata) is missing/,
  );
  assert.equal(status.driver?.status, "running");
  assert.equal(status.paseo.daemon, "unknown");
  assert.equal(status.paseo.web, "unavailable");
  assert.equal(status.credentials?.codex?.state, "not-selected");
  assert.equal(status.vaultAssembly?.codex?.state, "unknown");
});

test("status is not ready until persisted Paseo metadata exists on the host state root", () => {
  const vault = loadDefaultDemoVault();
  const paseoStateRoot = vaultPaseoStateDir(
    vault.identity.projectName,
    vault.userProfile.id,
  );
  fs.rmSync(paseoStateRoot, { recursive: true, force: true });

  const observation = {
    backend: {
      kind: vault.backend.kind,
      exists: true,
      running: true,
      detail: "pod/pod-1",
    },
    attachments: {
      vaultData: { observed: true, detail: vault.attachments.vaultData.mountRoot },
      vaultRuntimeState: { observed: true, detail: vault.attachments.vaultRuntimeState.mountRoot },
      userIdentityState: { observed: true, detail: vault.attachments.userIdentityState.mountRoot },
    },
    vaultAssembly: {
      home: { observed: true, detail: vault.runtime.home },
      projectRoot: { observed: true, detail: `${vault.runtime.home}/vault` },
      managerState: { observed: true, detail: vault.agent.runtime.stateRoot },
      evolutionState: { observed: true, detail: vault.agent.runtime.evolutionRoot },
      codex: { observed: true, detail: `${vault.runtime.home}/.codex` },
      claude: { observed: true, detail: `${vault.runtime.home}/.claude` },
      ssh: { observed: true, detail: `${vault.runtime.home}/.ssh` },
    },
    daemon: {
      manager: { observed: true, detail: vault.agent.runtime.readyFile ?? "/tmp/.ready" },
      pairing: {
        observed: true,
        detail: "paseo daemon pair",
        url: "https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kZW1vIn0",
      },
    },
    services: {
      declared: 1,
      observed: 1,
      detail: "observed 1 service objects",
    },
  };

  const drift = computeVaultDrift(vault, observation);
  const status = synthesizeVaultStatus(vault, observation, drift);

  assert.equal(drift.hasWarnings, true);
  assert.match(
    drift.items.map((item) => item.message).join("\n"),
    /persisted Paseo (server-id|pairing metadata) is missing/,
  );
  assert.equal(status.driver?.status, "running");
  assert.equal(status.paseo.daemon, "unknown");
  assert.equal(status.paseo.web, "unavailable");
});

test("status exposes live credential selections per harness", async () => {
  const project = uniqueProjectName("status-live-selections");
  const credentialRoot = path.join(
    REPO_ROOT,
    "config",
    "users",
    DEMO_USER_PROFILE_ID,
    "credentials",
  );

  await withTempVaultSpec(project, "docker", async () => {
    try {
      await runCli([
        "user",
        "credential",
        "add",
        DEMO_USER_PROFILE_ID,
        "--harness",
        "claude",
        "--credential-id",
        "claude-status-live",
        "--label",
        "Claude Status Live",
        "--provider-name",
        "anthropic",
        "--api-key",
        "claude-status-secret",
      ]);
      writeVaultLiveCredentialSelection(
        project,
        "claude",
        "claude-status-live",
        DEMO_USER_PROFILE_ID,
      );

      const vault = loadVaultFromRefForTest(`${project}@docker`);
      const observation = {
        backend: {
          kind: vault.backend.kind,
          exists: true,
          running: true,
          detail: "container/docker-status-live",
        },
        attachments: {
          vaultData: { observed: true, detail: vault.attachments.vaultData.mountRoot },
          vaultRuntimeState: { observed: true, detail: vault.attachments.vaultRuntimeState.mountRoot },
          userIdentityState: { observed: true, detail: vault.attachments.userIdentityState.mountRoot },
        },
        vaultAssembly: {
          home: { observed: true, detail: vault.runtime.home },
          projectRoot: { observed: true, detail: `${vault.runtime.home}/vault` },
          managerState: { observed: true, detail: vault.agent.runtime.stateRoot },
          evolutionState: { observed: true, detail: vault.agent.runtime.evolutionRoot },
          codex: { observed: true, detail: `${vault.runtime.home}/.codex` },
          claude: { observed: true, detail: `${vault.runtime.home}/.claude` },
          ssh: { observed: true, detail: `${vault.runtime.home}/.ssh` },
        },
        daemon: {
          manager: { observed: true, detail: vault.agent.runtime.readyFile ?? "/tmp/.ready" },
          pairing: {
            observed: true,
            detail: "paseo daemon pair",
            url: "https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kZW1vIn0",
          },
        },
        services: {
          declared: 1,
          observed: 1,
          detail: "observed 1 service objects",
        },
      };

      const drift = computeVaultDrift(vault, observation);
      const status = synthesizeVaultStatus(vault, observation, drift);
      const switchableHarnesses = new Set(status.credentials?.live?.switchableHarnesses ?? []);

      assert.equal(status.credentials?.live?.selectedByHarness?.claude?.credentialId, "claude-status-live");
      assert.equal(status.credentials?.live?.selectedByHarness?.claude?.source, "runtime-state");
      assert.equal(status.credentials?.live?.selectedByHarness?.ssh?.credentialId, "github-ssh");
      assert.ok(Boolean(status.credentials?.live?.selectedByHarness?.codex?.credentialId));
      assert.equal(switchableHarnesses.has("ssh"), true);
      assert.equal(switchableHarnesses.has("codex"), true);
      assert.equal(switchableHarnesses.has("claude"), true);
    } finally {
      fs.rmSync(path.join(credentialRoot, "claude", "claude-status-live"), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(credentialRoot, "claude-status-live.yaml"), {
        force: true,
      });
      cleanupLiveCredentialsFile(project);
    }
  });
});

test("CLI logs for pod backend prefers the active pod and falls back to deployment when needed", async () => {
  cleanupDriverSelectionState("demo");
  await withFakeCommands(
    {
      kubectl: `
if [[ "$*" == *"get pod -l app=demo"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$*" == *"logs pod-1 --tail=200"* ]]; then
  printf 'pod logs'
  exit 0
fi
exit 0
`,
    },
    async ({ readCommandLog }) => {
      await runCli(["logs", "demo"]);
      const commands = readCommandLog();
      assert.ok(commands.some((entry) => entry.includes("get pod -l app=demo")));
      assert.ok(commands.some((entry) => entry.includes("logs pod-1 --tail=200")));
      assert.equal(commands.some((entry) => entry.includes("logs deployment/demo --tail=200")), false);
    },
  );

  await withFakeCommands(
    {
      kubectl: `
if [[ "$*" == *"get pod -l app=demo"* ]]; then
  exit 0
fi
if [[ "$*" == *"logs deployment/demo --tail=200"* ]]; then
  printf 'deployment logs'
  exit 0
fi
exit 0
`,
    },
    async ({ readCommandLog }) => {
      await runCli(["logs", "demo"]);
      const commands = readCommandLog();
      assert.ok(commands.some((entry) => entry.includes("logs deployment/demo --tail=200")));
    },
  );
  cleanupDriverSelectionState("demo");
});

test("CLI docker lifecycle commands dispatch through compose and status artifacts", async () => {
  const project = uniqueProjectName("docker-lifecycle");
  const previousExportRoot = process.env.POLARIS_NETFS_LOCAL_EXPORT_ROOT;
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-cli-lifecycle-"));
  await withTempVaultSpec(project, "docker", async () => {
    const dockerPath = vaultConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
    const doc = (yaml.load(fs.readFileSync(dockerPath, "utf8")) ?? {}) as Record<string, any>;
    doc.attachments["vault-data"].source.export_path = exportRoot;
    fs.writeFileSync(dockerPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
    try {
      process.env.POLARIS_NETFS_LOCAL_EXPORT_ROOT = exportRoot;
      await withFakeCommands(
        {
        docker: `
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf 'abc123'
  exit 0
fi
if [[ "$*" == *"inspect abc123"* ]]; then
  printf '[{"State":{"Running":true}}]'
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  if [[ "$*" == *"paseo daemon status --json"* ]]; then
    printf '{"serverId":"srv_docker","localDaemon":"running","connectedDaemon":"reachable"}'
    exit 0
  fi
  if [[ "$*" == *"cat /root/.paseo/server-id"* ]]; then
    printf 'srv_docker'
    exit 0
  fi
  if [[ "$*" == *"cat /root/.paseo/pairing.json"* ]]; then
    printf '{"url":"https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kb2NrZXIifQ","serverId":"srv_docker"}'
    exit 0
  fi
  exit 0
fi
exit 0
`,
        },
        async ({ readCommandLog }) => {
          await runCli(["render", project]);
          await runCli(["apply", project]);
          await runCli(["start", project]);
          await runCli(["restart", project]);
          await runCli(["stop", project]);
          await runCli(["rebuild", project]);
          const reconcileOutput = await captureStdout(async () => {
            await runCli(["reconcile", project]);
          });

          const commands = readCommandLog();
          assert.ok(commands.some((entry) => entry.includes(`/vaults/${project}/generated/docker.yaml`) && entry.includes("up -d")));
          assert.ok(commands.some((entry) => entry.includes(`/vaults/${project}/generated/docker.yaml`) && entry.includes("stop")));
          assert.ok(commands.some((entry) => entry.includes(`/vaults/${project}/generated/docker.yaml`) && entry.includes("restart")));
          assert.ok(commands.some((entry) => entry.includes(`/vaults/${project}/generated/docker.yaml`) && entry.includes("up -d --force-recreate")));

          const parsed = parseJsonOutput<{ reconcilePlan: { actions: Array<{ kind: string }>; safe: boolean } }>(reconcileOutput);
          assert.ok(Array.isArray(parsed.reconcilePlan.actions));
          assert.equal(parsed.reconcilePlan.safe, true);
        },
      );
    } finally {
      if (previousExportRoot === undefined) {
        delete process.env.POLARIS_NETFS_LOCAL_EXPORT_ROOT;
      } else {
        process.env.POLARIS_NETFS_LOCAL_EXPORT_ROOT = previousExportRoot;
      }
      fs.rmSync(exportRoot, { recursive: true, force: true });
    }
  });
});

test("switch migrates only small durable attachments when vault-data is netfs", async () => {
  const project = uniqueProjectName("switch-netfs");
  const dockerStateFile = path.join(os.tmpdir(), `${project}-docker.state`);
  cleanupDriverSelectionState(project);

  await withTempVaultSpec(project, "docker", async () => {
    const podPath = vaultConfigPath(project, "pod", DEMO_USER_PROFILE_ID);
    try {
      ensureVaultConfig(`${project}@pod:gvisor`);
      writeVaultDriverSelection(
        project,
        { backend: "docker" },
        DEMO_USER_PROFILE_ID,
      );

      await withFakeCommands(
        {
          docker: `
state_file=${JSON.stringify(dockerStateFile)}
if [[ ! -f "$state_file" ]]; then
  printf 'running\n' > "$state_file"
fi
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  if [[ "$(cat "$state_file")" == "running" ]]; then
    printf 'docker-id'
  fi
  exit 0
fi
if [[ "$*" == *"inspect docker-id"* ]]; then
  if [[ "$(cat "$state_file")" == "running" ]]; then
    printf '[{"State":{"Running":true}}]'
  else
    printf '[{"State":{"Running":false}}]'
  fi
  exit 0
fi
if [[ "$1" == "exec" || "$1" == "cp" ]]; then
  exit 0
fi
if [[ "$*" == *" stop"* ]]; then
  printf 'stopped\n' > "$state_file"
  exit 0
fi
exit 0
`,
          kubectl: `
if [[ "$*" == *"apply -f "* ]]; then
  exit 0
fi
if [[ "$*" == *"get deployment ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf '{"metadata":{"name":"${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$*" == *"get svc ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf '${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}'
  exit 0
fi
if [[ "$*" == *"paseo daemon status --json"* ]]; then
  printf '{"serverId":"srv_switch","localDaemon":"running","connectedDaemon":"reachable"}'
  exit 0
fi
if [[ "$*" == *"cat /root/.paseo/server-id"* ]]; then
  printf 'srv_switch'
  exit 0
fi
if [[ "$*" == *"cat /root/.paseo/pairing.json"* ]]; then
  printf '{"url":"https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9zd2l0Y2gifQ"}'
  exit 0
fi
if [[ "$1" == "-n" && ( "$3" == "exec" || "$3" == "cp" ) ]] || [[ "$1" == "exec" ]] || [[ "$1" == "cp" ]]; then
  exit 0
fi
if [[ "$*" == *"rollout restart"* ]]; then
  exit 0
fi
if [[ "$*" == *"scale deployment ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)} --replicas=0"* ]]; then
  exit 0
fi
exit 0
`,
        },
        async ({ readCommandLog }) => {
          await captureStdout(async () => {
            await runCli(["switch", `${project}@pod`]);
          });

          const commands = readCommandLog();
          assert.ok(commands.some((entry) => entry.includes("cp docker-id:/vault/state/paseo/.")));
          assert.ok(commands.some((entry) => entry.includes("cp docker-id:/identity/codex/.")));
          assert.ok(commands.some((entry) => entry.includes("cp docker-id:/identity/claude/.")));
          assert.ok(commands.some((entry) => entry.includes("cp docker-id:/identity/ssh/.")));
          assert.equal(
            commands.some((entry) => entry.includes("/vault/project/.")),
            false,
          );
        },
      );
    } finally {
      cleanupDriverSelectionState(project);
      fs.rmSync(podPath, { force: true });
      fs.rmSync(dockerStateFile, { force: true });
    }
  });
});

test("switch exports durable state from the actually running backend when selection is stale", async () => {
  const project = uniqueProjectName("switch-stale-selection");
  const dockerStateFile = path.join(os.tmpdir(), `${project}-docker.state`);
  cleanupDriverSelectionState(project);

  await withTempVaultSpec(project, "docker", async () => {
    const podPath = vaultConfigPath(project, "pod", DEMO_USER_PROFILE_ID);
    const vmPath = vaultConfigPath(project, "kubevirt-vm", DEMO_USER_PROFILE_ID);
    try {
      ensureVaultConfig(`${project}@pod:gvisor`);
      ensureVaultConfig(`${project}@kubevirt-vm`);
      writeVaultDriverSelection(
        project,
        { backend: "kubevirt-vm" },
        DEMO_USER_PROFILE_ID,
      );

      await withFakeCommands(
        {
          docker: `
state_file=${JSON.stringify(dockerStateFile)}
if [[ ! -f "$state_file" ]]; then
  printf 'running\n' > "$state_file"
fi
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  if [[ "$(cat "$state_file")" == "running" ]]; then
    printf 'docker-id'
  fi
  exit 0
fi
if [[ "$*" == *"inspect docker-id"* ]]; then
  if [[ "$(cat "$state_file")" == "running" ]]; then
    printf '[{"State":{"Running":true}}]'
  else
    printf '[{"State":{"Running":false}}]'
  fi
  exit 0
fi
if [[ "$1" == "exec" || "$1" == "cp" ]]; then
  exit 0
fi
if [[ "$*" == *" stop"* ]]; then
  printf 'stopped\n' > "$state_file"
  exit 0
fi
exit 0
`,
          kubectl: `
if [[ "$*" == *"get vm ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf '${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}'
  exit 0
fi
if [[ "$*" == *"get vmi ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf 'Succeeded'
  exit 0
fi
if [[ "$*" == *"apply -f "* ]]; then
  exit 0
fi
if [[ "$*" == *"get deployment ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf '{"metadata":{"name":"${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$*" == *"get svc ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf '${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}'
  exit 0
fi
if [[ "$*" == *"paseo daemon status --json"* ]]; then
  printf '{"serverId":"srv_switch","localDaemon":"running","connectedDaemon":"reachable"}'
  exit 0
fi
if [[ "$*" == *"cat /root/.paseo/server-id"* ]]; then
  printf 'srv_switch'
  exit 0
fi
if [[ "$*" == *"cat /root/.paseo/pairing.json"* ]]; then
  printf '{"url":"https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9zd2l0Y2gifQ"}'
  exit 0
fi
if [[ "$1" == "-n" && ( "$3" == "exec" || "$3" == "cp" ) ]] || [[ "$1" == "exec" ]] || [[ "$1" == "cp" ]]; then
  exit 0
fi
if [[ "$*" == *"rollout restart"* ]]; then
  exit 0
fi
if [[ "$*" == *"scale deployment ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)} --replicas=0"* ]]; then
  exit 0
fi
exit 0
`,
        },
        async ({ readCommandLog }) => {
          await captureStdout(async () => {
            await runCli(["switch", `${project}@pod`]);
          });

          const commands = readCommandLog();
          assert.ok(commands.some((entry) => entry.includes("cp docker-id:/vault/state/paseo/.")));
          assert.ok(commands.some((entry) => entry.includes("cp docker-id:/identity/codex/.")));
          assert.ok(commands.some((entry) => entry.includes("cp docker-id:/identity/claude/.")));
          assert.ok(commands.some((entry) => entry.includes("cp docker-id:/identity/ssh/.")));
        },
      );
    } finally {
      cleanupDriverSelectionState(project);
      fs.rmSync(podPath, { force: true });
      fs.rmSync(vmPath, { force: true });
      fs.rmSync(dockerStateFile, { force: true });
    }
  });
});

test("switch imports runtime state into kubevirt before first boot without a restart sync-out", async () => {
  const project = uniqueProjectName("switch-vm-serverid");
  const dockerStateFile = path.join(os.tmpdir(), `${project}-docker.state`);
  cleanupDriverSelectionState(project);

  await withTempVaultSpec(project, "docker", async () => {
    const vmPath = vaultConfigPath(project, "kubevirt-vm", DEMO_USER_PROFILE_ID);
    try {
      ensureVaultConfig(`${project}@kubevirt-vm`);
      writeVaultDriverSelection(
        project,
        { backend: "docker" },
        DEMO_USER_PROFILE_ID,
      );

      await withFakeCommands(
        {
          docker: `
state_file=${JSON.stringify(dockerStateFile)}
if [[ ! -f "$state_file" ]]; then
  printf 'running\n' > "$state_file"
fi
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  if [[ "$(cat "$state_file")" == "running" ]]; then
    printf 'docker-id'
  fi
  exit 0
fi
if [[ "$*" == *"inspect docker-id"* ]]; then
  if [[ "$(cat "$state_file")" == "running" ]]; then
    printf '[{"State":{"Running":true}}]'
  else
    printf '[{"State":{"Running":false}}]'
  fi
  exit 0
fi
if [[ "$1" == "exec" || "$1" == "cp" ]]; then
  exit 0
fi
if [[ "$*" == *" stop"* ]]; then
  printf 'stopped\n' > "$state_file"
  exit 0
fi
exit 0
`,
          kubectl: `
if [[ "$*" == *"apply -f "* ]]; then
  exit 0
fi
if [[ "$*" == *"wait --for=condition=Ready pod/${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-import")}"* ]]; then
  exit 0
fi
if [[ "$*" == *"delete pod ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-import")}"* ]]; then
  exit 0
fi
if [[ "$*" == *"wait --for=delete pod/${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-import")}"* ]]; then
  exit 0
fi
if [[ "$*" == *"get vm ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf '${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}'
  exit 0
fi
if [[ "$*" == *"get vmi ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf 'Running'
  exit 0
fi
if [[ "$*" == *"get svc ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf '${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}'
  exit 0
fi
if [[ "$*" == *"get secret ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm-cloudinit")}"* ]]; then
  printf '${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm-cloudinit")}'
  exit 0
fi
if [[ "$*" == *"port-forward svc/${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* && "$*" == *":22"* ]]; then
  printf 'Forwarding from 127.0.0.1:40022 -> 22\n'
  exit 0
fi
if [[ "$*" == *"patch vm ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  exit 0
fi
if [[ "$1" == "-n" && ( "$3" == "exec" || "$3" == "cp" ) ]] || [[ "$1" == "exec" ]] || [[ "$1" == "cp" ]]; then
  exit 0
fi
exit 0
`,
          sshpass: `
if [[ "$*" == *"guestReachable=1"* ]]; then
  printf 'guestReachable=1\n'
  printf 'daemonStatusRaw<<EOF\n{"serverId":"srv_switch","localDaemon":"running","connectedDaemon":"reachable"}\nEOF\n'
  printf 'persistedServerId<<EOF\nsrv_switch\nEOF\n'
  printf 'pairingRaw<<EOF\n{"url":"https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9zd2l0Y2gifQ"}\nEOF\n'
  printf 'vaultDataObserved=1\nvaultRuntimeObserved=1\nuserIdentityObserved=1\nuserSshObserved=1\nhomeObserved=1\nprojectRootObserved=1\nmanagerStateObserved=1\nevolutionStateObserved=1\ncodexObserved=1\nclaudeObserved=1\nsshObserved=1\n'
  exit 0
fi
if [[ "$*" == *"test -s "* && "$*" == *"server-id"* && "$*" == *"grep -q"* ]]; then
  exit 0
fi
if [[ "$*" == *"set -euo pipefail"* && "$*" == *"\ntrue"* ]]; then
  exit 0
fi
if [[ "$*" == *"systemctl restart polaris-runtime-bootstrap.service"* ]]; then
  printf 'active\n'
  exit 0
fi
exit 1
`,
        },
        async ({ readCommandLog }) => {
          await captureStdout(async () => {
            await runCli(["switch", `${project}@kubevirt-vm`]);
          });

          const commands = readCommandLog();
          const pvcImportCopyIndex = commands.findIndex((entry) =>
            entry.includes(`cp /tmp/`) === false
              ? entry.includes(`cp`) && entry.includes(`${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-import")}:/root/.paseo`)
              : false,
          );
          const generatedApplyIndex = commands.findIndex((entry) =>
            entry.includes(`/vaults/${project}/generated/kubevirt.yaml`) && entry.includes("apply -f"),
          );
          assert.equal(
            commands.some((entry) => entry.includes(`patch vm ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}`) && entry.includes(`"runStrategy":"Halted"`)),
            false,
          );
          assert.ok(
            commands.some((entry) => entry.includes(vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-import")) && entry.includes("cp")),
          );
          assert.ok(
            commands.some((entry) => entry.includes(`delete pod ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-import")} --ignore-not-found --wait=false`)),
          );
          assert.ok(generatedApplyIndex >= 0);
          const firstPvcImportCommand = commands.findIndex((entry) =>
            entry.includes(vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-import")) && entry.includes("cp"),
          );
          assert.ok(firstPvcImportCommand >= 0);
          assert.ok(firstPvcImportCommand < generatedApplyIndex);
          void pvcImportCopyIndex;
        },
      );
    } finally {
      cleanupDriverSelectionState(project);
      fs.rmSync(vmPath, { force: true });
      fs.rmSync(dockerStateFile, { force: true });
    }
  });
});

test("switch keeps the previous selection when the target backend start fails", async () => {
  const project = uniqueProjectName("switch-selection-failure");
  const dockerStateFile = path.join(os.tmpdir(), `${project}-docker.state`);
  cleanupDriverSelectionState(project);

  await withTempVaultSpec(project, "docker", async () => {
    const podPath = vaultConfigPath(project, "pod", DEMO_USER_PROFILE_ID);
    try {
      ensureVaultConfig(`${project}@pod`);
      writeVaultDriverSelection(
        project,
        { backend: "docker" },
        DEMO_USER_PROFILE_ID,
      );

      await withFakeCommands(
        {
          docker: `
state_file=${JSON.stringify(dockerStateFile)}
if [[ ! -f "$state_file" ]]; then
  printf 'running\n' > "$state_file"
fi
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  if [[ "$(cat "$state_file")" == "running" ]]; then
    printf 'docker-id'
  fi
  exit 0
fi
if [[ "$*" == *"inspect docker-id"* ]]; then
  if [[ "$(cat "$state_file")" == "running" ]]; then
    printf '[{"State":{"Running":true}}]'
  else
    printf '[{"State":{"Running":false}}]'
  fi
  exit 0
fi
if [[ "$1" == "exec" || "$1" == "cp" ]]; then
  exit 0
fi
if [[ "$*" == *" stop"* ]]; then
  printf 'stopped\n' > "$state_file"
  exit 0
fi
exit 0
`,
          kubectl: `
if [[ "$*" == *"get deployment ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vault-data-export")}"* ]]; then
  exit 1
fi
if [[ "$*" == *"apply -f "* ]]; then
  printf 'apply failed' >&2
  exit 1
fi
if [[ "$1" == "-n" && ( "$3" == "exec" || "$3" == "cp" ) ]] || [[ "$1" == "exec" ]] || [[ "$1" == "cp" ]]; then
  exit 0
fi
exit 0
`,
        },
        async () => {
          await assert.rejects(
            captureStdout(async () => {
              await runCli(["switch", `${project}@pod`]);
            }),
          );
        },
      );

      const statusPath = vaultStatusPath(project, DEMO_USER_PROFILE_ID);
      const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8")) as {
        driver?: { selected?: { backend?: string; profile?: string } };
      };
      assert.equal(parsed.driver?.selected?.backend, "docker");
      assert.equal(parsed.driver?.selected?.profile, undefined);
    } finally {
      cleanupDriverSelectionState(project);
      fs.rmSync(podPath, { force: true });
      fs.rmSync(dockerStateFile, { force: true });
    }
  });
});

test("switch exports from the selected kubevirt pvc even when the vm is already stopped", async () => {
  const project = uniqueProjectName("switch-stopped-vm-source");
  cleanupDriverSelectionState(project);

  await withTempVaultSpec(project, "docker", async () => {
    const vmPath = vaultConfigPath(project, "kubevirt-vm", DEMO_USER_PROFILE_ID);
    try {
      ensureVaultConfig(`${project}@kubevirt-vm`);
      writeVaultDriverSelection(
        project,
        { backend: "kubevirt-vm" },
        DEMO_USER_PROFILE_ID,
      );

      await withFakeCommands(
        {
          docker: `
if [[ "$*" == *"compose"* && "$*" == *"up -d"* ]]; then
  exit 0
fi
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf 'docker-id'
  exit 0
fi
if [[ "$*" == *"inspect docker-id"* ]]; then
  printf '[{"State":{"Running":true}}]'
  exit 0
fi
if [[ "$*" == *"paseo daemon status --json"* ]]; then
  printf '{"serverId":"srv_switch","localDaemon":"running","connectedDaemon":"reachable"}'
  exit 0
fi
if [[ "$*" == *"cat /root/.paseo/server-id"* ]]; then
  printf 'srv_switch'
  exit 0
fi
if [[ "$*" == *"cat /root/.paseo/pairing.json"* ]]; then
  printf '{"url":"https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9zd2l0Y2gifQ"}'
  exit 0
fi
if [[ "$1" == "run" || "$1" == "volume" || "$1" == "exec" || "$1" == "cp" ]]; then
  exit 0
fi
exit 0
`,
          kubectl: `
if [[ "$*" == *"get deployment ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vault-data-export")}"* ]]; then
  exit 1
fi
if [[ "$*" == *"get vm ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf '${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}'
  exit 0
fi
if [[ "$*" == *"get vmi ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf ''
  exit 0
fi
if [[ "$*" == *"apply -f "* && "$*" == *"pvc-export.yaml"* ]]; then
  exit 0
fi
if [[ "$*" == *"wait --for=condition=Ready pod/${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-export")}"* ]]; then
  exit 0
fi
if [[ "$*" == *"delete pod ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-export")}"* ]]; then
  exit 0
fi
if [[ "$*" == *"wait --for=delete pod/${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-export")}"* ]]; then
  exit 0
fi
if [[ "$1" == "-n" && "$3" == "cp" ]] || [[ "$1" == "cp" ]]; then
  exit 0
fi
if [[ "$*" == *"patch vm ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf 'unexpected stop' >&2
  exit 1
fi
exit 0
`,
        },
        async ({ readCommandLog }) => {
          await captureStdout(async () => {
            await runCli(["switch", `${project}@docker`]);
          });

          const commands = readCommandLog();
          const pvcExportIndex = commands.findIndex((entry) =>
            entry.includes(vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-export")) && entry.includes(" cp "),
          );
          const dockerUpIndex = commands.findIndex((entry) =>
            entry.includes("docker") && entry.includes("compose") && entry.includes("up -d"),
          );

          assert.ok(pvcExportIndex >= 0);
          assert.ok(dockerUpIndex >= 0);
          assert.ok(pvcExportIndex < dockerUpIndex);
          assert.ok(
            commands.some((entry) => entry.includes(`delete pod ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-export")} --ignore-not-found --wait=false`)),
          );
          assert.equal(
            commands.some((entry) => entry.includes(`patch vm ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}`)),
            false,
          );
        },
      );
    } finally {
      cleanupDriverSelectionState(project);
      fs.rmSync(vmPath, { force: true });
    }
  });
});

test("kubevirt backend returns structured observations and current status semantics stay ready only when cloud-init is present", async () => {
  const project = uniqueProjectName("vm-status");

  await withTempVaultSpec(project, "kubevirt-vm", async () => {
    const vault = loadVaultFromRefForTest(project);
    const driver = getBackendDriver("kubevirt-vm");

    await withFakeCommands(
      {
        kubectl: `
if [[ "$*" == *"get vm ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf '${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}'
  exit 0
fi
if [[ "$*" == *"get vmi ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf 'Running'
  exit 0
fi
if [[ "$*" == *"get svc ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf '${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}'
  exit 0
fi
if [[ "$*" == *"get secret ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm-cloudinit")}"* ]]; then
  printf '${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm-cloudinit")}'
  exit 0
fi
if [[ "$*" == *"port-forward svc/${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)} "* && "$*" == *":22"* ]]; then
  printf 'Forwarding from 127.0.0.1:40022 -> 22\n'
  exit 0
fi
if [[ "$*" == *"apply -f "* ]]; then
  exit 0
fi
exit 0
`,
        sshpass: `
if [[ "$*" == *"guestReachable=1"* ]]; then
  printf 'guestReachable=1\n'
  printf 'daemonStatusRaw<<EOF\n{"serverId":"srv_ready","localDaemon":"running","connectedDaemon":"reachable"}\nEOF\n'
  printf 'persistedServerId<<EOF\nsrv_ready\nEOF\n'
  printf 'pairingRaw<<EOF\n{"url":"https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9yZWFkeSJ9"}\nEOF\n'
  printf 'vaultDataObserved=1\nvaultRuntimeObserved=1\nuserIdentityObserved=1\nuserSshObserved=1\nhomeObserved=1\nprojectRootObserved=1\nmanagerStateObserved=1\nevolutionStateObserved=1\ncodexObserved=1\nclaudeObserved=1\nsshObserved=1\n'
  exit 0
fi
exit 1
`,
      },
      async () => {
        const observation = await driver.inspect(vault);
        assert.equal(observation.backend.exists, true);
        assert.equal(observation.backend.running, true);

        const drift = computeVaultDrift(vault, observation);
        const status = synthesizeVaultStatus(vault, observation, drift);
        assert.equal(status.driver?.selected?.backend, "kubevirt-vm");
        assert.equal(status.driver?.status, "running");

        const plan = { project, backend: "kubevirt-vm", safe: true, requiresRestart: false, destructive: false, actions: [{ kind: "render" }, { kind: "apply" }] as any[] };
        await driver.executeReconcilePlan(vault, plan as any);
      },
    );
  });
});

test("CLI status and logs cover docker backend through fake docker compose", async () => {
  const project = uniqueProjectName("docker-status");

  await withTempVaultSpec(project, "docker", async () => {
    await withFakeCommands(
      {
        docker: `
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf 'abc123'
  exit 0
fi
if [[ "$*" == *"inspect abc123"* ]]; then
  printf '[{"State":{"Running":true}}]'
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  exit 0
fi
if [[ "$*" == *"logs --tail 200 ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf 'docker logs'
  exit 0
fi
exit 0
`,
      },
      async ({ readCommandLog }) => {
        const stdout = await captureStdout(async () => {
          await runCli(["status", project]);
        });

        const parsed = parseJsonOutput<{
          driver?: {
            selected?: { backend: string };
            status?: string;
            baseImage: string;
            runtimeKind: string;
            runtimeRef: string;
          };
          assets: {
            dockerfile: { file: string; path: string };
            specs: Array<{ driver: string; file: string; path: string }>;
            generatedManifests: Array<{ driver: string; file: string; path: string }>;
            imageTags: Array<{ name: string; tag: string }>;
            persistentVolumes: Array<{ name: string; mountRoot: string; durablePaths: string[] }>;
          };
        }>(stdout);

        assert.equal(parsed.driver?.selected?.backend, "docker");
        assert.equal(parsed.driver?.baseImage, loadVaultFromRefForTest(`${project}@docker`).runtime.baseImage);
        assert.equal(parsed.driver?.runtimeKind, "docker-container");
        assert.equal(parsed.driver?.runtimeRef, `container/${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}-docker`);
        assert.equal(parsed.driver?.status, "running");
        assert.equal(parsed.assets.dockerfile.file, "vault-prebuilt.Dockerfile");
        assert.equal(
          parsed.assets.dockerfile.path,
          repoRelative(path.join(USER_ROOT, DEMO_USER_PROFILE_ID, "docker", "vault-prebuilt.Dockerfile")),
        );
        assert.deepEqual(parsed.assets.specs.map((item) => item.driver), ["docker", "pod", "kubevirt-vm"]);
        assert.deepEqual(parsed.assets.generatedManifests.map((item) => item.file), ["docker.yaml", "pod.yaml", "kubevirt.yaml"]);
        assert.equal(parsed.assets.imageTags.find((item) => item.name === "vault")?.tag, vaultImageRef(DEMO_USER_PROFILE_ID, project));
        assert.ok(parsed.assets.persistentVolumes.some((item) => item.name === "vault-data" && item.mountRoot === "/vault/project"));
        assert.deepEqual(
          parsed.assets.persistentVolumes.map((item) => item.name).sort(),
          ["vault-data", "vault-runtime-state"],
        );

        await runCli(["logs", project]);
        const commands = readCommandLog();
        assert.ok(commands.some((entry) => entry.includes(`compose`) && entry.includes(`ps -q ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}`)));
        assert.ok(commands.some((entry) => entry.includes(`logs --tail 200 ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}`)));
      },
    );
  });
});

test("CLI status and logs cover kubevirt backend through fake kubectl", async () => {
  const project = uniqueProjectName("vm-cli");

  await withTempVaultSpec(project, "kubevirt-vm", async () => {
    await withFakeCommands(
      {
        kubectl: `
if [[ "$*" == *"get vm ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf '${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}'
  exit 0
fi
if [[ "$*" == *"get vmi ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf 'Running'
  exit 0
fi
if [[ "$*" == *"get svc ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf '${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}'
  exit 0
fi
if [[ "$*" == *"get secret ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm-cloudinit")}"* ]]; then
  printf '${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm-cloudinit")}'
  exit 0
fi
if [[ "$*" == *"port-forward svc/${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, project)} "* && "$*" == *":22"* ]]; then
  printf 'Forwarding from 127.0.0.1:40022 -> 22\n'
  exit 0
fi
if [[ "$1" == "-n" && "$3" == "get" && "$4" == "pod" && "$*" == *"vm.kubevirt.io/name=${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf 'virt-launcher-0'
  exit 0
fi
if [[ "$1" == "-n" && "$3" == "logs" && "$4" == "virt-launcher-0" && "$5" == "--tail=200" ]]; then
  printf 'kubevirt logs'
  exit 0
fi
exit 0
`,
        sshpass: `
if [[ "$*" == *"guestReachable=1"* ]]; then
  printf 'guestReachable=1\n'
  printf 'daemonStatusRaw<<EOF\n{"serverId":"srv_vmcli","localDaemon":"running","connectedDaemon":"reachable"}\nEOF\n'
  printf 'persistedServerId<<EOF\nsrv_vmcli\nEOF\n'
  printf 'pairingRaw<<EOF\n{"url":"https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl92bWNsaSJ9"}\nEOF\n'
  printf 'vaultDataObserved=1\nvaultRuntimeObserved=1\nuserIdentityObserved=1\nuserSshObserved=1\nhomeObserved=1\nprojectRootObserved=1\nmanagerStateObserved=1\nevolutionStateObserved=1\ncodexObserved=1\nclaudeObserved=1\nsshObserved=1\n'
  exit 0
fi
exit 1
`,
      },
      async ({ readCommandLog }) => {
        const stdout = await captureStdout(async () => {
          await runCli(["status", project]);
        });
        const parsed = parseJsonOutput<{
          driver?: {
            selected?: { backend: string };
            status?: string;
            baseImage: string;
            runtimeKind: string;
            runtimeRef: string;
            rootdiskImage?: string;
          };
          paseo: { daemon: string; web: string };
        }>(stdout);

        assert.equal(parsed.driver?.selected?.backend, "kubevirt-vm");
        assert.equal(parsed.driver?.runtimeKind, "kubevirt-vm");
        assert.equal(parsed.driver?.runtimeRef, `vm/${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}`);
        assert.equal(parsed.driver?.status, "running");
        assert.ok(["pending", "ready"].includes(parsed.paseo.daemon));

        await runCli(["logs", project]);
        const commands = readCommandLog();
        assert.ok(commands.some((entry) => entry.includes(`get pod -l vm.kubevirt.io/name=${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}`)));
        assert.ok(commands.some((entry) => entry.includes("logs virt-launcher-0 --tail=200")));
      },
    );
  });
});

test("kubevirt lifecycle actions use kubectl virt and apply", async () => {
  const vault = loadVaultFromRefForTest("demo@kubevirt-vm");
  const driver = getBackendDriver("kubevirt-vm");

  await withFakeCommands(
    {
      kubectl: `
if [[ "$*" == *"get vm ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "vm")}"* ]]; then
  printf '${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "vm")}'
  exit 0
fi
if [[ "$*" == *"get vmi ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "vm")}"* ]]; then
  printf 'Running'
  exit 0
fi
if [[ "$*" == *"get svc ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}'
  exit 0
fi
if [[ "$*" == *"get secret ${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "vm-cloudinit")}"* ]]; then
  printf '${vaultRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "vm-cloudinit")}'
  exit 0
fi
if [[ "$*" == *"port-forward svc/${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* && "$*" == *":22"* ]]; then
  printf 'Forwarding from 127.0.0.1:40022 -> 22\n'
  exit 0
fi
exit 0
`,
      sshpass: `
if [[ "$*" == *"set -euo pipefail"* && "$*" == *"true"* ]]; then
  exit 0
fi
if [[ "$*" == *"test -s "* && "$*" == *"server-id"* && "$*" == *"grep -q"* ]]; then
  exit 0
fi
exit 0
`,
    },
    async () => {
      await driver.apply(vault);
      await driver.start(vault);
      await driver.stop(vault);
      await driver.restart(vault);
    },
  );
});

test("docker backend returns structured observations and executes compose actions", async () => {
  const base = loadDefaultDemoVault();
  const vault = {
    ...base,
    backend: {
      ...base.backend,
      kind: "docker" as const,
      profile: "docker",
      dockerRuntimeMode: "legacy" as const,
    },
    attachments: {
      ...base.attachments,
      vaultData: {
        ...base.attachments.vaultData,
        source: {
          kind: "persistent-volume" as const,
          volumeRef: "demo-vault-data",
          description: "test vault data volume",
        },
      },
    },
  };
  const driver = getBackendDriver("docker");

  await withFakeCommands(
    {
      docker: `
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf 'abc123'
  exit 0
fi
if [[ "$*" == *"inspect abc123"* ]]; then
  printf '[{"State":{"Running":true}}]'
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  exit 0
fi
exit 0
`,
    },
    async () => {
      const observation = await driver.inspect(vault);
      assert.equal(observation.backend.exists, true);
      assert.equal(observation.backend.running, true);
      const drift = computeVaultDrift(vault, observation);
      const status = synthesizeVaultStatus(vault, observation, drift);
      assert.equal(status.driver?.selected?.backend, "docker");

      const plan = { project: "demo", backend: "docker", safe: true, requiresRestart: false, destructive: false, actions: [{ kind: "render" }, { kind: "apply" }] as any[] };
      await driver.executeReconcilePlan(vault, plan as any);
    },
  );
});

test("docker lifecycle actions execute through docker compose", async () => {
  const base = loadDefaultDemoVault();
  const previousExportRoot = process.env.POLARIS_NETFS_LOCAL_EXPORT_ROOT;
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-docker-actions-"));
  const vault = {
    ...base,
    backend: {
      ...base.backend,
      kind: "docker" as const,
      profile: "docker",
      dockerRuntimeMode: "legacy" as const,
    },
    attachments: {
      ...base.attachments,
      vaultData: {
        ...base.attachments.vaultData,
        source: {
          ...base.attachments.vaultData.source,
          exportPath: exportRoot,
        },
      },
    },
  };
  const driver = getBackendDriver("docker");
  const dockerPath = vaultConfigPath("demo", "docker", DEMO_USER_PROFILE_ID);
  const originalDockerDoc = fs.readFileSync(dockerPath, "utf8");
  const dockerDoc = (yaml.load(originalDockerDoc) ?? {}) as Record<string, any>;
  dockerDoc.attachments["vault-data"].source.export_path = exportRoot;
  fs.writeFileSync(dockerPath, yaml.dump(dockerDoc, { lineWidth: 120, noRefs: true }), "utf8");

  try {
    process.env.POLARIS_NETFS_LOCAL_EXPORT_ROOT = exportRoot;
    await withFakeCommands(
      {
      docker: `
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${vaultRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf 'abc123'
  exit 0
fi
if [[ "$*" == *"inspect abc123"* ]]; then
  printf '[{"State":{"Running":true}}]'
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  if [[ "$*" == *"paseo daemon status --json"* ]]; then
    printf '{"serverId":"srv_docker","localDaemon":"running","connectedDaemon":"reachable"}'
    exit 0
  fi
  if [[ "$*" == *"cat /root/.paseo/server-id"* ]]; then
    printf 'srv_docker'
    exit 0
  fi
  if [[ "$*" == *"cat /root/.paseo/pairing.json"* ]]; then
    printf '{"url":"https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kb2NrZXIifQ"}'
    exit 0
  fi
  exit 0
fi
exit 0
`,
      },
      async () => {
        await driver.render(vault);
        await driver.apply(vault);
        await driver.start(vault);
        await driver.stop(vault);
        await driver.restart(vault);
        await driver.rebuild(vault);
      },
    );
  } finally {
    fs.writeFileSync(dockerPath, originalDockerDoc, "utf8");
    if (previousExportRoot === undefined) {
      delete process.env.POLARIS_NETFS_LOCAL_EXPORT_ROOT;
    } else {
      process.env.POLARIS_NETFS_LOCAL_EXPORT_ROOT = previousExportRoot;
    }
    fs.rmSync(exportRoot, { recursive: true, force: true });
  }
});

test("docker lifecycle actions create missing user identity volume before compose", async () => {
  const base = loadDefaultDemoVault();
  const vault = {
    ...base,
    backend: {
      ...base.backend,
      kind: "docker" as const,
      profile: "docker",
      dockerRuntimeMode: "legacy" as const,
    },
    attachments: {
      ...base.attachments,
      vaultData: {
        ...base.attachments.vaultData,
        source: {
          kind: "persistent-volume" as const,
          volumeRef: "demo-vault-data",
          description: "test vault data volume",
        },
      },
    },
  };
  const driver = getBackendDriver("docker");
  const expectedIdentityVolume = `polaris-${DEMO_USER_PROFILE_ID}-identity`;

  await withFakeCommands(
    {
      docker: `
if [[ "$1" == "volume" && "$2" == "inspect" && "$3" == "${expectedIdentityVolume}" ]]; then
  exit 1
fi
if [[ "$1" == "volume" && "$2" == "create" && "$3" == "${expectedIdentityVolume}" ]]; then
  printf '%s' "$3"
  exit 0
fi
if [[ "$*" == *"compose"* && "$*" == *"ps -q demo"* ]]; then
  printf 'abc123'
  exit 0
fi
if [[ "$*" == *"inspect abc123"* ]]; then
  printf '[{"State":{"Running":true}}]'
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  exit 0
fi
exit 0
`,
    },
    async ({ readCommandLog }) => {
      await driver.start(vault);
      const commands = readCommandLog();
      const inspectIndex = commands.findIndex((entry) =>
        entry === `volume inspect ${expectedIdentityVolume}`
      );
      const createIndex = commands.findIndex((entry) =>
        entry === `volume create ${expectedIdentityVolume}`
      );
      const composeIndex = commands.findIndex((entry) =>
        entry.includes("compose") && entry.includes(" up -d")
      );
      assert.ok(inspectIndex >= 0);
      assert.ok(createIndex > inspectIndex);
      assert.ok(composeIndex > createIndex);
    },
  );
});
