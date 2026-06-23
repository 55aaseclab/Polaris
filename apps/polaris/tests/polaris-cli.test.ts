import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { loadWorkspace } from "../scripts/config/load.js";
import { ensureCanonicalWorkspaceImage, ensureWorkspaceConfig } from "../scripts/config/provision.js";
import { assertNoProjectNameCollision } from "../scripts/config/project-ownership.js";
import { getBackendDriver } from "../scripts/backends/index.js";
import { workspaceConfigPath, workspaceImageRef } from "../scripts/config/scaffold.js";
import { generatedOutputPath } from "../scripts/output/write-generated.js";
import {
  workspaceEvolutionStateDir,
  workspaceSelectionPath,
  workspaceStatusPath,
  writeWorkspaceDriverSelection,
  writeWorkspaceStatus,
} from "../scripts/output/state-store.js";
import { renderAndWritePodWorkspace } from "../scripts/backends/pod/render.js";
import { renderAndWriteDockerWorkspace } from "../scripts/backends/docker/render.js";
import { runCli } from "../scripts/cli/main.js";
import { buildReconcilePlan, computeWorkspaceDrift, synthesizeWorkspaceStatus } from "../scripts/core/runtime-controller.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const STDOUT_CAPTURE_QUEUE_KEY = "__polaris_stdout_capture_queue__";
const DEMO_USER_PROFILE_ID = "100000000000000001";

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

function loadDefaultDemoWorkspace() {
  cleanupSelectionFile("demo");
  return loadWorkspace("demo");
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
  const generatedPath = generatedOutputPath(loadWorkspace(`${project}@${backendKind}`));
  try {
    await fn();
  } finally {
    fs.rmSync(outputPath, { force: true });
    fs.rmSync(generatedPath, { force: true });
    cleanupStatusFile(project);
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
  assert.equal(workspace.attachments.userSshState.scope, "user");
  assert.equal(workspace.attachments.userIdentityState.sharing, "cross-workspace");
  assert.equal(workspace.attachments.userSshState.sharing, "cross-workspace");
  assert.equal(workspace.attachments.workspaceData.mountRoot, "/workspace/project");
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
    workspaceImageRef("100000000000000002", "morpheus"),
    "ttl.sh/user-002-morpheus:24h",
  );
  assert.equal(
    workspaceImageRef("local-cyrus@example.com", "Feature Preview"),
    "ttl.sh/user-local-cyrus-example-com-feature-preview:24h",
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
    assert.equal(podDoc.attachments["workspace-data"].source.volume_ref, `${project}-workspace-data`);
    assert.equal(
      podDoc.attachments["workspace-runtime-state"].source.volume_ref,
      `${project}-workspace-runtime-state`,
    );
  } finally {
    fs.rmSync(dockerPath, { force: true });
    fs.rmSync(podPath, { force: true });
  }
});

test("ensureCanonicalWorkspaceImage builds and pushes the canonical ttl image when it is missing", async () => {
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
          `image inspect ${imageRef}`,
          `pull ${imageRef}`,
          `build -f ${path.join(REPO_ROOT, "config", "users", DEMO_USER_PROFILE_ID, "docker", "workspace-prebuilt.Dockerfile")} -t ${imageRef} .`,
          `push ${imageRef}`,
        ]);
      },
    );
  } finally {
    fs.rmSync(dockerPath, { force: true });
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
    const workspace = loadWorkspace(project);
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
    const workspace = loadWorkspace(project);
    assert.equal(workspace.backend.kind, "docker");
  } finally {
    cleanupSelectionFile(project);
  }
});

test("status command exposes evolution explainability details", async () => {
  const project = uniqueProjectName("explained-status");
  await withTempWorkspaceSpec(project, "docker", async () => {
    const workspace = loadWorkspace(`${project}@docker`);
    const evolutionDir = workspaceEvolutionStateDir(
      workspace.identity.projectName,
      workspace.userProfile.id,
    );
    const dbPath = path.join(evolutionDir, "store.db");
    try {
      fs.mkdirSync(evolutionDir, { recursive: true });
      const { EvolutionStore } = await import("../scripts/evolution/store.js");
      const store = await EvolutionStore.open(dbPath);
      store.upsertArtifact({
        id: "explained-artifact",
        workspaceId: workspace.identity.projectName,
        userProfileId: workspace.userProfile.id,
        kind: "workspace-playbook",
        scope: "workspace",
        title: "Explained lesson",
        content: "Use the verifier before retrying.",
        confidence: 0.9,
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {
          retrieval: { reasons: ["workspace-scoped", "matched tags: verifier"] },
          explainability: { existsBecause: "Recovered from a successful validation workflow." },
          curator: { action: "promoted", reason: "high-confidence active artifact" },
        },
      });
      store.close();

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
          assert.deepEqual(artifact?.whyRetrieved, ["workspace-scoped", "matched tags: verifier"]);
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
  assert.match(rendered, /mountPath: \/ssh/);
  assert.match(rendered, /ln -sfn \/identity\/codex \/root\/\.codex/);
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
  assert.equal(workspace.attachments.userSshState.sharing, "cross-workspace");
  assert.equal(workspace.attachments.workspaceData.scope, "workspace");
  assert.equal(workspace.attachments.userIdentityState.scope, "user");
});

test("direct attachment config is present in migrated saved specs", () => {
  const workspace = loadDefaultDemoWorkspace();
  assert.equal(workspace.profile.name, "morpheus");
  assert.equal(workspace.attachments.workspaceData.source.kind, "persistent-volume");
  assert.equal(workspace.attachments.workspaceRuntimeState.source.kind, "persistent-volume");
  assert.equal(workspace.attachments.userIdentityState.mountRoot, "/identity");
  assert.equal(workspace.attachments.userSshState.mountRoot, "/ssh");
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

    const workspace = loadWorkspace(`${project}@docker`);
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

    const workspace = loadWorkspace(`${project}@docker`);
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
      () => loadWorkspace(`${project}@docker`),
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
      () => loadWorkspace(`${project}@docker`),
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
      assert.throws(() => loadWorkspace(`${project}@docker`), /provided-key/);
    } finally {
      fs.rmSync(profilePath, { force: true });
    }
  });
});

test("docker render keys user-scoped identity volumes by user profile id", () => {
  const workspace = loadWorkspace("demo@docker");
  const outputPath = renderAndWriteDockerWorkspace(workspace);
  const rendered = fs.readFileSync(outputPath, "utf8");
  const escapedId = workspace.userProfile.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(rendered, new RegExp(`polaris-${escapedId}-identity`));
  assert.match(rendered, new RegExp(`polaris-${escapedId}-ssh`));
  assert.doesNotMatch(rendered, /bootstrap-secrets/);
});

test("demo specs reuse the demo profile across docker, pod, and kubevirt backends", () => {
  const dockerWorkspace = loadWorkspace("demo@docker");
  const podWorkspace = loadWorkspace("demo@pod");
  const kubevirtWorkspace = loadWorkspace("demo@kubevirt-vm");

  for (const workspace of [dockerWorkspace, podWorkspace, kubevirtWorkspace]) {
    assert.equal(workspace.identity.projectName, "demo");
    assert.equal(workspace.userProfile.id, "100000000000000001");
    assert.equal(workspace.userProfile.name, "Demo User");
    assert.equal(workspace.userProfile.email, "demo@example.com");
    assert.equal(workspace.runtime.gitUserName, "Demo User");
    assert.equal(workspace.runtime.gitUserEmail, "demo@example.com");
  }

  assert.equal(dockerWorkspace.attachments.workspaceData.source.volumeRef, "demo-project");
  assert.equal(
    podWorkspace.attachments.workspaceRuntimeState.source.volumeRef,
    "demo-project",
  );
  assert.equal(
    kubevirtWorkspace.attachments.workspaceRuntimeState.source.volumeRef,
    "demo-workspace-runtime-state",
  );
});

test("docker render uses stable named volumes for reusable demo attachments", () => {
  const workspace = loadWorkspace("demo@docker");
  const outputPath = renderAndWriteDockerWorkspace(workspace);
  const rendered = fs.readFileSync(outputPath, "utf8");

  assert.match(rendered, /source: demo-project\b/);
  assert.match(rendered, /source: demo-project-state\b/);
  assert.match(rendered, /demo-project:\n    name: demo-project/);
  assert.match(rendered, /demo-project-state:\n    name: demo-project-state/);
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

    const workspace = loadWorkspace(`${project}@docker`);
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
      assert.match(status.health.reason || "", /pairing\.json|paseo/i);
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
if [[ "$*" == *"cat /root/.paseo/pairing.json"* ]]; then
  printf '{"url":"https://app.paseo.sh/#offer=test"}'
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
      const parsed = parseJsonOutput<{ daemon?: { pairing?: { state?: string; url?: string } } }>(output);
      assert.equal(parsed.daemon?.pairing?.state, "ok");
      assert.equal(parsed.daemon?.pairing?.url, "https://app.paseo.sh/#offer=test");
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
if [[ "$*" == *"apply -f -"* ]]; then
  exit 0
fi
if [[ "$*" == *"wait --for=condition=Ready pod/${project}-pairing-inspect"* ]]; then
  exit 0
fi
if [[ "$*" == *"cat /workspace/state/paseo/pairing.json"* ]]; then
  printf '{"url":"https://app.paseo.sh/#offer=vmtest"}'
  exit 0
fi
if [[ "$*" == *"exec ${project}-pairing-inspect"* ]]; then
  exit 0
fi
if [[ "$*" == *"delete pod ${project}-pairing-inspect"* ]]; then
  exit 0
fi
if [[ "$*" == *"logs"* ]]; then
  exit 0
fi
exit 0
`,
      },
      async () => {
        const output = await captureStdout(async () => {
          await runCli(["status", `${project}@kubevirt-vm`]);
        });
        const parsed = parseJsonOutput<{ daemon?: { pairing?: { url?: string; state?: string } } }>(output);
        assert.equal(parsed.daemon?.pairing?.state, "ok");
        assert.equal(parsed.daemon?.pairing?.url, "https://app.paseo.sh/#offer=vmtest");
      },
    );
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
        health: { backendLiveness: string; workspaceReadiness: string; daemonReadiness: string };
        evolution?: { artifactCount: number };
      };

      assert.equal(parsed.project, "demo");
      assert.equal(parsed.lifecycleAction, "status");
      assert.equal(parsed.state, "ready");
      assert.equal(parsed.backend.kind, "pod");
      assert.equal(parsed.backend.instanceState, "running");
      assert.equal(parsed.health.backendLiveness, "running");
      assert.equal(parsed.health.workspaceReadiness, "ready");
      assert.equal(parsed.health.daemonReadiness, "ready");
      assert.ok(parsed.evolution);
    },
  );

  cleanupStatusFile("demo");
  cleanupSelectionFile("demo");
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
        assert.ok(commands.some((entry) => entry.includes(`/projects/${project}/generated/docker.yaml`) && entry.includes("up -d")));
        assert.ok(commands.some((entry) => entry.includes(`/projects/${project}/generated/docker.yaml`) && entry.includes("stop")));
        assert.ok(commands.some((entry) => entry.includes(`/projects/${project}/generated/docker.yaml`) && entry.includes("restart")));
        assert.ok(commands.some((entry) => entry.includes(`/projects/${project}/generated/docker.yaml`) && entry.includes("up -d --force-recreate")));

        const parsed = parseJsonOutput<{ reconcilePlan: { actions: Array<{ kind: string }>; safe: boolean } }>(reconcileOutput);
        assert.ok(Array.isArray(parsed.reconcilePlan.actions));
        assert.equal(parsed.reconcilePlan.safe, true);
      },
    );
  });
});

test("kubevirt backend returns structured observations and current status semantics stay ready only when cloud-init is present", async () => {
  const project = uniqueProjectName("vm-status");

  await withTempWorkspaceSpec(project, "kubevirt-vm", async () => {
    const workspace = loadWorkspace(project);
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
if [[ "$*" == *"port-forward svc/${project} "* ]]; then
  local_port=$(printf '%s\n' "$*" | sed -n 's/.*port-forward svc\\/[^ ]* \\([0-9][0-9]*\\):6767.*/\\1/p')
  python3 -m http.server "$local_port" --bind 127.0.0.1 >/dev/null 2>&1 &
  server_pid=$!
  trap 'kill $server_pid >/dev/null 2>&1 || true' EXIT
  printf 'Forwarding from 127.0.0.1:%s -> 6767\n' "$local_port"
  wait $server_pid
  exit 0
fi
if [[ "$*" == *"apply -f "* ]]; then
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
          state: string;
          health: { daemonReadiness: string };
        }>(stdout);

        assert.equal(parsed.backend.kind, "docker");
        assert.equal(parsed.backend.instanceState, "running");
        assert.equal(parsed.state, "ready");
        assert.equal(parsed.health.daemonReadiness, "ready");

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
if [[ "$*" == *"port-forward svc/${project} "* ]]; then
  local_port=$(printf '%s\n' "$*" | sed -n 's/.*port-forward svc\\/[^ ]* \\([0-9][0-9]*\\):6767.*/\\1/p')
  python3 -m http.server "$local_port" --bind 127.0.0.1 >/dev/null 2>&1 &
  server_pid=$!
  trap 'kill $server_pid >/dev/null 2>&1 || true' EXIT
  printf 'Forwarding from 127.0.0.1:%s -> 6767\n' "$local_port"
  wait $server_pid
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
      },
      async ({ readCommandLog }) => {
        const stdout = await captureStdout(async () => {
          await runCli(["status", project]);
        });
        const parsed = parseJsonOutput<{
          backend: { kind: string; instanceState: string };
          state: string;
          health: { daemonReadiness: string };
        }>(stdout);

        assert.equal(parsed.backend.kind, "kubevirt-vm");
        assert.equal(parsed.backend.instanceState, "running");
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
  const workspace = loadWorkspace("demo@kubevirt-vm");
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
