import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { loadWorkspaceFromConfigPath, resolveWorkspaceConfigPath } from "../scripts/config/load.js";
import { ensureCanonicalWorkspaceImage, ensureWorkspaceConfig } from "../scripts/config/provision.js";
import { assertNoProjectNameCollision } from "../scripts/config/project-ownership.js";
import { getBackendDriver } from "../scripts/backends/index.js";
import { syncWorkspaceDockerfileTemplate, workspaceConfigPath, workspaceImageRef } from "../scripts/config/scaffold.js";
import { EvolutionStore } from "../scripts/evolution/store.js";
import { generatedOutputPath } from "../scripts/output/write-generated.js";
import {
  workspaceEvolutionStateDir,
  workspaceLiveCredentialsPath,
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
import { buildReconcilePlan, computeWorkspaceDrift, synthesizeWorkspaceStatus } from "../scripts/core/runtime-controller.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const STDOUT_CAPTURE_QUEUE_KEY = "__polaris_stdout_capture_queue__";
const DEMO_USER_PROFILE_ID = "100000000000000001";

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
  assert.ok(workspace.userProfile.workspaces.includes("demo"));
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

test("runCli user delete removes the user profile, secrets root, and Clerk mapping", async () => {
  const userProfileId = uniqueProjectName("cli-user-delete");
  const clerkUsername = `${userProfileId}-clerk`;
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const userMapPath = path.join(REPO_ROOT, "config", "user-map.json");
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
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
    if (originalUserMap === null) {
      fs.rmSync(userMapPath, { force: true });
    } else {
      fs.writeFileSync(userMapPath, originalUserMap, "utf8");
    }
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
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
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
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${project}"* ]]; then
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
    project,
    backend: { kind: "pod", profile: "gvisor" },
    lifecycleAction: "status",
    state: "saved",
    health: {
      backendLiveness: "unknown",
      workspaceReadiness: "unknown",
      daemonReadiness: "expected",
    },
    details: {
      driver: "pod",
    },
  }, DEMO_USER_PROFILE_ID);

  assert.ok(fs.existsSync(statusPath));
  const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8")) as { project: string; backend: { kind: string } };
  assert.equal(parsed.project, project);
  assert.equal(parsed.backend.kind, "pod");

  cleanupStatusFile(project);
});

test("driver selection persists a default backend control", () => {
  const project = uniqueProjectName("driver-selection");
  const selectionPath = writeWorkspaceDriverSelection(
    project,
    { backend: "pod", profile: "gvisor" },
    DEMO_USER_PROFILE_ID,
  );
  assert.equal(fs.existsSync(selectionPath), true);
  const parsed = JSON.parse(fs.readFileSync(selectionPath, "utf8")) as { backend: string; profile?: string };
  assert.equal(parsed.backend, "pod");
  assert.equal(parsed.profile, "gvisor");
  cleanupSelectionFile(project);
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
    assert.equal(podDoc.attachments["workspace-data"].source.export_path, "/exports/polaris/workspaces");
    assert.equal(podDoc.attachments["workspace-data"].source.sub_path, project);
    assert.equal(
      podDoc.attachments["workspace-runtime-state"].source.volume_ref,
      `${project}-workspace-runtime-state`,
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
exit 0
`,
      },
      async ({ readCommandLog }) => {
        ensureCanonicalWorkspaceImage(`${project}@docker`);
        assert.deepEqual(readCommandLog(), [
          `build -f ${path.join(REPO_ROOT, "config", "users", DEMO_USER_PROFILE_ID, "docker", "workspace-prebuilt.Dockerfile")} -t ${imageRef} .`,
        ]);
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

test("syncWorkspaceDockerfileTemplate refreshes a stale user Dockerfile from the demo template", () => {
  const userProfileId = uniqueProjectName("dockerfile-sync");
  const userDockerfile = path.join(REPO_ROOT, "config", "users", userProfileId, "docker", "workspace-prebuilt.Dockerfile");
  const templateDockerfile = path.join(
    REPO_ROOT,
    "config",
    "users",
    DEMO_USER_PROFILE_ID,
    "docker",
    "workspace-prebuilt.Dockerfile",
  );
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

test("ensureCanonicalWorkspaceImage rebuilds when the user Dockerfile is refreshed from the template", async () => {
  const userProfileId = uniqueProjectName("dockerfile-rebuild");
  const project = uniqueProjectName("image-refresh");
  const imageRef = workspaceImageRef(userProfileId, project);
  const dockerPath = workspaceConfigPath(project, "docker", userProfileId);
  const userDockerfile = path.join(REPO_ROOT, "config", "users", userProfileId, "docker", "workspace-prebuilt.Dockerfile");
  const templateDockerfile = path.join(
    REPO_ROOT,
    "config",
    "users",
    DEMO_USER_PROFILE_ID,
    "docker",
    "workspace-prebuilt.Dockerfile",
  );
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
exit 0
`,
      },
      async ({ readCommandLog }) => {
        ensureCanonicalWorkspaceImage(`${project}@docker`);
        assert.deepEqual(readCommandLog(), [
          `build -f ${userDockerfile} -t ${imageRef} .`,
        ]);
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
    path.join(REPO_ROOT, "config", "users", DEMO_USER_PROFILE_ID, "docker", "workspace-prebuilt.Dockerfile"),
    userDockerfile,
  );

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
exit 0
`,
      },
      async ({ readCommandLog }) => {
        ensureCanonicalWorkspaceImage(`${project}@docker`);
        assert.deepEqual(readCommandLog(), [
          `build -f ${userDockerfile} -t ${imageRef} .`,
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
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${project}"* ]]; then
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

test("status exposes ssh self-check for github account on managed-key profiles", async () => {
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

      await withFakeCommands(
        {
          docker: `
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${project}"* ]]; then
  printf 'abc123'
  exit 0
fi
if [[ "$*" == *"inspect abc123"* ]]; then
  printf '[{"State":{"Running":true}}]'
  exit 0
fi
if [[ "$*" == *"successfully authenticated"* ]]; then
  exit 0
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
          const parsed = parseJsonOutput<{ ssh?: { mode: string; githubAccount?: string; selfCheck?: { state: string; message: string } } }>(output);
          assert.equal(parsed.ssh?.mode, "managed-key");
          assert.equal(parsed.ssh?.githubAccount, "example-account");
          assert.equal(parsed.ssh?.selfCheck?.state, "ready");
          assert.match(parsed.ssh?.selfCheck?.message || "", /authentication is working/i);
        },
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
  assert.match(rendered, new RegExp(`polaris-${escapedId}-ssh`));
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

  assert.equal(dockerWorkspace.attachments.workspaceData.source.volumeRef, "demo-workspace-data");
  assert.equal(dockerWorkspace.attachments.workspaceData.source.kind, "netfs");
  assert.equal(podWorkspace.attachments.workspaceData.source.kind, "netfs");
  assert.equal(kubevirtWorkspace.attachments.workspaceData.source.kind, "netfs");
  assert.equal(
    podWorkspace.attachments.workspaceRuntimeState.source.volumeRef,
    "demo-workspace-runtime-state",
  );
  assert.equal(
    kubevirtWorkspace.attachments.workspaceRuntimeState.source.volumeRef,
    "demo-workspace-runtime-state",
  );
});

test("docker render uses stable named volumes for reusable demo attachments", () => {
  const workspace = loadWorkspaceFromRefForTest("demo@docker");
  const outputPath = renderAndWriteDockerWorkspace(workspace);
  const rendered = fs.readFileSync(outputPath, "utf8");

  assert.match(rendered, /source: demo-workspace-data\b/);
  assert.match(rendered, /source: demo-project-state\b/);
  assert.match(rendered, /driver_opts:\n      type: "nfs"/);
  assert.match(rendered, /o: "addr=127\.0\.0\.1,nfsvers=4\.1,hard,rw"/);
  assert.match(rendered, /device: ":\/"/);
  assert.match(rendered, /demo-workspace-data:\n    name: demo-workspace-data/);
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
  assert.match(rendered, /name: demo-workspace-data-pv/);
  assert.match(rendered, /kind: PersistentVolumeClaim/);
  assert.match(rendered, /name: demo-workspace-data/);
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
    assert.match(rendered, /apt-get update && apt-get install -y openssh-client ca-certificates curl git nodejs npm procps python3 neovim zsh tmux/);
    assert.match(rendered, /npm install -g --prefix \/root\/\.local\/polaris @getpaseo\/cli@latest @openai\/codex @anthropic-ai\/claude-code @fission-ai\/openspec@latest pnpm/);
    assert.match(rendered, /exec \/root\/\.local\/polaris\/bin\/codex "\$@"/);
    assert.match(rendered, /exec \/root\/\.local\/polaris\/bin\/claude "\$@"/);
    assert.match(rendered, /PASEO_HOME=\/root\/\.paseo paseo daemon start --listen 0\.0\.0\.0:6767/);
  });
});

test("pod backend returns structured observations", async () => {
  const workspace = loadDefaultDemoWorkspace();
  const driver = getBackendDriver("pod");
  await withFakeCommands(
    {
      kubectl: `
if [[ "$*" == *"get deployment demo"* ]]; then
  printf '{"metadata":{"name":"demo"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=demo"* ]]; then
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
if [[ "$*" == *"get svc demo"* ]]; then
  printf 'demo'
  exit 0
fi
exit 0
`,
    },
    async () => {
      const observation = await driver.inspect(workspace);
      assert.equal(observation.backend.kind, "pod");
      assert.ok("workspaceData" in observation.attachments);
      assert.ok("projectRoot" in observation.runtimeAssembly);
      assert.ok("manager" in observation.daemon);
    },
  );
});

test("runtime controller computes degraded status and reconcile plan from observations when daemon is missing", async () => {
  cleanupSelectionFile("demo");
  const workspace = {
    ...loadDefaultDemoWorkspace(),
    agent: {
      ...loadDefaultDemoWorkspace().agent,
      pairingFile: "/root/.paseo/pairing.json",
    },
  };
  const driver = getBackendDriver("pod");

  await withFakeCommands(
    {
      kubectl: `
if [[ "$*" == *"get deployment demo"* ]]; then
  printf '{"metadata":{"name":"demo"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=demo"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$*" == *"test -f /tmp/.ready && test -f /root/.paseo/pairing.json"* ]]; then
  exit 1
fi
if [[ "$1" == "-n" && "$4" == "exec" ]] || [[ "$*" == *" exec "* ]]; then
  exit 0
fi
if [[ "$*" == *"get svc demo"* ]]; then
  printf 'demo'
  exit 0
fi
exit 0
`,
    },
    async () => {
      const observation = await driver.inspect(workspace);
      const drift = computeWorkspaceDrift(workspace, observation);
      const status = synthesizeWorkspaceStatus(workspace, observation, drift, "status");
      const plan = buildReconcilePlan(workspace, drift);

      assert.equal(status.backend.kind, "pod");
      assert.equal(status.lifecycleAction, "status");
      assert.equal(status.state, "degraded");
      assert.equal(status.health.daemonReadiness, "degraded");
      assert.match(status.health.reason || "", /daemon status unavailable|pairing\.json|paseo/i);
      assert.deepEqual(plan.actions, [{ kind: "restart-runtime" }]);
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
if [[ "$*" == *"get deployment demo"* ]]; then
  printf '{"metadata":{"name":"demo"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=demo"* ]]; then
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
if [[ "$*" == *"get svc demo"* ]]; then
  printf 'demo'
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
        daemon?: { pairing?: { state?: string; url?: string } };
        paseo?: { daemonAddress?: string; supportedHarnesses?: string[]; liveTarget?: string | null };
      }>(output);
      assert.equal(parsed.daemon?.pairing?.state, "ok");
      assert.equal(parsed.daemon?.pairing?.url, "https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kZW1vIn0");
      assert.equal(parsed.paseo?.daemonAddress, "0.0.0.0:6767");
      assert.deepEqual(parsed.paseo?.supportedHarnesses, ["codex", "claude", "copilot", "opencode", "pi"]);
      assert.equal(parsed.paseo?.liveTarget, "https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kZW1vIn0");
    },
  );
});

test("kubevirt status includes the daemon pairing URL when runtime state exposes one", async () => {
  const project = uniqueProjectName("vm-pair-url");
  await withTempWorkspaceSpec(project, "kubevirt-vm", async () => {
    await withFakeCommands(
      {
        kubectl: `
if [[ "$*" == *"get vm ${project}-vm"* ]]; then
  printf '${project}-vm'
  exit 0
fi
if [[ "$*" == *"get vmi ${project}-vm"* ]]; then
  printf 'Running'
  exit 0
fi
if [[ "$*" == *"get svc ${project}"* ]]; then
  printf '${project}'
  exit 0
fi
if [[ "$*" == *"get secret ${project}-vm-cloudinit"* ]]; then
  printf '${project}-vm-cloudinit'
  exit 0
fi
if [[ "$*" == *"port-forward svc/${project}"* && "$*" == *":22"* ]]; then
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
          daemon?: { pairing?: { url?: string; state?: string } };
          paseo?: { daemonAddress?: string; supportedHarnesses?: string[]; liveTarget?: string | null };
        }>(output);
        assert.equal(parsed.daemon?.pairing?.state, "ok");
        assert.equal(parsed.daemon?.pairing?.url, "https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl92bXRlc3QifQ");
        assert.equal(parsed.paseo?.daemonAddress, "0.0.0.0:6767");
        assert.deepEqual(parsed.paseo?.supportedHarnesses, ["codex", "claude", "copilot", "opencode", "pi"]);
        assert.equal(parsed.paseo?.liveTarget, "https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl92bXRlc3QifQ");
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
if [[ "$*" == *"get deployment demo"* ]]; then
  printf '{"metadata":{"name":"demo"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=demo"* ]]; then
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
if [[ "$*" == *"get svc demo"* ]]; then
  printf 'demo'
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
        lifecycleAction: string;
        state: string;
        backend: { kind: string; instanceState: string };
        driver?: {
          target: string;
          baseImage: string;
          runtimeKind: string;
          runtimeRef: string;
          runtimeState: string;
        };
        health: { backendLiveness: string; workspaceReadiness: string; daemonReadiness: string };
        paseo?: { daemonAddress: string; supportedHarnesses: string[]; liveTarget: string | null };
        evolution?: { artifactCount: number };
      };

      assert.equal(parsed.project, "demo");
      assert.equal(parsed.lifecycleAction, "status");
      assert.equal(parsed.state, "ready");
      assert.equal(parsed.backend.kind, "pod");
      assert.equal(parsed.backend.instanceState, "running");
      assert.equal(parsed.driver?.target, "pod:gvisor");
      assert.equal(parsed.driver?.runtimeKind, "kubernetes-pod");
      assert.equal(parsed.driver?.runtimeRef, "pod/pod-1");
      assert.equal(parsed.driver?.runtimeState, "running");
      assert.equal(parsed.driver?.baseImage, "ttl.sh/polaris-demo-debian13-1782126452:24h");
      assert.equal(parsed.health.backendLiveness, "running");
      assert.equal(parsed.health.workspaceReadiness, "ready");
      assert.equal(parsed.health.daemonReadiness, "ready");
      assert.equal(parsed.paseo?.daemonAddress, "0.0.0.0:6767");
      assert.deepEqual(parsed.paseo?.supportedHarnesses, ["codex", "claude", "copilot", "opencode", "pi"]);
      assert.equal(parsed.paseo?.liveTarget, "https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kZW1vIn0");
      assert.ok(parsed.evolution);
    },
  );

  cleanupStatusFile("demo");
  cleanupSelectionFile("demo");
});

test("status stays ready when no active codex credential is selected", () => {
  const base = loadDefaultDemoWorkspace();
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
    runtimeAssembly: {
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
  const status = synthesizeWorkspaceStatus(workspace, observation, drift, "status");

  assert.equal(drift.hasWarnings, false);
  assert.equal(status.state, "ready");
  assert.equal(status.health.daemonReadiness, "ready");
  assert.equal(status.credentials?.codex?.state, "not-selected");
  assert.equal(status.runtimeAssembly?.codex?.state, "unknown");
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
        runtimeAssembly: {
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
      const status = synthesizeWorkspaceStatus(workspace, observation, drift, "status");
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
  await withTempWorkspaceSpec(project, "docker", async () => {
    await withFakeCommands(
      {
        docker: `
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${project}"* ]]; then
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
  if [[ "$*" == *"cat /workspace/state/paseo/server-id"* ]]; then
    printf 'srv_docker'
    exit 0
  fi
  if [[ "$*" == *"paseo daemon pair --json"* ]]; then
    printf '{"url":"https://app.paseo.sh/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9kb2NrZXIifQ"}'
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
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${project}"* ]]; then
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
if [[ "$*" == *"get deployment ${project}"* ]]; then
  printf '{"metadata":{"name":"${project}"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=${project}"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$*" == *"get svc ${project}"* ]]; then
  printf '${project}'
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
if [[ "$*" == *"scale deployment ${project} --replicas=0"* ]]; then
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
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${project}"* ]]; then
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
if [[ "$*" == *"get vm ${project}-vm"* ]]; then
  printf '${project}-vm'
  exit 0
fi
if [[ "$*" == *"get vmi ${project}-vm"* ]]; then
  printf 'Succeeded'
  exit 0
fi
if [[ "$*" == *"apply -f "* ]]; then
  exit 0
fi
if [[ "$*" == *"get deployment ${project}"* ]]; then
  printf '{"metadata":{"name":"${project}"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=${project}"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$*" == *"get svc ${project}"* ]]; then
  printf '${project}'
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
if [[ "$*" == *"scale deployment ${project} --replicas=0"* ]]; then
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
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${project}"* ]]; then
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
if [[ "$*" == *"wait --for=condition=Ready pod/${project}-pvc-import"* ]]; then
  exit 0
fi
if [[ "$*" == *"delete pod ${project}-pvc-import"* ]]; then
  exit 0
fi
if [[ "$*" == *"wait --for=delete pod/${project}-pvc-import"* ]]; then
  exit 0
fi
if [[ "$*" == *"get vm ${project}-vm"* ]]; then
  printf '${project}-vm'
  exit 0
fi
if [[ "$*" == *"get vmi ${project}-vm"* ]]; then
  printf 'Running'
  exit 0
fi
if [[ "$*" == *"get svc ${project}"* ]]; then
  printf '${project}'
  exit 0
fi
if [[ "$*" == *"get secret ${project}-vm-cloudinit"* ]]; then
  printf '${project}-vm-cloudinit'
  exit 0
fi
if [[ "$*" == *"port-forward svc/${project}"* && "$*" == *":22"* ]]; then
  printf 'Forwarding from 127.0.0.1:40022 -> 22\n'
  sleep 1
  exit 0
fi
if [[ "$*" == *"patch vm ${project}-vm"* ]]; then
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
              ? entry.includes(`cp`) && entry.includes(`${project}-pvc-import:/root/.paseo`)
              : false,
          );
          const generatedApplyIndex = commands.findIndex((entry) =>
            entry.includes(`/workspaces/${project}/generated/kubevirt.yaml`) && entry.includes("apply -f"),
          );
          assert.equal(
            commands.some((entry) => entry.includes(`patch vm ${project}-vm`) && entry.includes(`"runStrategy":"Halted"`)),
            false,
          );
          assert.ok(
            commands.some((entry) => entry.includes(`${project}-pvc-import`) && entry.includes("cp")),
          );
          assert.ok(
            commands.some((entry) => entry.includes(`delete pod ${project}-pvc-import --ignore-not-found --wait=false`)),
          );
          assert.ok(generatedApplyIndex >= 0);
          const firstPvcImportCommand = commands.findIndex((entry) =>
            entry.includes(`${project}-pvc-import`) && entry.includes("cp"),
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
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${project}"* ]]; then
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
if [[ "$*" == *"get deployment ${project}-workspace-data-export"* ]]; then
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

      const selectionPath = workspaceSelectionPath(project, DEMO_USER_PROFILE_ID);
      const parsed = JSON.parse(fs.readFileSync(selectionPath, "utf8")) as { backend: string; profile?: string };
      assert.equal(parsed.backend, "docker");
      assert.equal(parsed.profile, undefined);
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
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${project}"* ]]; then
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
if [[ "$*" == *"get deployment ${project}-workspace-data-export"* ]]; then
  exit 1
fi
if [[ "$*" == *"get vm ${project}-vm"* ]]; then
  printf '${project}-vm'
  exit 0
fi
if [[ "$*" == *"get vmi ${project}-vm"* ]]; then
  printf ''
  exit 0
fi
if [[ "$*" == *"apply -f "* && "$*" == *"pvc-export.yaml"* ]]; then
  exit 0
fi
if [[ "$*" == *"wait --for=condition=Ready pod/${project}-pvc-export"* ]]; then
  exit 0
fi
if [[ "$*" == *"delete pod ${project}-pvc-export"* ]]; then
  exit 0
fi
if [[ "$*" == *"wait --for=delete pod/${project}-pvc-export"* ]]; then
  exit 0
fi
if [[ "$1" == "-n" && "$3" == "cp" ]] || [[ "$1" == "cp" ]]; then
  exit 0
fi
if [[ "$*" == *"patch vm ${project}-vm"* ]]; then
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
            entry.includes(`${project}-pvc-export`) && entry.includes(" cp "),
          );
          const dockerUpIndex = commands.findIndex((entry) =>
            entry.includes("docker") && entry.includes("compose") && entry.includes("up -d"),
          );

          assert.ok(pvcExportIndex >= 0);
          assert.ok(dockerUpIndex >= 0);
          assert.ok(pvcExportIndex < dockerUpIndex);
          assert.ok(
            commands.some((entry) => entry.includes(`delete pod ${project}-pvc-export --ignore-not-found --wait=false`)),
          );
          assert.equal(
            commands.some((entry) => entry.includes(`patch vm ${project}-vm`)),
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
if [[ "$*" == *"get vm ${project}-vm"* ]]; then
  printf '${project}-vm'
  exit 0
fi
if [[ "$*" == *"get vmi ${project}-vm"* ]]; then
  printf 'Running'
  exit 0
fi
if [[ "$*" == *"get svc ${project}"* ]]; then
  printf '${project}'
  exit 0
fi
if [[ "$*" == *"get secret ${project}-vm-cloudinit"* ]]; then
  printf '${project}-vm-cloudinit'
  exit 0
fi
if [[ "$*" == *"port-forward svc/${project} "* && "$*" == *":22"* ]]; then
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
        const status = synthesizeWorkspaceStatus(workspace, observation, drift, "status");
        assert.equal(status.backend.kind, "kubevirt-vm");
        assert.equal(status.state, "ready");

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
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${project}"* ]]; then
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
if [[ "$*" == *"logs --tail 200 ${project}"* ]]; then
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
          backend: { kind: string; instanceState: string };
          driver?: {
            target: string;
            baseImage: string;
            runtimeKind: string;
            runtimeRef: string;
            runtimeState: string;
          };
          state: string;
          health: { daemonReadiness: string };
          assets: {
            dockerfile: { file: string; path: string };
            specs: Array<{ driver: string; file: string; path: string }>;
            generatedManifests: Array<{ driver: string; file: string; path: string }>;
            imageTags: Array<{ name: string; tag: string }>;
            persistentVolumes: Array<{ name: string; mountRoot: string; durablePaths: string[] }>;
          };
        }>(stdout);

        assert.equal(parsed.backend.kind, "docker");
        assert.equal(parsed.backend.instanceState, "running");
        assert.equal(parsed.driver?.target, "docker");
        assert.equal(parsed.driver?.baseImage, loadWorkspaceFromRefForTest(`${project}@docker`).runtime.baseImage);
        assert.equal(parsed.driver?.runtimeKind, "docker-container");
        assert.equal(parsed.driver?.runtimeRef, `container/${project}-docker`);
        assert.equal(parsed.driver?.runtimeState, "running");
        assert.equal(parsed.assets.dockerfile.file, "workspace-prebuilt.Dockerfile");
        assert.equal(parsed.assets.dockerfile.path, `config/users/${DEMO_USER_PROFILE_ID}/docker/workspace-prebuilt.Dockerfile`);
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
        assert.ok(commands.some((entry) => entry.includes(`compose`) && entry.includes(`ps -q ${project}`)));
        assert.ok(commands.some((entry) => entry.includes(`logs --tail 200 ${project}`)));
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
if [[ "$*" == *"get vm ${project}-vm"* ]]; then
  printf '${project}-vm'
  exit 0
fi
if [[ "$*" == *"get vmi ${project}-vm"* ]]; then
  printf 'Running'
  exit 0
fi
if [[ "$*" == *"get svc ${project}"* ]]; then
  printf '${project}'
  exit 0
fi
if [[ "$*" == *"get secret ${project}-vm-cloudinit"* ]]; then
  printf '${project}-vm-cloudinit'
  exit 0
fi
if [[ "$*" == *"port-forward svc/${project} "* && "$*" == *":22"* ]]; then
  printf 'Forwarding from 127.0.0.1:40022 -> 22\n'
  sleep 1
  exit 0
fi
if [[ "$1" == "-n" && "$3" == "get" && "$4" == "pod" && "$*" == *"vm.kubevirt.io/name=${project}-vm"* ]]; then
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
          backend: { kind: string; instanceState: string };
          driver?: {
            target: string;
            baseImage: string;
            runtimeKind: string;
            runtimeRef: string;
            runtimeState: string;
            rootdiskImage?: string;
          };
          state: string;
          health: { daemonReadiness: string };
        }>(stdout);

        assert.equal(parsed.backend.kind, "kubevirt-vm");
        assert.equal(parsed.backend.instanceState, "running");
        assert.equal(parsed.driver?.target, "kubevirt-vm");
        assert.equal(parsed.driver?.runtimeKind, "kubevirt-vm");
        assert.equal(parsed.driver?.runtimeRef, `vm/${project}-vm`);
        assert.equal(parsed.driver?.runtimeState, "running");
        assert.equal(parsed.state, "ready");
        assert.equal(parsed.health.daemonReadiness, "ready");

        await runCli(["logs", project]);
        const commands = readCommandLog();
        assert.ok(commands.some((entry) => entry.includes(`get pod -l vm.kubevirt.io/name=${project}-vm`)));
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
  };
  const driver = getBackendDriver("docker");

  await withFakeCommands(
    {
      docker: `
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
    async () => {
      const observation = await driver.inspect(workspace);
      assert.equal(observation.backend.exists, true);
      assert.equal(observation.backend.running, true);
      const drift = computeWorkspaceDrift(workspace, observation);
      const status = synthesizeWorkspaceStatus(workspace, observation, drift, "status");
      assert.equal(status.backend.kind, "docker");

      const plan = { project: "demo", backend: "docker", safe: true, requiresRestart: false, destructive: false, actions: [{ kind: "render" }, { kind: "apply" }] as any[] };
      await driver.executeReconcilePlan(workspace, plan as any);
    },
  );
});

test("docker lifecycle actions execute through docker compose", async () => {
  const base = loadDefaultDemoWorkspace();
  const workspace = {
    ...base,
    backend: {
      ...base.backend,
      kind: "docker" as const,
      profile: "docker",
      dockerRuntimeMode: "legacy" as const,
    },
  };
  const driver = getBackendDriver("docker");

  await withFakeCommands(
    {
      docker: `
if [[ "$*" == *"compose"* && "$*" == *"ps -q demo"* ]]; then
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
});
