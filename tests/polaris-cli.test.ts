import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { loadWorkspace } from "../scripts/polaris/config/load.js";
import { getBackendDriver } from "../scripts/polaris/backends/index.js";
import { workspaceConfigPath } from "../scripts/polaris/config/scaffold.js";
import { writeWorkspaceStatus } from "../scripts/polaris/output/state-store.js";
import { renderAndWritePodWorkspace } from "../scripts/polaris/backends/pod/render.js";
import { renderAndWriteDockerWorkspace } from "../scripts/polaris/backends/docker/render.js";
import { runCli } from "../scripts/polaris/cli/main.js";
import { buildReconcilePlan, computeWorkspaceDrift, synthesizeWorkspaceStatus } from "../scripts/polaris/core/runtime-controller.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const STATUS_DIR = path.join(REPO_ROOT, "config", "state");
const STDOUT_CAPTURE_QUEUE_KEY = "__polaris_stdout_capture_queue__";

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
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON object found in stdout: ${JSON.stringify(trimmed)}`);
  }
  return JSON.parse(trimmed.slice(start, end + 1)) as T;
}

function uniqueProjectName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

function cleanupStatusFile(project: string): void {
  fs.rmSync(path.join(STATUS_DIR, `${project}.status.json`), { force: true });
}

async function withTempWorkspaceSpec(
  project: string,
  backendKind: "docker" | "pod" | "kubevirt-vm",
  fn: () => Promise<void> | void,
): Promise<void> {
  const outputPath = workspaceConfigPath(project, backendKind);
  const backendDir = backendKind === "kubevirt-vm" ? "kubevirt" : backendKind;
  const generatedPath = path.join(REPO_ROOT, "config", "generated", backendDir, `${project}.yaml`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const sourcePath = path.join(REPO_ROOT, "config", "specs", backendDir, "projects", "morpheus.agent.yaml");
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
  try {
    await fn();
  } finally {
    fs.rmSync(outputPath, { force: true });
    fs.rmSync(generatedPath, { force: true });
    cleanupStatusFile(project);
  }
}

test("loadWorkspace normalizes morpheus pod config through the TypeScript control plane", () => {
  const workspace = loadWorkspace("morpheus");
  assert.equal(workspace.identity.projectName, "morpheus");
  assert.equal(workspace.profile.name, "morpheus");
  assert.equal(workspace.userProfile.id, "100000000000000001");
  assert.equal(workspace.userProfile.name, "Qiang Liu");
  assert.equal(workspace.userProfile.email, "cyruscyliu@gmail.com");
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
});

test("backend registry resolves pod driver", () => {
  const driver = getBackendDriver("pod");
  assert.equal(driver.kind, "pod");
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
  });

  assert.ok(fs.existsSync(statusPath));
  const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8")) as { project: string; backend: { kind: string } };
  assert.equal(parsed.project, project);
  assert.equal(parsed.backend.kind, "pod");

  cleanupStatusFile(project);
});

test("pod render writes a TypeScript-generated manifest", () => {
  const workspace = loadWorkspace("morpheus");
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
  const workspace = loadWorkspace("morpheus");
  assert.deepEqual(workspace.attachments.workspaceRuntimeState.durablePaths, [
    "/workspace/state/paseo",
    "/workspace/state/paseo/evolution",
  ]);
  assert.ok(workspace.attachments.ephemeralRuntime.staleArtifacts.includes("/run/workspace/pids/paseo.pid"));
  assert.ok(workspace.runtimeContract.minimalInvariants.some((entry) => entry.includes("user-identity-state")));
});

test("user identity attachments do not include workspace-scoped paseo state", () => {
  const workspace = loadWorkspace("morpheus");
  assert.equal(workspace.attachments.userIdentityState.durablePaths.some((entry) => entry.includes("paseo")), false);
  assert.equal(workspace.attachments.workspaceRuntimeState.durablePaths.some((entry) => entry.includes("paseo")), true);
});

test("attachment lifecycle semantics encode cross-workspace user state and exclusive workspace state", () => {
  const workspace = loadWorkspace("morpheus");
  assert.equal(workspace.attachments.workspaceData.sharing, "exclusive");
  assert.equal(workspace.attachments.workspaceRuntimeState.sharing, "exclusive");
  assert.equal(workspace.attachments.userIdentityState.sharing, "cross-workspace");
  assert.equal(workspace.attachments.userSshState.sharing, "cross-workspace");
  assert.equal(workspace.attachments.workspaceData.scope, "workspace");
  assert.equal(workspace.attachments.userIdentityState.scope, "user");
});

test("direct attachment config is present in migrated saved specs", () => {
  const workspace = loadWorkspace("morpheus");
  assert.equal(workspace.profile.name, "morpheus");
  assert.equal(workspace.attachments.workspaceData.source.kind, "persistent-volume");
  assert.equal(workspace.attachments.workspaceRuntimeState.source.kind, "persistent-volume");
  assert.equal(workspace.attachments.userIdentityState.mountRoot, "/identity");
  assert.equal(workspace.attachments.userSshState.mountRoot, "/ssh");
});

test("profile defaults drive renderer behavior instead of workspace-name checks", () => {
  const workspace = loadWorkspace("morpheus");
  assert.equal(workspace.profile.workspaceAlias, "Morpheus");
  assert.equal(workspace.userProfile.ssh.comment, "cyruscyliu@gmail.com");
});

test("workspace compatibility path derives a legacy user profile from inline git identity", async () => {
  const project = uniqueProjectName("compat-user");
  await withTempWorkspaceSpec(project, "docker", async () => {
    const outputPath = workspaceConfigPath(project, "docker");
    const doc = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as Record<string, any>;
    delete doc.user_profile;
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
      const outputPath = workspaceConfigPath(project, "docker");
      const doc = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as Record<string, any>;
      doc.user_profile = "provided-key-test";
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
  const workspace = loadWorkspace("morpheus@docker");
  const outputPath = renderAndWriteDockerWorkspace(workspace);
  const rendered = fs.readFileSync(outputPath, "utf8");
  assert.match(rendered, /polaris-100000000000000001-identity/);
  assert.match(rendered, /polaris-100000000000000001-ssh/);
});

test("pod backend returns structured observations", async () => {
  const workspace = loadWorkspace("morpheus");
  const driver = getBackendDriver("pod");
  await withFakeCommands(
    {
      kubectl: `
if [[ "$*" == *"get deployment morpheus"* ]]; then
  printf '{"metadata":{"name":"morpheus"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=morpheus"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$1" == "-n" && "$4" == "exec" ]] || [[ "$*" == *" exec "* ]]; then
  exit 0
fi
if [[ "$*" == *"get svc morpheus"* ]]; then
  printf 'morpheus'
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
  const workspace = {
    ...loadWorkspace("morpheus"),
    agent: {
      ...loadWorkspace("morpheus").agent,
      pairingFile: "/root/.paseo/pairing.json",
    },
  };
  const driver = getBackendDriver("pod");

  await withFakeCommands(
    {
      kubectl: `
if [[ "$*" == *"get deployment morpheus"* ]]; then
  printf '{"metadata":{"name":"morpheus"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=morpheus"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$*" == *"test -f /tmp/.ready && test -f /root/.paseo/pairing.json"* ]]; then
  exit 1
fi
if [[ "$1" == "-n" && "$4" == "exec" ]] || [[ "$*" == *" exec "* ]]; then
  exit 0
fi
if [[ "$*" == *"get svc morpheus"* ]]; then
  printf 'morpheus'
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
});

test("CLI create scaffolds a docker workspace spec for a new project", async () => {
  const project = uniqueProjectName("create-workspace");
  const outputPath = workspaceConfigPath(project, "docker");

  try {
    const stdout = await captureStdout(async () => {
      await runCli(["create", project]);
    });

    const parsed = parseJsonOutput<{
      project: string;
      backend: string;
      created: string;
      configPath: string;
      nextSteps: string[];
    }>(stdout);

    assert.equal(parsed.project, project);
    assert.equal(parsed.backend, "docker");
    assert.equal(parsed.created, "saved-spec");
    assert.equal(parsed.configPath, outputPath);
    assert.equal(fs.existsSync(outputPath), true);
    assert.ok(parsed.nextSteps.some((entry) => entry.includes(`render ${project}`)));
    assert.ok(parsed.nextSteps.some((entry) => entry.includes(`start ${project}`)));
  } finally {
    fs.rmSync(outputPath, { force: true });
  }
});

test("CLI status defaults to the status command and persists ready pod status", async () => {
  cleanupStatusFile("morpheus");
  const expectedStatusFile = path.join(STATUS_DIR, "morpheus.status.json");

  await withFakeCommands(
    {
      kubectl: `
if [[ "$*" == *"get deployment morpheus"* ]]; then
  printf '{"metadata":{"name":"morpheus"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=morpheus"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$1" == "-n" && "$4" == "exec" ]] || [[ "$*" == *" exec "* ]]; then
  exit 0
fi
if [[ "$*" == *"get svc morpheus"* ]]; then
  printf 'morpheus'
  exit 0
fi
exit 0
`,
    },
    async () => {
      await captureStdout(async () => {
        await runCli(["morpheus"]);
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

      assert.equal(parsed.project, "morpheus");
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

  cleanupStatusFile("morpheus");
});

test("CLI logs for pod backend prefers the active pod and falls back to deployment when needed", async () => {
  await withFakeCommands(
    {
      kubectl: `
if [[ "$*" == *"get pod -l app=morpheus"* ]]; then
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
      await runCli(["logs", "morpheus"]);
      const commands = readCommandLog();
      assert.ok(commands.some((entry) => entry.includes("get pod -l app=morpheus")));
      assert.ok(commands.some((entry) => entry.includes("logs pod-1 --tail=200")));
      assert.equal(commands.some((entry) => entry.includes("logs deployment/morpheus --tail=200")), false);
    },
  );

  await withFakeCommands(
    {
      kubectl: `
if [[ "$*" == *"get pod -l app=morpheus"* ]]; then
  exit 0
fi
if [[ "$*" == *"logs deployment/morpheus --tail=200"* ]]; then
  printf 'deployment logs'
  exit 0
fi
exit 0
`,
    },
    async ({ readCommandLog }) => {
      await runCli(["logs", "morpheus"]);
      const commands = readCommandLog();
      assert.ok(commands.some((entry) => entry.includes("logs deployment/morpheus --tail=200")));
    },
  );
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
if [[ "$*" == *"get secret morpheus-vm-cloudinit"* ]]; then
  printf 'morpheus-vm-cloudinit'
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
if [[ "$*" == *"get secret morpheus-vm-cloudinit"* ]]; then
  printf 'morpheus-vm-cloudinit'
  exit 0
fi
if [[ "$*" == *"get pod -l vm.kubevirt.io/name=${project}-vm"* ]]; then
  printf 'virt-launcher-0'
  exit 0
fi
if [[ "$*" == *"logs virt-launcher-0 --tail=200"* ]]; then
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
  const workspace = {
    ...loadWorkspace("morpheus"),
    backend: {
      ...loadWorkspace("morpheus").backend,
      kind: "kubevirt-vm" as const,
      profile: "vm",
    },
  };
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
  const base = loadWorkspace("morpheus");
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
if [[ "$*" == *"compose"* && "$*" == *"ps -q morpheus"* ]]; then
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

      const plan = { project: "morpheus", backend: "docker", safe: true, requiresRestart: false, destructive: false, actions: [{ kind: "render" }, { kind: "apply" }] as any[] };
      await driver.executeReconcilePlan(workspace, plan as any);
    },
  );
});

test("docker lifecycle actions execute through docker compose", async () => {
  const base = loadWorkspace("morpheus");
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
