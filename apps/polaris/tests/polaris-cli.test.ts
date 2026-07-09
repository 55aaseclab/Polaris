import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { loadWorkspaceFromConfigPath, resolveWorkspaceConfigPath } from "../scripts/config/load.js";
import { ensureCanonicalWorkspaceImage, ensureWorkspaceConfig } from "../scripts/config/provision.js";
import { assertNoProjectNameCollision, assertProjectNameAvailableForUser } from "../scripts/config/project-ownership.js";
import { getBackendDriver } from "../scripts/backends/index.js";
import { syncWorkspaceDockerfileTemplate, workspaceConfigPath, workspaceImageRef } from "../scripts/config/scaffold.js";
import { EvolutionStore } from "../scripts/evolution/store.js";
import { generatedOutputPath } from "../scripts/output/write-generated.js";
import {
  workspaceEvolutionStateDir,
  workspaceLiveCredentialsPath,
  workspacePaseoStateDir,
  workspaceSelectionPath,
  workspaceStatusPath,
  writeWorkspaceDriverSelection,
  writeWorkspaceLiveCredentialSelection,
  writeWorkspaceStatus,
} from "../scripts/output/state-store.js";
import { renderAndWritePodWorkspace } from "../scripts/backends/pod/render.js";
import { renderAndWriteDockerWorkspace } from "../scripts/backends/docker/render.js";
import { renderAndWriteKubevirtWorkspace, renderKubevirtWorkspace } from "../scripts/backends/kubevirt/render.js";
import { kubevirtProbePassword } from "../scripts/backends/kubevirt/probe-access.js";
import { runCli } from "../scripts/cli/main.js";
import { startCommand } from "../scripts/cli/commands/start.js";
import { waitForWorkspaceReady } from "../scripts/cli/commands/shared.js";
import { buildReconcilePlan, computeWorkspaceDrift, synthesizeWorkspaceStatus } from "../scripts/core/runtime-controller.js";
import {
  workspaceRuntimeResourceName,
  workspaceRuntimeScopeName,
} from "../scripts/core/workspace-name.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const STDOUT_CAPTURE_QUEUE_KEY = "__polaris_stdout_capture_queue__";
const DEMO_USER_PROFILE_ID = "100000000000000001";
const SHARED_WORKSPACE_DOCKERFILE = path.join(
  REPO_ROOT,
  "config",
  "docker",
  "workspace-prebuilt.Dockerfile",
);

function sharedWorkspaceImageRefForTest(dockerfilePath: string): string {
  const digest = createHash("sha256")
    .update(fs.readFileSync(dockerfilePath))
    .digest("hex");
  return `ttl.sh/polaris-workspace-prebuilt-${digest.slice(0, 32)}:24h`;
}

function loadWorkspaceFromRefForTest(projectRef: string) {
  const resolved = resolveWorkspaceConfigPath(projectRef);
  return loadWorkspaceFromConfigPath(
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
    // Some tests intentionally leave workspace/archive state behind, which
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
  fs.rmSync(workspaceStatusPath(project, DEMO_USER_PROFILE_ID), { force: true });
  fs.rmSync(path.join(REPO_ROOT, "config", "state", `${project}.status.json`), { force: true });
}

function cleanupSelectionFile(project: string): void {
  fs.rmSync(workspaceSelectionPath(project, DEMO_USER_PROFILE_ID), { force: true });
  fs.rmSync(path.join(REPO_ROOT, "config", "state", `${project}.selection.json`), { force: true });
}

function cleanupLiveCredentialsFile(project: string): void {
  fs.rmSync(workspaceLiveCredentialsPath(project, DEMO_USER_PROFILE_ID), { force: true });
  fs.rmSync(path.join(REPO_ROOT, "config", "state", `${project}.live-credentials.json`), { force: true });
}

function loadDefaultDemoWorkspace() {
  cleanupSelectionFile("demo");
  return loadWorkspaceFromRefForTest("demo");
}

async function withTempWorkspaceSpec(
  project: string,
  backendKind: "docker" | "pod" | "kubevirt-vm",
  fn: () => Promise<void> | void,
): Promise<void> {
  const outputPath = workspaceConfigPath(project, backendKind, DEMO_USER_PROFILE_ID);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const sourcePath = workspaceConfigPath("demo", backendKind, DEMO_USER_PROFILE_ID);
  const doc = (yaml.load(fs.readFileSync(sourcePath, "utf8")) ?? {}) as Record<string, any>;
  doc.project = project;
  doc.backend = {
    ...(doc.backend ?? {}),
    kind: backendKind,
  };
  if (backendKind === "docker") {
    doc.runtime = {
      ...(doc.runtime ?? {}),
      class: "docker",
      docker_enabled: true,
    };
  }

  fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
  const generatedPath = generatedOutputPath(loadWorkspaceFromRefForTest(`${project}@${backendKind}`));
  try {
    await fn();
  } finally {
    fs.rmSync(outputPath, { force: true });
    fs.rmSync(generatedPath, { force: true });
    cleanupStatusFile(project);
    cleanupLiveCredentialsFile(project);
  }
}

test("loadWorkspace normalizes demo pod config through the TypeScript control plane", () => {
  const workspace = loadDefaultDemoWorkspace();
  assert.equal(workspace.identity.projectName, "demo");
  assert.equal(workspace.profile.name, "morpheus");
  assert.match(workspace.userProfile.id, /^\d{18}$/);
  assert.ok(workspace.userProfile.name.length > 0);
  assert.match(workspace.userProfile.email, /@/);
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "config", "users", workspace.userProfile.id, "workspaces", "demo")));
  assert.equal(workspace.backend.kind, "pod");
  assert.equal(workspace.backend.profile, "gvisor");
  assert.equal(workspace.health.readinessMode, "daemon-port");
  assert.ok(workspace.runtimeContract.staleRuntimeArtifacts.some((entry) => entry.endsWith(".paseo/paseo.pid")));
  assert.equal(workspace.attachments.workspaceData.scope, "workspace");
  assert.equal(workspace.attachments.workspaceRuntimeState.scope, "workspace");
  assert.equal(workspace.attachments.userIdentityState.scope, "user");
  assert.equal(workspace.attachments.userIdentityState.sharing, "cross-workspace");
  assert.ok(workspace.attachments.userIdentityState.durablePaths.includes("/identity/ssh"));
  assert.equal(workspace.attachments.workspaceData.mountRoot, "/workspace/project");
  assert.equal(workspace.attachments.workspaceData.source.kind, "netfs");
  assert.equal(workspace.attachments.workspaceData.source.server, "netfs.local");
  assert.equal(workspace.attachments.workspaceData.source.exportPath, "/exports/polaris/workspaces");
  assert.equal(workspace.attachments.workspaceData.source.subPath, "demo");
  assert.ok(!workspace.userProfile.github.account || workspace.userProfile.github.account.length > 0);
  assert.equal(workspace.credentialBindings.length, 1);
  assert.equal(workspace.credentialBindings[0]?.purpose, "agent-auth");
  assert.equal(workspace.resolvedCredentialBindings[0]?.source, "registry");
  assert.equal(workspace.resolvedCredentialBindings[0]?.attachmentKind, "user-identity-state");
});

test("backend registry resolves pod driver", () => {
  const driver = getBackendDriver("pod");
  assert.equal(driver.kind, "pod");
});

test("runCli rejects empty argv and missing project", async () => {
  await assert.rejects(() => runCli([]), /Usage:/);
  await assert.rejects(() => runCli(["status"]), /Usage:/);
});

test("runCli user create scaffolds a user profile and default credentials", async () => {
  const userProfileId = uniqueProjectName("cli-user");
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userProfileId);

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
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("runCli user create adds the default RightCode codex credential when configured", async () => {
  const previous = process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY;
  process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY = "test-default-rightcode-key";
  const userProfileId = uniqueProjectName("cli-user-codex-default");
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userProfileId);

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
    if (previous === undefined) {
      delete process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY;
    } else {
      process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY = previous;
    }
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("runCli create allows the same workspace name under a different user", async () => {
  const workspace = uniqueProjectName("cli-shared-workspace");
  const firstUserId = uniqueProjectName("cli-shared-user-a");
  const secondUserId = uniqueProjectName("cli-shared-user-b");
  const firstProfilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${firstUserId}.yaml`);
  const secondProfilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${secondUserId}.yaml`);
  const firstUserRoot = path.join(REPO_ROOT, "config", "users", firstUserId);
  const secondUserRoot = path.join(REPO_ROOT, "config", "users", secondUserId);

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

    await runCli(["create", workspace, "--user", firstUserId]);
    await runCli(["create", workspace, "--user", secondUserId]);
    assert.equal(
      fs.existsSync(path.join(secondUserRoot, "workspaces", workspace, "docker.agent.yaml")),
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

test("runCli user delete removes the user profile, secrets root, and Clerk mapping", async () => {
  const userProfileId = uniqueProjectName("cli-user-delete");
  const clerkUsername = `${userProfileId}-clerk`;
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const userMapPath = path.join(REPO_ROOT, "config", "users", "user-map.json");
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
  const firstProfilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${firstUserId}.yaml`);
  const secondProfilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${secondUserId}.yaml`);
  const firstUserRoot = path.join(REPO_ROOT, "config", "users", firstUserId);
  const secondUserRoot = path.join(REPO_ROOT, "config", "users", secondUserId);
  const userMapPath = path.join(REPO_ROOT, "config", "users", "user-map.json");
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

test("runCli user delete rejects users that still have workspace data", async () => {
  const userProfileId = uniqueProjectName("cli-user-delete-blocked");
  const workspace = uniqueProjectName("cli-user-delete-workspace");
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userProfileId);

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
    await runCli(["create", workspace, "--user", userProfileId]);

    await assert.rejects(
      async () => {
        await runCli(["user", "delete", userProfileId]);
      },
      /cannot be deleted while workspace data still exists/i,
    );
  } finally {
    await cleanupCliTestUser({
      userId: userProfileId,
      profilePath,
      userRoot,
    });
  }
});

test("runCli archive moves a workspace into the user archive", async () => {
  const userProfileId = uniqueProjectName("cli-archive-user");
  const workspace = uniqueProjectName("cli-archive-workspace");
  const profilePath = path.join(
    REPO_ROOT,
    "config",
    "users",
    "profiles",
    `${userProfileId}.yaml`,
  );
  const userRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const workspaceRoot = path.join(userRoot, "workspaces", workspace);
  const archivedRoot = path.join(userRoot, "archives", "workspaces");

  try {
    await runCli([
      "user",
      "create",
      userProfileId,
      "--name",
      "CLI Archive User",
      "--email",
      `${userProfileId}@polaris.local`,
    ]);
    await runCli(["create", workspace, "--user", userProfileId]);

    await runCli(["archive", workspace]);

    assert.equal(fs.existsSync(workspaceRoot), false);
    const archiveEntries = fs.existsSync(archivedRoot)
      ? fs.readdirSync(archivedRoot)
      : [];
    assert.equal(archiveEntries.some((entry) => entry.endsWith(`-${workspace}`)), true);
  } finally {
    await cleanupCliTestUser({
      userId: userProfileId,
      profilePath,
      userRoot,
    });
  }
});

test("assertProjectNameAvailableForUser rejects names already used by archived workspaces", () => {
  const userProfileId = uniqueProjectName("cli-archived-name-user");
  const workspace = uniqueProjectName("cli-archived-name-workspace");
  const archiveId = `20260701T000000Z-${workspace}`;
  const userRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const archiveRoot = path.join(userRoot, "archives", "workspaces", archiveId);

  fs.mkdirSync(archiveRoot, { recursive: true });
  fs.writeFileSync(
    path.join(archiveRoot, ".polaris-archive.json"),
    JSON.stringify({
      archiveId,
      workspaceName: workspace,
      archivedAt: "2026-07-01T00:00:00.000Z",
      originalWorkspaceRoot: `config/users/${userProfileId}/workspaces/${workspace}`,
      workspaceRoot: `config/users/${userProfileId}/archives/workspaces/${archiveId}`,
    }, null, 2) + "\n",
    "utf8",
  );

  try {
    assert.throws(
      () => assertProjectNameAvailableForUser(workspace, userProfileId),
      new RegExp(`Workspace '${workspace}' is already archived for user ${userProfileId}`),
    );
  } finally {
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("runCli delete removes a workspace without creating an archive", async () => {
  const userProfileId = uniqueProjectName("cli-delete-user");
  const workspace = uniqueProjectName("cli-delete-workspace");
  const profilePath = path.join(
    REPO_ROOT,
    "config",
    "users",
    "profiles",
    `${userProfileId}.yaml`,
  );
  const userRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const workspaceRoot = path.join(userRoot, "workspaces", workspace);
  const archivedRoot = path.join(userRoot, "archives", "workspaces");

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
    await runCli(["create", workspace, "--user", userProfileId]);

    await runCli(["delete", workspace]);

    assert.equal(fs.existsSync(workspaceRoot), false);
    const archiveEntries = fs.existsSync(archivedRoot)
      ? fs.readdirSync(archivedRoot)
      : [];
    assert.equal(archiveEntries.some((entry) => entry.endsWith(`-${workspace}`)), false);
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
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userProfileId);

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
  const userRoot = path.join(REPO_ROOT, "config", "users", userProfileId);

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
  const userRoot = path.join(REPO_ROOT, "config", "users", userProfileId);

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
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userProfileId);

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

  await withTempWorkspaceSpec(project, "docker", async () => {
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
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
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
            workspace: string;
            harness: string;
            credentialId: string;
          }>(stdout);
          assert.equal(payload.switched, true);
          assert.equal(payload.workspace, project);
          assert.equal(payload.harness, "claude");
          assert.equal(payload.credentialId, "claude-live");
          assert.ok(
            readCommandLog().some((entry) =>
              entry.includes(`exec ${project}-docker sh -lc`),
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
          "workspaces",
          project,
          "state",
          "live-credentials.json",
        ),
        { force: true },
      );
      fs.rmSync(
        path.join(REPO_ROOT, "config", "users", DEMO_USER_PROFILE_ID, "credentials", "claude", "claude-live"),
        { recursive: true, force: true },
      );
      fs.rmSync(
        path.join(REPO_ROOT, "config", "users", DEMO_USER_PROFILE_ID, "credentials", "claude-live.yaml"),
        { force: true },
      );
    }
  });
});

test("writeWorkspaceStatus persists a structured state file", () => {
  const project = uniqueProjectName("sample-agent");
  const statusPath = writeWorkspaceStatus({
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

test("writeWorkspaceStatus replaces stale fields instead of merging previous status", () => {
  const project = uniqueProjectName("replace-status");
  const statusPath = writeWorkspaceStatus({
    schemaVersion: 1.1,
    project,
    driver: {
      selected: null,
      status: "starting",
      reason: "workspace start requested",
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

  writeWorkspaceStatus({
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
  const statusPath = writeWorkspaceDriverSelection(
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

test("workspaceImageRef derives a neutral deterministic ttl.sh reference", () => {
  assert.equal(
    workspaceImageRef("100000000000000001", "example-project"),
    "ttl.sh/user-001-example-project:24h",
  );
  assert.equal(
    workspaceImageRef("local-example-user@example.com", "Feature Preview"),
    "ttl.sh/user-local-example-user-examp-feature-preview:24h",
  );
});

test("ensureWorkspaceConfig synthesizes a pod spec from the docker source of truth", () => {
  const project = uniqueProjectName("synth-pod");
  const dockerPath = workspaceConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
  const podPath = workspaceConfigPath(project, "pod", DEMO_USER_PROFILE_ID);
  fs.mkdirSync(path.dirname(dockerPath), { recursive: true });
  fs.copyFileSync(workspaceConfigPath("demo", "docker", DEMO_USER_PROFILE_ID), dockerPath);

  const sourceDoc = (yaml.load(fs.readFileSync(dockerPath, "utf8")) ?? {}) as Record<string, any>;
  sourceDoc.project = project;
  fs.writeFileSync(dockerPath, yaml.dump(sourceDoc, { lineWidth: 120, noRefs: true }), "utf8");

  try {
    const synthesized = ensureWorkspaceConfig(`${project}@pod:gvisor`);
    assert.equal(fs.existsSync(podPath), true);
    assert.equal(synthesized?.configPath, podPath);
    const podDoc = (yaml.load(fs.readFileSync(podPath, "utf8")) ?? {}) as Record<string, any>;
    assert.equal(podDoc.backend.kind, "pod");
    assert.equal(podDoc.runtime.class, "gvisor");
    assert.equal(podDoc.runtime.base_image, sourceDoc.runtime.base_image);
    assert.equal(podDoc.attachments["workspace-data"].source.kind, "netfs");
    assert.equal(podDoc.attachments["workspace-data"].source.server, "netfs.local");
    assert.equal(
      podDoc.attachments["workspace-data"].source.export_path,
      path.join(REPO_ROOT, "config", "exports", "workspaces"),
    );
    assert.equal(podDoc.attachments["workspace-data"].source.sub_path, project);
    assert.equal(
      podDoc.attachments["workspace-runtime-state"].source.volume_ref,
      workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "workspace-runtime-state"),
    );
  } finally {
    fs.rmSync(dockerPath, { force: true });
    fs.rmSync(podPath, { force: true });
  }
});

test("ensureCanonicalWorkspaceImage builds the canonical docker image locally when it is missing", async () => {
  const project = uniqueProjectName("image-provision");
  const imageRef = workspaceImageRef(DEMO_USER_PROFILE_ID, project);
  const dockerPath = workspaceConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
  const dockerfilePath = path.join(
    REPO_ROOT,
    "config",
    "users",
    DEMO_USER_PROFILE_ID,
    "docker",
    "workspace-prebuilt.Dockerfile",
  );
  const sharedImageRef = sharedWorkspaceImageRefForTest(dockerfilePath);
  fs.mkdirSync(path.dirname(dockerPath), { recursive: true });
  fs.copyFileSync(workspaceConfigPath("demo", "docker", DEMO_USER_PROFILE_ID), dockerPath);

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
        ensureCanonicalWorkspaceImage(`${project}@docker`);
        const commandLog = readCommandLog();
        assert.equal(commandLog[0], `image inspect ${sharedImageRef}`);
        assert.equal(commandLog[1], `pull ${sharedImageRef}`);
        assert.ok(
          commandLog.some((entry) =>
            entry.startsWith("build ")
            && entry.includes(`--cache-from ${sharedImageRef}`)
            && entry.includes(`--cache-from ${imageRef}`)
            && entry.includes(`-f ${dockerfilePath}`)
            && entry.includes(`-t ${sharedImageRef} .`),
          ),
        );
        assert.equal(commandLog.at(-1), `tag ${sharedImageRef} ${imageRef}`);
      },
    );
  } finally {
    fs.rmSync(dockerPath, { force: true });
    fs.rmSync(path.join(REPO_ROOT, "config", "users", DEMO_USER_PROFILE_ID, "workspaces", project), {
      recursive: true,
      force: true,
    });
  }
});

test("syncWorkspaceDockerfileTemplate refreshes a stale user Dockerfile from the shared template", () => {
  const userProfileId = uniqueProjectName("dockerfile-sync");
  const userDockerfile = path.join(REPO_ROOT, "config", "users", userProfileId, "docker", "workspace-prebuilt.Dockerfile");
  const templateDockerfile = SHARED_WORKSPACE_DOCKERFILE;
  const templateStat = fs.statSync(templateDockerfile);
  fs.mkdirSync(path.dirname(userDockerfile), { recursive: true });
  fs.writeFileSync(userDockerfile, "FROM scratch\n", "utf8");
  const older = new Date(templateStat.mtimeMs - 60_000);
  const newer = new Date(Date.now() + 60_000);
  fs.utimesSync(userDockerfile, older, older);
  fs.utimesSync(templateDockerfile, newer, newer);

  try {
    const result = syncWorkspaceDockerfileTemplate(userProfileId);
    assert.equal(result.created, false);
    assert.equal(result.refreshed, true);
    assert.equal(result.path, userDockerfile);
    assert.equal(
      fs.readFileSync(userDockerfile, "utf8"),
      fs.readFileSync(templateDockerfile, "utf8"),
    );
  } finally {
    fs.utimesSync(templateDockerfile, templateStat.atime, templateStat.mtime);
    fs.rmSync(path.join(REPO_ROOT, "config", "users", userProfileId), { recursive: true, force: true });
  }
});

test("workspace prebuilt Dockerfile delegates shared base tool installation", () => {
  const templateDockerfile = SHARED_WORKSPACE_DOCKERFILE;
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

test("startCommand does not provision or rebuild workspace images", async () => {
  const project = uniqueProjectName("start-no-provision");
  const previousExportRoot = process.env.POLARIS_NETFS_LOCAL_EXPORT_ROOT;
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-start-export-"));
  await withTempWorkspaceSpec(project, "docker", async () => {
    const dockerPath = workspaceConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
    const doc = (yaml.load(fs.readFileSync(dockerPath, "utf8")) ?? {}) as Record<string, any>;
    doc.attachments["workspace-data"].source.export_path = exportRoot;
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
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
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
          const paseoRoot = workspacePaseoStateDir(project, DEMO_USER_PROFILE_ID);
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

test("waitForWorkspaceReady persists Paseo metadata before declaring runtime ready", async () => {
  const project = uniqueProjectName("wait-ready-paseo-persist");
  await withTempWorkspaceSpec(project, "docker", async () => {
    const workspace = loadWorkspaceFromRefForTest(`${project}@docker`);
    const paseoRoot = workspacePaseoStateDir(project, DEMO_USER_PROFILE_ID);
    fs.rmSync(paseoRoot, { recursive: true, force: true });

    await withFakeCommands(
      {
        docker: `
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
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
        await waitForWorkspaceReady(workspace, 50, 0);

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

test("ensureCanonicalWorkspaceImage rebuilds when the user Dockerfile is refreshed from the template", async () => {
  const userProfileId = uniqueProjectName("dockerfile-rebuild");
  const project = uniqueProjectName("image-refresh");
  const imageRef = workspaceImageRef(userProfileId, project);
  const dockerPath = workspaceConfigPath(project, "docker", userProfileId);
  const userDockerfile = path.join(REPO_ROOT, "config", "users", userProfileId, "docker", "workspace-prebuilt.Dockerfile");
  const templateDockerfile = SHARED_WORKSPACE_DOCKERFILE;
  const sharedImageRef = sharedWorkspaceImageRefForTest(templateDockerfile);
  const templateStat = fs.statSync(templateDockerfile);
  fs.mkdirSync(path.dirname(dockerPath), { recursive: true });
  fs.copyFileSync(workspaceConfigPath("demo", "docker", DEMO_USER_PROFILE_ID), dockerPath);
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
        ensureCanonicalWorkspaceImage(`${project}@docker`);
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
    fs.rmSync(path.join(REPO_ROOT, "config", "users", userProfileId), { recursive: true, force: true });
  }
});

test("ensureCanonicalWorkspaceImage rebuilds when a local image exists without matching build state", async () => {
  const userProfileId = uniqueProjectName("image-state-user");
  const project = uniqueProjectName("image-state-project");
  const imageRef = workspaceImageRef(userProfileId, project);
  const dockerPath = workspaceConfigPath(project, "docker", userProfileId);
  const userDockerfile = path.join(
    REPO_ROOT,
    "config",
    "users",
    userProfileId,
    "docker",
    "workspace-prebuilt.Dockerfile",
  );
  fs.mkdirSync(path.dirname(dockerPath), { recursive: true });
  fs.copyFileSync(workspaceConfigPath("demo", "docker", DEMO_USER_PROFILE_ID), dockerPath);
  const doc = (yaml.load(fs.readFileSync(dockerPath, "utf8")) ?? {}) as Record<string, any>;
  doc.project = project;
  doc.user_profile = userProfileId;
  doc.runtime.base_image = imageRef;
  fs.writeFileSync(dockerPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
  fs.mkdirSync(path.dirname(userDockerfile), { recursive: true });
  fs.copyFileSync(
    SHARED_WORKSPACE_DOCKERFILE,
    userDockerfile,
  );
  const sharedImageRef = sharedWorkspaceImageRefForTest(userDockerfile);

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
        ensureCanonicalWorkspaceImage(`${project}@docker`);
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
    fs.rmSync(path.join(REPO_ROOT, "config", "users", userProfileId), {
      recursive: true,
      force: true,
    });
  }
});

test("ensureCanonicalWorkspaceImage reuses a shared prebuilt image from another workspace with the same Dockerfile", async () => {
  const userProfileId = uniqueProjectName("shared-image-user");
  const sourceProject = uniqueProjectName("shared-image-source");
  const targetProject = uniqueProjectName("shared-image-target");
  const sourceImageRef = workspaceImageRef(userProfileId, sourceProject);
  const targetImageRef = workspaceImageRef(userProfileId, targetProject);
  const sourceDockerPath = workspaceConfigPath(sourceProject, "docker", userProfileId);
  const targetDockerPath = workspaceConfigPath(targetProject, "docker", userProfileId);
  const userDockerfile = path.join(
    REPO_ROOT,
    "config",
    "users",
    userProfileId,
    "docker",
    "workspace-prebuilt.Dockerfile",
  );
  fs.mkdirSync(path.dirname(sourceDockerPath), { recursive: true });
  fs.mkdirSync(path.dirname(targetDockerPath), { recursive: true });
  fs.copyFileSync(workspaceConfigPath("demo", "docker", DEMO_USER_PROFILE_ID), sourceDockerPath);
  fs.copyFileSync(workspaceConfigPath("demo", "docker", DEMO_USER_PROFILE_ID), targetDockerPath);
  fs.mkdirSync(path.dirname(userDockerfile), { recursive: true });
  fs.copyFileSync(
    SHARED_WORKSPACE_DOCKERFILE,
    userDockerfile,
  );
  const sharedImageRef = sharedWorkspaceImageRefForTest(userDockerfile);
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
        ensureCanonicalWorkspaceImage(`${targetProject}@docker`);
        assert.deepEqual(readCommandLog(), [
          `image inspect ${sharedImageRef}`,
          `tag ${sharedImageRef} ${targetImageRef}`,
        ]);
      },
    );
  } finally {
    fs.rmSync(path.join(REPO_ROOT, "config", "users", userProfileId), {
      recursive: true,
      force: true,
    });
  }
});

test("project ownership check rejects collisions across users", () => {
  const project = uniqueProjectName("collision");
  const firstPath = workspaceConfigPath(project, "docker", "111111111111111111");
  const secondPath = workspaceConfigPath(project, "docker", "222222222222222222");
  fs.mkdirSync(path.dirname(firstPath), { recursive: true });
  fs.mkdirSync(path.dirname(secondPath), { recursive: true });
  fs.writeFileSync(firstPath, "project: collision\n", "utf8");
  fs.writeFileSync(secondPath, "project: collision\n", "utf8");

  try {
    assert.throws(() => assertNoProjectNameCollision(project), /Project name collision/);
  } finally {
    fs.rmSync(path.join(REPO_ROOT, "config", "users", "111111111111111111"), { recursive: true, force: true });
    fs.rmSync(path.join(REPO_ROOT, "config", "users", "222222222222222222"), { recursive: true, force: true });
  }
});

test("stored pod driver selection influences default workspace loading", () => {
  const project = "demo";
  writeWorkspaceDriverSelection(project, { backend: "pod", profile: "kata" }, DEMO_USER_PROFILE_ID);
  try {
    const workspace = loadWorkspaceFromRefForTest(project);
    assert.equal(workspace.backend.kind, "pod");
    assert.equal(workspace.backend.profile, "kata-qemu");
  } finally {
    cleanupSelectionFile(project);
  }
});

test("stored docker driver selection influences default workspace loading", () => {
  const project = "demo";
  writeWorkspaceDriverSelection(project, { backend: "docker" }, DEMO_USER_PROFILE_ID);
  try {
    const workspace = loadWorkspaceFromRefForTest(project);
    assert.equal(workspace.backend.kind, "docker");
  } finally {
    cleanupSelectionFile(project);
  }
});

test("status command exposes evolution explainability details", async () => {
  const project = uniqueProjectName("explained-status");
  await withTempWorkspaceSpec(project, "docker", async () => {
    const workspace = loadWorkspaceFromRefForTest(`${project}@docker`);
    const evolutionDir = workspaceEvolutionStateDir(
      workspace.identity.projectName,
      workspace.userProfile.id,
    );
    const dbPath = path.join(evolutionDir, "store.db");
    try {
      const store = await EvolutionStore.open(dbPath);
      const now = new Date().toISOString();
      try {
        store.upsertMemoryEntry({
          id: "workspace-memory:Validation:run-verifier-first:test",
          workspaceId: workspace.identity.projectName,
          userProfileId: workspace.userProfile.id,
          target: "workspace-memory",
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
              reasons: ["workspace-memory", "matched tags: verifier"],
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
          assert.deepEqual(artifact?.whyRetrieved, ["workspace-memory", "matched tags: verifier"]);
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
  await withTempWorkspaceSpec(project, "docker", async () => {
    const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", "ssh-status-test.yaml");
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
      const outputPath = workspaceConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
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
  const workspace = loadDefaultDemoWorkspace();
  const outputPath = renderAndWritePodWorkspace(workspace);
  const rendered = fs.readFileSync(outputPath, "utf8");
  assert.match(rendered, /Generated by polaris\.ts/);
  assert.match(rendered, /kind: Deployment/);
  assert.match(rendered, /mountPath: \/workspace\/project/);
  assert.match(rendered, /mountPath: \/workspace\/state/);
  assert.match(rendered, /mountPath: \/identity/);
  assert.doesNotMatch(rendered, /mountPath: \/ssh/);
  assert.match(rendered, /ln -sfn \/identity\/ssh \/root\/\.ssh/);
  assert.match(rendered, /ln -sfn \/identity\/codex \/root\/\.codex/);
  assert.match(rendered, /ln -sfn \/identity\/copilot \/root\/\.copilot/);
  assert.match(rendered, /ln -sfn \/identity\/pi \/root\/\.pi/);
  assert.match(rendered, /ln -sfn \/identity\/opencode\/config \/root\/\.config\/opencode/);
  assert.match(rendered, /ln -sfn \/workspace\/state\/paseo \/root\/\.paseo/);
});

test("attachment model distinguishes durable workspace state from ephemeral runtime state", () => {
  const workspace = loadDefaultDemoWorkspace();
  assert.deepEqual(workspace.attachments.workspaceRuntimeState.durablePaths, [
    "/workspace/state/paseo",
    "/workspace/state/paseo/evolution",
  ]);
  assert.ok(workspace.attachments.ephemeralRuntime.staleArtifacts.includes("/run/workspace/pids/paseo.pid"));
  assert.ok(workspace.runtimeContract.minimalInvariants.some((entry) => entry.includes("user-identity-state")));
});

test("user identity attachments do not include workspace-scoped paseo state", () => {
  const workspace = loadDefaultDemoWorkspace();
  assert.equal(workspace.attachments.userIdentityState.durablePaths.some((entry) => entry.includes("paseo")), false);
  assert.equal(workspace.attachments.workspaceRuntimeState.durablePaths.some((entry) => entry.includes("paseo")), true);
});

test("attachment lifecycle semantics encode cross-workspace user state and exclusive workspace state", () => {
  const workspace = loadDefaultDemoWorkspace();
  assert.equal(workspace.attachments.workspaceData.sharing, "exclusive");
  assert.equal(workspace.attachments.workspaceRuntimeState.sharing, "exclusive");
  assert.equal(workspace.attachments.userIdentityState.sharing, "cross-workspace");
  assert.equal(workspace.attachments.workspaceData.scope, "workspace");
  assert.equal(workspace.attachments.userIdentityState.scope, "user");
});

test("direct attachment config is present in migrated saved specs", () => {
  const workspace = loadDefaultDemoWorkspace();
  assert.equal(workspace.profile.name, "morpheus");
  assert.equal(workspace.attachments.workspaceData.source.kind, "netfs");
  assert.equal(workspace.attachments.workspaceRuntimeState.source.kind, "persistent-volume");
  assert.equal(workspace.attachments.userIdentityState.mountRoot, "/identity");
  assert.ok(workspace.attachments.userIdentityState.durablePaths.includes("/identity/ssh"));
  assert.ok(workspace.attachments.userIdentityState.durablePaths.includes("/identity/copilot"));
  assert.ok(workspace.attachments.userIdentityState.durablePaths.includes("/identity/opencode/config"));
  assert.ok(workspace.attachments.userIdentityState.durablePaths.includes("/identity/opencode/data"));
  assert.ok(workspace.attachments.userIdentityState.durablePaths.includes("/identity/pi/agent"));
  assert.ok(workspace.attachments.userIdentityState.durablePaths.includes("/identity/codex-xdg/config"));
  assert.ok(workspace.attachments.userIdentityState.durablePaths.includes("/identity/codex-xdg/data"));
  assert.ok(workspace.attachments.userIdentityState.durablePaths.includes("/identity/codex-xdg/state"));
});

test("profile defaults drive renderer behavior instead of workspace-name checks", () => {
  const workspace = loadDefaultDemoWorkspace();
  assert.equal(workspace.profile.workspaceAlias, "Morpheus");
  assert.equal(workspace.userProfile.ssh.comment, workspace.userProfile.email);
});

test("workspace compatibility path derives a legacy user profile from inline git identity", async () => {
  const project = uniqueProjectName("compat-user");
  await withTempWorkspaceSpec(project, "docker", async () => {
    const outputPath = workspaceConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
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

    const workspace = loadWorkspaceFromRefForTest(`${project}@docker`);
    assert.equal(workspace.userProfile.id, "legacy-legacy-example.com");
    assert.equal(workspace.userProfile.name, "Legacy User");
    assert.equal(workspace.userProfile.email, "legacy@example.com");
    assert.equal(workspace.resolvedCredentialBindings[0]?.source, "compatibility");
    assert.equal(workspace.resolvedCredentialBindings[0]?.purpose, "agent-auth");
  });
});

test("registry-backed credentials override legacy auth for the same purpose", async () => {
  const project = uniqueProjectName("credential-binding");
  const profileId = `${project}-user`;
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${profileId}.yaml`);
  const secretsRoot = path.join(REPO_ROOT, "config", "users", profileId);
  const registryDir = path.join(REPO_ROOT, "config", "users", "credentials", profileId);
  await withTempWorkspaceSpec(project, "docker", async () => {
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

    const outputPath = workspaceConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
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

    const workspace = loadWorkspaceFromRefForTest(`${project}@docker`);
    const codexAuth = workspace.runtime.authFiles.find((file) => file.key === "codex-auth.json");
    assert.equal(codexAuth?.content, "{\"source\":\"registry\"}\n");
    assert.equal(workspace.resolvedCredentialBindings[0]?.credential.id, "codex-default");
  }).finally(() => {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(secretsRoot, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  });
});

test("credential registry rejects cross-user ownership mismatches", async () => {
  const project = uniqueProjectName("credential-owner");
  const profileId = `${project}-user`;
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${profileId}.yaml`);
  const registryDir = path.join(REPO_ROOT, "config", "users", "credentials", profileId);
  await withTempWorkspaceSpec(project, "docker", async () => {
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

    const outputPath = workspaceConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
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
      () => loadWorkspaceFromRefForTest(`${project}@docker`),
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
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${profileId}.yaml`);
  const registryDir = path.join(REPO_ROOT, "config", "users", "credentials", profileId);
  await withTempWorkspaceSpec(project, "docker", async () => {
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

    const outputPath = workspaceConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
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
      () => loadWorkspaceFromRefForTest(`${project}@docker`),
      /must externalize secret material/,
    );
  }).finally(() => {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  });
});

test("provided-key user profile requires staged SSH private-key material", async () => {
  const project = uniqueProjectName("provided-key");
  await withTempWorkspaceSpec(project, "docker", async () => {
    const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", "provided-key-test.yaml");
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
      const outputPath = workspaceConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
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
      assert.throws(() => loadWorkspaceFromRefForTest(`${project}@docker`), /provided-key/);
    } finally {
      fs.rmSync(profilePath, { force: true });
    }
  });
});

test("provided-key user profile requires matching public-key comment", async () => {
  const project = uniqueProjectName("provided-key-comment");
  await withTempWorkspaceSpec(project, "docker", async () => {
    const profileId = "provided-key-comment-test";
    const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${profileId}.yaml`);
    const userRoot = path.join(REPO_ROOT, "config", "users", profileId);
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
      const outputPath = workspaceConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
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
      assert.throws(() => loadWorkspaceFromRefForTest(`${project}@docker`), /public-key comment 'expected@example.com'/);
    } finally {
      fs.rmSync(profilePath, { force: true });
      fs.rmSync(userRoot, { recursive: true, force: true });
    }
  });
});

test("docker render keys user-scoped identity volumes by user profile id", () => {
  const workspace = loadWorkspaceFromRefForTest("demo@docker");
  const outputPath = renderAndWriteDockerWorkspace(workspace);
  const rendered = fs.readFileSync(outputPath, "utf8");
  const escapedId = workspace.userProfile.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(rendered, new RegExp(`polaris-${escapedId}-identity`));
  assert.match(rendered, /external: true/);
  assert.doesNotMatch(rendered, /bootstrap-secrets/);
});

test("demo specs reuse the demo profile across docker, pod, and kubevirt backends", () => {
  const dockerWorkspace = loadWorkspaceFromRefForTest("demo@docker");
  const podWorkspace = loadWorkspaceFromRefForTest("demo@pod");
  const kubevirtWorkspace = loadWorkspaceFromRefForTest("demo@kubevirt-vm");

  for (const workspace of [dockerWorkspace, podWorkspace, kubevirtWorkspace]) {
    assert.equal(workspace.identity.projectName, "demo");
    assert.equal(workspace.userProfile.id, "100000000000000001");
    assert.equal(workspace.userProfile.name, "Demo User");
    assert.equal(workspace.userProfile.email, "demo@example.com");
    assert.equal(workspace.runtime.gitUserName, "Demo User");
    assert.equal(workspace.runtime.gitUserEmail, "demo@example.com");
  }

  assert.equal(
    dockerWorkspace.attachments.workspaceData.source.volumeRef,
    workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "workspace-data"),
  );
  assert.equal(dockerWorkspace.attachments.workspaceData.source.kind, "netfs");
  assert.equal(podWorkspace.attachments.workspaceData.source.kind, "netfs");
  assert.equal(kubevirtWorkspace.attachments.workspaceData.source.kind, "netfs");
  assert.equal(
    podWorkspace.attachments.workspaceRuntimeState.source.volumeRef,
    workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "workspace-runtime-state"),
  );
  assert.equal(
    kubevirtWorkspace.attachments.workspaceRuntimeState.source.volumeRef,
    workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "workspace-runtime-state"),
  );
});

test("docker render uses stable named volumes for reusable demo attachments", () => {
  const workspace = loadWorkspaceFromRefForTest("demo@docker");
  const outputPath = renderAndWriteDockerWorkspace(workspace);
  const rendered = fs.readFileSync(outputPath, "utf8");

  assert.match(rendered, /source: "\/exports\/polaris\/workspaces\/demo"/);
  assert.match(rendered, /source: demo-project-state\b/);
  assert.match(rendered, /demo-project-state:\n    name: demo-project-state/);
});

test("loadWorkspace rejects a netfs workspace-data attachment without a server", () => {
  const project = uniqueProjectName("netfs-missing-server");
  const outputPath = workspaceConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.copyFileSync(workspaceConfigPath("demo", "docker", DEMO_USER_PROFILE_ID), outputPath);

  try {
    const doc = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as Record<string, any>;
    doc.project = project;
    delete doc.attachments["workspace-data"].source.server;
    fs.writeFileSync(outputPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
    assert.throws(
      () => loadWorkspaceFromRefForTest(`${project}@docker`),
      /workspace-data netfs source requires a server/,
    );
  } finally {
    fs.rmSync(outputPath, { force: true });
  }
});

test("pod render mounts demo workspace data through netfs", () => {
  const workspace = loadWorkspaceFromRefForTest("demo@pod");
  const outputPath = renderAndWritePodWorkspace(workspace);
  const rendered = fs.readFileSync(outputPath, "utf8");
  assert.doesNotThrow(() => yaml.loadAll(rendered));

  assert.match(rendered, /- name: workspace-data\n        nfs:/);
  assert.match(rendered, /server: netfs\.local/);
  assert.match(rendered, /path: \/exports\/polaris\/workspaces\/demo/);
});

test("kubevirt render bridges netfs workspace data through a PV and PVC", () => {
  const workspace = loadWorkspaceFromRefForTest("demo@kubevirt-vm");
  const outputPath = renderAndWriteKubevirtWorkspace(workspace);
  const rendered = fs.readFileSync(outputPath, "utf8");

  assert.match(rendered, /kind: PersistentVolume/);
  assert.match(
    rendered,
    new RegExp(`name: ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "workspace-data")}-pv`),
  );
  assert.match(rendered, /kind: PersistentVolumeClaim/);
  assert.match(
    rendered,
    new RegExp(`name: ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "workspace-data")}`),
  );
  assert.match(rendered, /server: netfs\.local/);
  assert.match(rendered, /path: \/exports\/polaris\/workspaces\/demo/);
  assert.match(rendered, new RegExp(`root:${kubevirtProbePassword(workspace)}`));
  assert.match(rendered, /mount -t virtiofs workspace-runtime-state \/mnt\/polaris-shared\/workspace-runtime-state/);
  assert.match(rendered, /polaris-sync-shared-state/);
  assert.match(
    rendered,
    /rsync -rl --delete --no-owner --no-group --no-perms --omit-dir-times --no-times/,
  );
  assert.doesNotMatch(rendered, /BEGIN OPENSSH PRIVATE KEY/);
  assert.doesNotMatch(rendered, /authorized_keys/);
  assert.doesNotMatch(rendered, /ssh-keygen -q -t ed25519/);
});

test("docker full bootstrap installs agent tooling on plain debian images", async () => {
  const project = uniqueProjectName("docker-full");
  await withTempWorkspaceSpec(project, "docker", async () => {
    const outputPath = workspaceConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
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

    const workspace = loadWorkspaceFromRefForTest(`${project}@docker`);
    const rendered = fs.readFileSync(renderAndWriteDockerWorkspace(workspace), "utf8");
    assert.match(
      rendered,
      /apt-get update && apt-get install -y openssh-client ca-certificates curl git nodejs npm procps python3 ripgrep neovim zsh tmux/,
    );
    assert.match(
      rendered,
      /npm_config_cache=\/tmp\/npm-cache npm install -g --prefix \/workspace\/state\/tooling\/polaris @openai\/codex @anthropic-ai\/claude-code @github\/copilot opencode-ai @earendil-works\/pi-coding-agent @fission-ai\/openspec@latest pnpm skills/,
    );
    assert.match(
      rendered,
      /npm_config_cache=\/tmp\/npm-cache npm install -g --prefix \/workspace\/state\/tooling\/polaris @getpaseo\/cli@latest/,
    );
    assert.match(rendered, /exec \/workspace\/state\/tooling\/polaris\/bin\/codex "\$\$@"/);
    assert.match(rendered, /exec \/workspace\/state\/tooling\/polaris\/bin\/claude "\$\$@"/);
    assert.match(rendered, /PASEO_HOME=\/root\/\.paseo paseo daemon start --listen 0\.0\.0\.0:6767/);
    assert.match(rendered, /paseo daemon status --json 2>\/dev\/null \|\| true/);
  });
});

test("pod backend returns structured observations", async () => {
  const workspace = loadDefaultDemoWorkspace();
  const driver = getBackendDriver("pod");
  await withFakeCommands(
    {
      kubectl: `
if [[ "$*" == *"get deployment ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '{"metadata":{"name":"${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
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
if [[ "$*" == *"get svc ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}'
  exit 0
fi
exit 0
`,
    },
    async () => {
      const observation = await driver.inspect(workspace);
      assert.equal(observation.backend.kind, "pod");
      assert.ok("workspaceData" in observation.attachments);
      assert.ok("projectRoot" in observation.workspaceAssembly);
      assert.ok("manager" in observation.daemon);
    },
  );
});

test("runtime controller computes degraded status and reconcile plan from observations when daemon is missing", async () => {
  cleanupSelectionFile("demo");
  const workspace = {
    ...loadDefaultDemoWorkspace(),
    backend: {
      kind: "pod",
      profile: "gvisor",
    },
    agent: {
      ...loadDefaultDemoWorkspace().agent,
      pairingFile: "/root/.paseo/pairing.json",
    },
  };
  const driver = getBackendDriver("pod");

  await withFakeCommands(
    {
      kubectl: `
if [[ "$*" == *"get deployment ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '{"metadata":{"name":"${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$*" == *"test -f /tmp/.ready && test -f /root/.paseo/pairing.json"* ]]; then
  exit 1
fi
if [[ "$1" == "-n" && "$4" == "exec" ]] || [[ "$*" == *" exec "* ]]; then
  exit 0
fi
if [[ "$*" == *"get svc ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}'
  exit 0
fi
exit 0
`,
    },
    async () => {
      const observation = await driver.inspect(workspace);
      const drift = computeWorkspaceDrift(workspace, observation);
      const status = synthesizeWorkspaceStatus(workspace, observation, drift);
      const plan = buildReconcilePlan(workspace, drift);

      assert.equal(status.driver?.selected?.backend, "pod");
      assert.equal(status.driver?.status, "running");
      assert.equal(status.paseo.daemon, "unknown");
      assert.equal(status.paseo.web, "unavailable");
      assert.match(status.driver?.reason || "", /workspace manager assembly missing|missing|service/i);
      assert.ok(plan.actions.length >= 1);
      assert.ok(plan.actions.some((action) => action.kind === "restart-runtime"));
      assert.equal(plan.requiresRestart, true);
    },
  );
  cleanupSelectionFile("demo");
});

test("status includes the daemon pairing URL when the runtime exposes one", async () => {
  cleanupSelectionFile("demo");
  cleanupStatusFile("demo");

  await withFakeCommands(
    {
      kubectl: `
if [[ "$*" == *"get deployment ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '{"metadata":{"name":"${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
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
if [[ "$*" == *"get svc ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}'
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
  await withTempWorkspaceSpec(project, "kubevirt-vm", async () => {
    await withFakeCommands(
      {
        kubectl: `
if [[ "$*" == *"get vm ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf '${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}'
  exit 0
fi
if [[ "$*" == *"get vmi ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf 'Running'
  exit 0
fi
if [[ "$*" == *"get svc ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf '${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}'
  exit 0
fi
if [[ "$*" == *"get secret ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm-cloudinit")}"* ]]; then
  printf '${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm-cloudinit")}'
  exit 0
fi
if [[ "$*" == *"port-forward svc/${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* && "$*" == *":22"* ]]; then
  printf 'Forwarding from 127.0.0.1:40022 -> 22\n'
  sleep 1
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
  printf 'workspaceDataObserved=1\nworkspaceRuntimeObserved=1\nuserIdentityObserved=1\nuserSshObserved=1\nhomeObserved=1\nprojectRootObserved=1\nmanagerStateObserved=1\nevolutionStateObserved=1\ncodexObserved=1\nclaudeObserved=1\nsshObserved=1\n'
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
      assert.equal(parsed.driver?.runtimeRef, `vm/${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}`);
      assert.equal(parsed.driver?.status, "running");
        assert.equal(parsed.paseo?.daemon, "pending");
        assert.equal(parsed.paseo?.web, "pairing-required");
      },
    );
  });
});

test("kubevirt render reuses persisted daemon pairing metadata", async () => {
  const project = uniqueProjectName("vm-pair-bootstrap");
  await withTempWorkspaceSpec(project, "kubevirt-vm", async () => {
    const workspace = loadWorkspaceFromRefForTest(`${project}@kubevirt-vm`);
    const rendered = renderKubevirtWorkspace(workspace);
    assert.doesNotMatch(rendered, /paseo daemon pair --json/);
    assert.match(rendered, /test -f \/root\/\.paseo\/pairing\.json/);
  });
});

test("CLI status defaults to the status command and persists ready pod status", async () => {
  cleanupSelectionFile("demo");
  cleanupStatusFile("demo");
  const expectedStatusFile = workspaceStatusPath("demo", DEMO_USER_PROFILE_ID);

  await withFakeCommands(
    {
      kubectl: `
if [[ "$*" == *"get deployment ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '{"metadata":{"name":"${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
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
if [[ "$*" == *"get svc ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}'
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
      assert.equal(parsed.driver?.baseImage, "ttl.sh/polaris-demo-debian13-1782126452:24h");
      assert.equal(parsed.driver?.status, "running");
      assert.equal(parsed.paseo.daemon, "pending");
      assert.equal(parsed.paseo.web, "pairing-required");
      assert.ok(parsed.evolution);
    },
  );

  cleanupStatusFile("demo");
  cleanupSelectionFile("demo");
});

test("status stays not-ready when no active codex credential is selected and persisted Paseo metadata is missing", () => {
  const base = loadDefaultDemoWorkspace();
  const paseoStateRoot = workspacePaseoStateDir(
    base.identity.projectName,
    base.userProfile.id,
  );
  fs.rmSync(paseoStateRoot, { recursive: true, force: true });
  const workspace = {
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
      kind: workspace.backend.kind,
      exists: true,
      running: true,
      detail: "pod/pod-1",
    },
    attachments: {
      workspaceData: { observed: true, detail: workspace.attachments.workspaceData.mountRoot },
      workspaceRuntimeState: { observed: true, detail: workspace.attachments.workspaceRuntimeState.mountRoot },
      userIdentityState: { observed: true, detail: workspace.attachments.userIdentityState.mountRoot },
    },
    workspaceAssembly: {
      home: { observed: true, detail: workspace.runtime.home },
      projectRoot: { observed: true, detail: `${workspace.runtime.home}/workspace` },
      managerState: { observed: true, detail: workspace.agent.runtime.stateRoot },
      evolutionState: { observed: true, detail: workspace.agent.runtime.evolutionRoot },
      codex: { observed: false, detail: `${workspace.runtime.home}/.codex` },
      claude: { observed: false, detail: `${workspace.runtime.home}/.claude` },
      ssh: { observed: true, detail: `${workspace.runtime.home}/.ssh` },
    },
    daemon: {
      manager: { observed: true, detail: workspace.agent.runtime.readyFile ?? "/tmp/.ready" },
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

  const drift = computeWorkspaceDrift(workspace, observation);
  const status = synthesizeWorkspaceStatus(workspace, observation, drift);

  assert.equal(drift.hasWarnings, true);
  assert.match(
    drift.items.map((item) => item.message).join("\n"),
    /persisted Paseo (server-id|pairing metadata) is missing/,
  );
  assert.equal(status.driver?.status, "running");
  assert.equal(status.paseo.daemon, "unknown");
  assert.equal(status.paseo.web, "unavailable");
  assert.equal(status.credentials?.codex?.state, "not-selected");
  assert.equal(status.workspaceAssembly?.codex?.state, "unknown");
});

test("status is not ready until persisted Paseo metadata exists on the host state root", () => {
  const workspace = loadDefaultDemoWorkspace();
  const paseoStateRoot = workspacePaseoStateDir(
    workspace.identity.projectName,
    workspace.userProfile.id,
  );
  fs.rmSync(paseoStateRoot, { recursive: true, force: true });

  const observation = {
    backend: {
      kind: workspace.backend.kind,
      exists: true,
      running: true,
      detail: "pod/pod-1",
    },
    attachments: {
      workspaceData: { observed: true, detail: workspace.attachments.workspaceData.mountRoot },
      workspaceRuntimeState: { observed: true, detail: workspace.attachments.workspaceRuntimeState.mountRoot },
      userIdentityState: { observed: true, detail: workspace.attachments.userIdentityState.mountRoot },
    },
    workspaceAssembly: {
      home: { observed: true, detail: workspace.runtime.home },
      projectRoot: { observed: true, detail: `${workspace.runtime.home}/workspace` },
      managerState: { observed: true, detail: workspace.agent.runtime.stateRoot },
      evolutionState: { observed: true, detail: workspace.agent.runtime.evolutionRoot },
      codex: { observed: true, detail: `${workspace.runtime.home}/.codex` },
      claude: { observed: true, detail: `${workspace.runtime.home}/.claude` },
      ssh: { observed: true, detail: `${workspace.runtime.home}/.ssh` },
    },
    daemon: {
      manager: { observed: true, detail: workspace.agent.runtime.readyFile ?? "/tmp/.ready" },
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

  const drift = computeWorkspaceDrift(workspace, observation);
  const status = synthesizeWorkspaceStatus(workspace, observation, drift);

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

  await withTempWorkspaceSpec(project, "docker", async () => {
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
      writeWorkspaceLiveCredentialSelection(
        project,
        "claude",
        "claude-status-live",
        DEMO_USER_PROFILE_ID,
      );

      const workspace = loadWorkspaceFromRefForTest(`${project}@docker`);
      const observation = {
        backend: {
          kind: workspace.backend.kind,
          exists: true,
          running: true,
          detail: "container/docker-status-live",
        },
        attachments: {
          workspaceData: { observed: true, detail: workspace.attachments.workspaceData.mountRoot },
          workspaceRuntimeState: { observed: true, detail: workspace.attachments.workspaceRuntimeState.mountRoot },
          userIdentityState: { observed: true, detail: workspace.attachments.userIdentityState.mountRoot },
        },
        workspaceAssembly: {
          home: { observed: true, detail: workspace.runtime.home },
          projectRoot: { observed: true, detail: `${workspace.runtime.home}/workspace` },
          managerState: { observed: true, detail: workspace.agent.runtime.stateRoot },
          evolutionState: { observed: true, detail: workspace.agent.runtime.evolutionRoot },
          codex: { observed: true, detail: `${workspace.runtime.home}/.codex` },
          claude: { observed: true, detail: `${workspace.runtime.home}/.claude` },
          ssh: { observed: true, detail: `${workspace.runtime.home}/.ssh` },
        },
        daemon: {
          manager: { observed: true, detail: workspace.agent.runtime.readyFile ?? "/tmp/.ready" },
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

      const drift = computeWorkspaceDrift(workspace, observation);
      const status = synthesizeWorkspaceStatus(workspace, observation, drift);
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
  cleanupSelectionFile("demo");
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
  cleanupSelectionFile("demo");
});

test("CLI docker lifecycle commands dispatch through compose and status artifacts", async () => {
  const project = uniqueProjectName("docker-lifecycle");
  const previousExportRoot = process.env.POLARIS_NETFS_LOCAL_EXPORT_ROOT;
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-cli-lifecycle-"));
  await withTempWorkspaceSpec(project, "docker", async () => {
    const dockerPath = workspaceConfigPath(project, "docker", DEMO_USER_PROFILE_ID);
    const doc = (yaml.load(fs.readFileSync(dockerPath, "utf8")) ?? {}) as Record<string, any>;
    doc.attachments["workspace-data"].source.export_path = exportRoot;
    fs.writeFileSync(dockerPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
    try {
      process.env.POLARIS_NETFS_LOCAL_EXPORT_ROOT = exportRoot;
      await withFakeCommands(
        {
        docker: `
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
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
          assert.ok(commands.some((entry) => entry.includes(`/workspaces/${project}/generated/docker.yaml`) && entry.includes("up -d")));
          assert.ok(commands.some((entry) => entry.includes(`/workspaces/${project}/generated/docker.yaml`) && entry.includes("stop")));
          assert.ok(commands.some((entry) => entry.includes(`/workspaces/${project}/generated/docker.yaml`) && entry.includes("restart")));
          assert.ok(commands.some((entry) => entry.includes(`/workspaces/${project}/generated/docker.yaml`) && entry.includes("up -d --force-recreate")));

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

test("switch migrates only small durable attachments when workspace-data is netfs", async () => {
  const project = uniqueProjectName("switch-netfs");
  const dockerStateFile = path.join(os.tmpdir(), `${project}-docker.state`);
  cleanupSelectionFile(project);

  await withTempWorkspaceSpec(project, "docker", async () => {
    const podPath = workspaceConfigPath(project, "pod", DEMO_USER_PROFILE_ID);
    try {
      ensureWorkspaceConfig(`${project}@pod:gvisor`);
      writeWorkspaceDriverSelection(
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
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
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
if [[ "$*" == *"get deployment ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf '{"metadata":{"name":"${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$*" == *"get svc ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf '${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}'
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
if [[ "$*" == *"scale deployment ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)} --replicas=0"* ]]; then
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
          assert.ok(commands.some((entry) => entry.includes("cp docker-id:/workspace/state/paseo/.")));
          assert.ok(commands.some((entry) => entry.includes("cp docker-id:/identity/codex/.")));
          assert.ok(commands.some((entry) => entry.includes("cp docker-id:/identity/claude/.")));
          assert.ok(commands.some((entry) => entry.includes("cp docker-id:/identity/ssh/.")));
          assert.equal(
            commands.some((entry) => entry.includes("/workspace/project/.")),
            false,
          );
        },
      );
    } finally {
      cleanupSelectionFile(project);
      fs.rmSync(podPath, { force: true });
      fs.rmSync(dockerStateFile, { force: true });
    }
  });
});

test("switch exports durable state from the actually running backend when selection is stale", async () => {
  const project = uniqueProjectName("switch-stale-selection");
  const dockerStateFile = path.join(os.tmpdir(), `${project}-docker.state`);
  cleanupSelectionFile(project);

  await withTempWorkspaceSpec(project, "docker", async () => {
    const podPath = workspaceConfigPath(project, "pod", DEMO_USER_PROFILE_ID);
    const vmPath = workspaceConfigPath(project, "kubevirt-vm", DEMO_USER_PROFILE_ID);
    try {
      ensureWorkspaceConfig(`${project}@pod:gvisor`);
      ensureWorkspaceConfig(`${project}@kubevirt-vm`);
      writeWorkspaceDriverSelection(
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
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
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
if [[ "$*" == *"get vm ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf '${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}'
  exit 0
fi
if [[ "$*" == *"get vmi ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf 'Succeeded'
  exit 0
fi
if [[ "$*" == *"apply -f "* ]]; then
  exit 0
fi
if [[ "$*" == *"get deployment ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf '{"metadata":{"name":"${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$*" == *"get svc ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf '${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}'
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
if [[ "$*" == *"scale deployment ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)} --replicas=0"* ]]; then
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
          assert.ok(commands.some((entry) => entry.includes("cp docker-id:/workspace/state/paseo/.")));
          assert.ok(commands.some((entry) => entry.includes("cp docker-id:/identity/codex/.")));
          assert.ok(commands.some((entry) => entry.includes("cp docker-id:/identity/claude/.")));
          assert.ok(commands.some((entry) => entry.includes("cp docker-id:/identity/ssh/.")));
        },
      );
    } finally {
      cleanupSelectionFile(project);
      fs.rmSync(podPath, { force: true });
      fs.rmSync(vmPath, { force: true });
      fs.rmSync(dockerStateFile, { force: true });
    }
  });
});

test("switch imports runtime state into kubevirt before first boot without a restart sync-out", async () => {
  const project = uniqueProjectName("switch-vm-serverid");
  const dockerStateFile = path.join(os.tmpdir(), `${project}-docker.state`);
  cleanupSelectionFile(project);

  await withTempWorkspaceSpec(project, "docker", async () => {
    const vmPath = workspaceConfigPath(project, "kubevirt-vm", DEMO_USER_PROFILE_ID);
    try {
      ensureWorkspaceConfig(`${project}@kubevirt-vm`);
      writeWorkspaceDriverSelection(
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
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
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
if [[ "$*" == *"wait --for=condition=Ready pod/${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-import")}"* ]]; then
  exit 0
fi
if [[ "$*" == *"delete pod ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-import")}"* ]]; then
  exit 0
fi
if [[ "$*" == *"wait --for=delete pod/${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-import")}"* ]]; then
  exit 0
fi
if [[ "$*" == *"get vm ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf '${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}'
  exit 0
fi
if [[ "$*" == *"get vmi ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf 'Running'
  exit 0
fi
if [[ "$*" == *"get svc ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf '${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}'
  exit 0
fi
if [[ "$*" == *"get secret ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm-cloudinit")}"* ]]; then
  printf '${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm-cloudinit")}'
  exit 0
fi
if [[ "$*" == *"port-forward svc/${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* && "$*" == *":22"* ]]; then
  printf 'Forwarding from 127.0.0.1:40022 -> 22\n'
  sleep 1
  exit 0
fi
if [[ "$*" == *"patch vm ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  exit 0
fi
if [[ "$1" == "-n" && ( "$3" == "exec" || "$3" == "cp" ) ]] || [[ "$1" == "exec" ]] || [[ "$1" == "cp" ]]; then
  exit 0
fi
exit 0
`,
          sshpass: `
if [[ "$*" == *" bash -lc "* && "$*" == *" true"* ]]; then
  exit 0
fi
if [[ "$*" == *"systemctl restart polaris-runtime-bootstrap.service"* ]]; then
  printf 'active\n'
  exit 0
fi
if [[ "$*" == *"guestReachable=1"* ]]; then
  printf 'guestReachable=1\n'
  printf 'daemonStatusRaw<<EOF\n{"serverId":"srv_switch","localDaemon":"running","connectedDaemon":"reachable"}\nEOF\n'
  printf 'persistedServerId<<EOF\nsrv_switch\nEOF\n'
  printf 'pairingRaw<<EOF\n{"url":"https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9zd2l0Y2gifQ"}\nEOF\n'
  printf 'workspaceDataObserved=1\nworkspaceRuntimeObserved=1\nuserIdentityObserved=1\nuserSshObserved=1\nhomeObserved=1\nprojectRootObserved=1\nmanagerStateObserved=1\nevolutionStateObserved=1\ncodexObserved=1\nclaudeObserved=1\nsshObserved=1\n'
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
              ? entry.includes(`cp`) && entry.includes(`${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-import")}:/root/.paseo`)
              : false,
          );
          const generatedApplyIndex = commands.findIndex((entry) =>
            entry.includes(`/workspaces/${project}/generated/kubevirt.yaml`) && entry.includes("apply -f"),
          );
          assert.equal(
            commands.some((entry) => entry.includes(`patch vm ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}`) && entry.includes(`"runStrategy":"Halted"`)),
            false,
          );
          assert.ok(
            commands.some((entry) => entry.includes(workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-import")) && entry.includes("cp")),
          );
          assert.ok(
            commands.some((entry) => entry.includes(`delete pod ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-import")} --ignore-not-found --wait=false`)),
          );
          assert.ok(generatedApplyIndex >= 0);
          const firstPvcImportCommand = commands.findIndex((entry) =>
            entry.includes(workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-import")) && entry.includes("cp"),
          );
          assert.ok(firstPvcImportCommand >= 0);
          assert.ok(firstPvcImportCommand < generatedApplyIndex);
          void pvcImportCopyIndex;
        },
      );
    } finally {
      cleanupSelectionFile(project);
      fs.rmSync(vmPath, { force: true });
      fs.rmSync(dockerStateFile, { force: true });
    }
  });
});

test("switch keeps the previous selection when the target backend start fails", async () => {
  const project = uniqueProjectName("switch-selection-failure");
  const dockerStateFile = path.join(os.tmpdir(), `${project}-docker.state`);
  cleanupSelectionFile(project);

  await withTempWorkspaceSpec(project, "docker", async () => {
    const podPath = workspaceConfigPath(project, "pod", DEMO_USER_PROFILE_ID);
    try {
      ensureWorkspaceConfig(`${project}@pod`);
      writeWorkspaceDriverSelection(
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
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
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
if [[ "$*" == *"get deployment ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "workspace-data-export")}"* ]]; then
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

      const statusPath = workspaceStatusPath(project, DEMO_USER_PROFILE_ID);
      const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8")) as {
        driver?: { selected?: { backend?: string; profile?: string } };
      };
      assert.equal(parsed.driver?.selected?.backend, "docker");
      assert.equal(parsed.driver?.selected?.profile, undefined);
    } finally {
      cleanupSelectionFile(project);
      fs.rmSync(podPath, { force: true });
      fs.rmSync(dockerStateFile, { force: true });
    }
  });
});

test("switch exports from the selected kubevirt pvc even when the vm is already stopped", async () => {
  const project = uniqueProjectName("switch-stopped-vm-source");
  cleanupSelectionFile(project);

  await withTempWorkspaceSpec(project, "docker", async () => {
    const vmPath = workspaceConfigPath(project, "kubevirt-vm", DEMO_USER_PROFILE_ID);
    try {
      ensureWorkspaceConfig(`${project}@kubevirt-vm`);
      writeWorkspaceDriverSelection(
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
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
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
if [[ "$*" == *"get deployment ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "workspace-data-export")}"* ]]; then
  exit 1
fi
if [[ "$*" == *"get vm ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf '${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}'
  exit 0
fi
if [[ "$*" == *"get vmi ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf ''
  exit 0
fi
if [[ "$*" == *"apply -f "* && "$*" == *"pvc-export.yaml"* ]]; then
  exit 0
fi
if [[ "$*" == *"wait --for=condition=Ready pod/${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-export")}"* ]]; then
  exit 0
fi
if [[ "$*" == *"delete pod ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-export")}"* ]]; then
  exit 0
fi
if [[ "$*" == *"wait --for=delete pod/${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-export")}"* ]]; then
  exit 0
fi
if [[ "$1" == "-n" && "$3" == "cp" ]] || [[ "$1" == "cp" ]]; then
  exit 0
fi
if [[ "$*" == *"patch vm ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
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
            entry.includes(workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-export")) && entry.includes(" cp "),
          );
          const dockerUpIndex = commands.findIndex((entry) =>
            entry.includes("docker") && entry.includes("compose") && entry.includes("up -d"),
          );

          assert.ok(pvcExportIndex >= 0);
          assert.ok(dockerUpIndex >= 0);
          assert.ok(pvcExportIndex < dockerUpIndex);
          assert.ok(
            commands.some((entry) => entry.includes(`delete pod ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "pvc-export")} --ignore-not-found --wait=false`)),
          );
          assert.equal(
            commands.some((entry) => entry.includes(`patch vm ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}`)),
            false,
          );
        },
      );
    } finally {
      cleanupSelectionFile(project);
      fs.rmSync(vmPath, { force: true });
    }
  });
});

test("kubevirt backend returns structured observations and current status semantics stay ready only when cloud-init is present", async () => {
  const project = uniqueProjectName("vm-status");

  await withTempWorkspaceSpec(project, "kubevirt-vm", async () => {
    const workspace = loadWorkspaceFromRefForTest(project);
    const driver = getBackendDriver("kubevirt-vm");

    await withFakeCommands(
      {
        kubectl: `
if [[ "$*" == *"get vm ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf '${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}'
  exit 0
fi
if [[ "$*" == *"get vmi ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf 'Running'
  exit 0
fi
if [[ "$*" == *"get svc ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf '${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}'
  exit 0
fi
if [[ "$*" == *"get secret ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm-cloudinit")}"* ]]; then
  printf '${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm-cloudinit")}'
  exit 0
fi
if [[ "$*" == *"port-forward svc/${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)} "* && "$*" == *":22"* ]]; then
  printf 'Forwarding from 127.0.0.1:40022 -> 22\n'
  sleep 1
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
  printf 'workspaceDataObserved=1\nworkspaceRuntimeObserved=1\nuserIdentityObserved=1\nuserSshObserved=1\nhomeObserved=1\nprojectRootObserved=1\nmanagerStateObserved=1\nevolutionStateObserved=1\ncodexObserved=1\nclaudeObserved=1\nsshObserved=1\n'
  exit 0
fi
exit 1
`,
      },
      async () => {
        const observation = await driver.inspect(workspace);
        assert.equal(observation.backend.exists, true);
        assert.equal(observation.backend.running, true);

        const drift = computeWorkspaceDrift(workspace, observation);
        const status = synthesizeWorkspaceStatus(workspace, observation, drift);
        assert.equal(status.driver?.selected?.backend, "kubevirt-vm");
        assert.equal(status.driver?.status, "running");

        const plan = { project, backend: "kubevirt-vm", safe: true, requiresRestart: false, destructive: false, actions: [{ kind: "render" }, { kind: "apply" }] as any[] };
        await driver.executeReconcilePlan(workspace, plan as any);
      },
    );
  });
});

test("CLI status and logs cover docker backend through fake docker compose", async () => {
  const project = uniqueProjectName("docker-status");

  await withTempWorkspaceSpec(project, "docker", async () => {
    await withFakeCommands(
      {
        docker: `
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
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
if [[ "$*" == *"logs --tail 200 ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
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
        assert.equal(parsed.driver?.baseImage, loadWorkspaceFromRefForTest(`${project}@docker`).runtime.baseImage);
        assert.equal(parsed.driver?.runtimeKind, "docker-container");
        assert.equal(parsed.driver?.runtimeRef, `container/${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}-docker`);
        assert.equal(parsed.driver?.status, "running");
        assert.equal(parsed.assets.dockerfile.file, "workspace-prebuilt.Dockerfile");
        assert.equal(parsed.assets.dockerfile.path, "config/users/100000000000000001/docker/workspace-prebuilt.Dockerfile");
        assert.deepEqual(parsed.assets.specs.map((item) => item.driver), ["docker", "pod", "kubevirt-vm"]);
        assert.deepEqual(parsed.assets.generatedManifests.map((item) => item.file), ["docker.yaml", "pod.yaml", "kubevirt.yaml"]);
        assert.equal(parsed.assets.imageTags.find((item) => item.name === "workspace")?.tag, workspaceImageRef(DEMO_USER_PROFILE_ID, project));
        assert.ok(parsed.assets.persistentVolumes.some((item) => item.name === "workspace-data" && item.mountRoot === "/workspace/project"));
        assert.deepEqual(
          parsed.assets.persistentVolumes.map((item) => item.name).sort(),
          ["workspace-data", "workspace-runtime-state"],
        );

        await runCli(["logs", project]);
        const commands = readCommandLog();
        assert.ok(commands.some((entry) => entry.includes(`compose`) && entry.includes(`ps -q ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}`)));
        assert.ok(commands.some((entry) => entry.includes(`logs --tail 200 ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}`)));
      },
    );
  });
});

test("CLI status and logs cover kubevirt backend through fake kubectl", async () => {
  const project = uniqueProjectName("vm-cli");

  await withTempWorkspaceSpec(project, "kubevirt-vm", async () => {
    await withFakeCommands(
      {
        kubectl: `
if [[ "$*" == *"get vm ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf '${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}'
  exit 0
fi
if [[ "$*" == *"get vmi ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
  printf 'Running'
  exit 0
fi
if [[ "$*" == *"get svc ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}"* ]]; then
  printf '${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)}'
  exit 0
fi
if [[ "$*" == *"get secret ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm-cloudinit")}"* ]]; then
  printf '${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm-cloudinit")}'
  exit 0
fi
if [[ "$*" == *"port-forward svc/${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, project)} "* && "$*" == *":22"* ]]; then
  printf 'Forwarding from 127.0.0.1:40022 -> 22\n'
  sleep 1
  exit 0
fi
if [[ "$1" == "-n" && "$3" == "get" && "$4" == "pod" && "$*" == *"vm.kubevirt.io/name=${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}"* ]]; then
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
  printf 'workspaceDataObserved=1\nworkspaceRuntimeObserved=1\nuserIdentityObserved=1\nuserSshObserved=1\nhomeObserved=1\nprojectRootObserved=1\nmanagerStateObserved=1\nevolutionStateObserved=1\ncodexObserved=1\nclaudeObserved=1\nsshObserved=1\n'
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
        assert.equal(parsed.driver?.runtimeRef, `vm/${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}`);
        assert.equal(parsed.driver?.status, "running");
        assert.ok(["pending", "ready"].includes(parsed.paseo.daemon));

        await runCli(["logs", project]);
        const commands = readCommandLog();
        assert.ok(commands.some((entry) => entry.includes(`get pod -l vm.kubevirt.io/name=${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, project, "vm")}`)));
        assert.ok(commands.some((entry) => entry.includes("logs virt-launcher-0 --tail=200")));
      },
    );
  });
});

test("kubevirt lifecycle actions use kubectl virt and apply", async () => {
  const workspace = loadWorkspaceFromRefForTest("demo@kubevirt-vm");
  const driver = getBackendDriver("kubevirt-vm");

  await withFakeCommands(
    {
      kubectl: `
exit 0
`,
    },
    async () => {
      await driver.apply(workspace);
      await driver.start(workspace);
      await driver.stop(workspace);
      await driver.restart(workspace);
    },
  );
});

test("docker backend returns structured observations and executes compose actions", async () => {
  const base = loadDefaultDemoWorkspace();
  const workspace = {
    ...base,
    backend: {
      ...base.backend,
      kind: "docker" as const,
      profile: "docker",
      dockerRuntimeMode: "legacy" as const,
    },
    attachments: {
      ...base.attachments,
      workspaceData: {
        ...base.attachments.workspaceData,
        source: {
          kind: "persistent-volume" as const,
          volumeRef: "demo-workspace-data",
          description: "test workspace data volume",
        },
      },
    },
  };
  const driver = getBackendDriver("docker");

  await withFakeCommands(
    {
      docker: `
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
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
      const observation = await driver.inspect(workspace);
      assert.equal(observation.backend.exists, true);
      assert.equal(observation.backend.running, true);
      const drift = computeWorkspaceDrift(workspace, observation);
      const status = synthesizeWorkspaceStatus(workspace, observation, drift);
      assert.equal(status.driver?.selected?.backend, "docker");

      const plan = { project: "demo", backend: "docker", safe: true, requiresRestart: false, destructive: false, actions: [{ kind: "render" }, { kind: "apply" }] as any[] };
      await driver.executeReconcilePlan(workspace, plan as any);
    },
  );
});

test("docker lifecycle actions execute through docker compose", async () => {
  const base = loadDefaultDemoWorkspace();
  const previousExportRoot = process.env.POLARIS_NETFS_LOCAL_EXPORT_ROOT;
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-docker-actions-"));
  const workspace = {
    ...base,
    backend: {
      ...base.backend,
      kind: "docker" as const,
      profile: "docker",
      dockerRuntimeMode: "legacy" as const,
    },
    attachments: {
      ...base.attachments,
      workspaceData: {
        ...base.attachments.workspaceData,
        source: {
          ...base.attachments.workspaceData.source,
          exportPath: exportRoot,
        },
      },
    },
  };
  const driver = getBackendDriver("docker");
  const dockerPath = workspaceConfigPath("demo", "docker", DEMO_USER_PROFILE_ID);
  const originalDockerDoc = fs.readFileSync(dockerPath, "utf8");
  const dockerDoc = (yaml.load(originalDockerDoc) ?? {}) as Record<string, any>;
  dockerDoc.attachments["workspace-data"].source.export_path = exportRoot;
  fs.writeFileSync(dockerPath, yaml.dump(dockerDoc, { lineWidth: 120, noRefs: true }), "utf8");

  try {
    process.env.POLARIS_NETFS_LOCAL_EXPORT_ROOT = exportRoot;
    await withFakeCommands(
      {
      docker: `
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
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
        await driver.render(workspace);
        await driver.apply(workspace);
        await driver.start(workspace);
        await driver.stop(workspace);
        await driver.restart(workspace);
        await driver.rebuild(workspace);
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
  const base = loadDefaultDemoWorkspace();
  const workspace = {
    ...base,
    backend: {
      ...base.backend,
      kind: "docker" as const,
      profile: "docker",
      dockerRuntimeMode: "legacy" as const,
    },
    attachments: {
      ...base.attachments,
      workspaceData: {
        ...base.attachments.workspaceData,
        source: {
          kind: "persistent-volume" as const,
          volumeRef: "demo-workspace-data",
          description: "test workspace data volume",
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
      await driver.start(workspace);
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
