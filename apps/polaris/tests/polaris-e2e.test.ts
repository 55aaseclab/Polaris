import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { runCli } from "../scripts/cli/main.js";
import { loadWorkspaceFromConfigPath, resolveWorkspaceConfigPath } from "../scripts/config/load.js";
import { workspaceConfigPath } from "../scripts/config/scaffold.js";
import {
  workspaceRuntimeResourceName,
  workspaceRuntimeScopeName,
} from "../scripts/core/workspace-name.js";
import { generatedOutputPath } from "../scripts/output/write-generated.js";
import {
  workspaceSelectionPath,
  writeWorkspaceDriverSelection,
} from "../scripts/output/state-store.js";

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

async function withFakePath(commands: Record<string, string>, fn: () => Promise<void> | void): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-e2e-"));
  const originalPath = process.env.PATH || "";
  for (const [name, body] of Object.entries(commands)) {
    fs.writeFileSync(path.join(tempDir, name), body, { mode: 0o755 });
  }
  process.env.PATH = `${tempDir}:${originalPath}`;
  try {
    await fn();
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
        continue;
      }
      process.env[key] = value;
    }
  }
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const previous = getStdoutCaptureQueue();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  setStdoutCaptureQueue(next);
  await previous;
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
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

async function captureOutput(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const previous = getStdoutCaptureQueue();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  setStdoutCaptureQueue(next);
  await previous;

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;

  try {
    await fn();
    return {
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
    };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    release();
  }
}

function removeIfExists(target: string): void {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function cleanupSelectionFile(project: string): void {
  removeIfExists(workspaceSelectionPath(project, DEMO_USER_PROFILE_ID));
  removeIfExists(path.join(REPO_ROOT, "config", "state", `${project}.selection.json`));
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

function writeProjectSpec(backendDir: "pod" | "docker" | "kubevirt", project: string): string {
  const backendKind = backendDir === "kubevirt" ? "kubevirt-vm" : backendDir;
  const sourcePath = workspaceConfigPath("demo", backendKind, DEMO_USER_PROFILE_ID);
  const outputPath = workspaceConfigPath(project, backendKind, DEMO_USER_PROFILE_ID);
  const source = fs.readFileSync(sourcePath, "utf8").replace(/^project: demo$/m, `project: ${project}`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, source, "utf8");
  return outputPath;
}

test("create scaffolds a docker-first saved spec when the project is new", async () => {
  const project = `e2e-create-${Date.now()}`;
  const profileEmail = `${project}@polaris.local`;
  const userProfileId = `local-${project}-polaris.local`;
  const configPath = workspaceConfigPath(project, "docker", userProfileId);
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const secretsRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const credentialRoot = path.join(REPO_ROOT, "config", "users", userProfileId, "credentials");

  try {
    await withEnv(
      {
        GIT_AUTHOR_NAME: "E2E Create",
        GIT_AUTHOR_EMAIL: profileEmail,
      },
      async () => {
        await runCli(["user", "create", userProfileId, "--name", "E2E Create", "--email", profileEmail]);
        const output = await captureStdout(async () => {
          await runCli(["create", project, "--user", userProfileId]);
        });
        const parsed = parseJsonOutput<{
          created: string;
          project: string;
          userProfile: {
            id: string;
            created: boolean;
            profilePath: string;
            secretsRoot: string;
          };
          credentials: {
            registryRoot: string;
            defaults: string[];
          };
        }>(output);

        assert.equal(fs.existsSync(configPath), true);
        const rendered = fs.readFileSync(configPath, "utf8");
        assert.match(rendered, /backend:\n  kind: docker/);
        assert.match(rendered, /profile: morpheus/);
        assert.match(rendered, new RegExp(`user_profile: '?${userProfileId}'?`));
        assert.match(rendered, /agent:\n  kind: multi/);
        assert.match(rendered, /credentialId: github-ssh/);
        assert.doesNotMatch(rendered, /purpose: agent-auth/);
        assert.equal(parsed.created, "saved-spec");
        assert.equal(parsed.project, project);
        assert.equal(parsed.userProfile.id, userProfileId);
        assert.equal(parsed.userProfile.created, false);
        assert.equal(parsed.userProfile.profilePath, `config/users/profiles/${userProfileId}.yaml`);
        assert.equal(parsed.userProfile.secretsRoot, `config/users/${userProfileId}`);
        assert.equal(parsed.credentials.registryRoot, `config/users/${userProfileId}/credentials`);
        assert.deepEqual(parsed.credentials.defaults, ["github-ssh"]);
        assert.equal(fs.existsSync(profilePath), true);
        assert.equal(fs.existsSync(path.join(secretsRoot, "workspaces", project)), true);
        assert.equal(fs.existsSync(path.join(secretsRoot, ".gitignore")), true);
        assert.equal(fs.existsSync(path.join(credentialRoot, "github-ssh.yaml")), true);
      },
    );
  } finally {
    removeIfExists(configPath);
    removeIfExists(profilePath);
    removeIfExists(secretsRoot);
    removeIfExists(credentialRoot);
  }
});

test("create scaffolds a requested pod spec from the docker source of truth", async () => {
  const project = `e2e-create-pod-${Date.now()}`;
  const profileEmail = `${project}@polaris.local`;
  const userProfileId = `local-${project}-polaris.local`;
  const dockerConfigPath = workspaceConfigPath(project, "docker", userProfileId);
  const podConfigPath = workspaceConfigPath(project, "pod", userProfileId);
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const secretsRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const credentialRoot = path.join(REPO_ROOT, "config", "users", userProfileId, "credentials");

  try {
    await withEnv(
      {
        GIT_AUTHOR_NAME: "E2E Create Pod",
        GIT_AUTHOR_EMAIL: profileEmail,
      },
      async () => {
        await runCli(["user", "create", userProfileId, "--name", "E2E Create Pod", "--email", profileEmail]);
        const output = await captureStdout(async () => {
          await runCli(["create", `${project}@pod:gvisor`, "--user", userProfileId]);
        });
        const parsed = parseJsonOutput<{
          backend: string;
          configPath: string;
        }>(output);

        assert.equal(parsed.backend, "pod");
        assert.equal(parsed.configPath, podConfigPath);
        assert.equal(fs.existsSync(dockerConfigPath), true);
        assert.equal(fs.existsSync(podConfigPath), true);
        const rendered = fs.readFileSync(podConfigPath, "utf8");
        assert.match(rendered, /backend:\n  kind: pod/);
        assert.match(rendered, /class: gvisor/);
      },
    );
  } finally {
    removeIfExists(dockerConfigPath);
    removeIfExists(podConfigPath);
    removeIfExists(profilePath);
    removeIfExists(secretsRoot);
    removeIfExists(credentialRoot);
  }
});

test("create adapts workspace credential bindings to the user's available registry credentials", async () => {
  const project = `e2e-create-adaptive-${Date.now()}`;
  const profileEmail = `${project}@polaris.local`;
  const userProfileId = `local-${project}-polaris.local`;
  const configPath = workspaceConfigPath(project, "docker", userProfileId);
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const secretsRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const credentialRoot = path.join(REPO_ROOT, "config", "users", userProfileId, "credentials");
  const legacyGitCredential = path.join(credentialRoot, "github-ssh.yaml");
  const adaptiveAgentCredential = path.join(credentialRoot, "demo-codex.yaml");
  const adaptiveGitCredential = path.join(credentialRoot, "demo-ssh.yaml");

  try {
    await withEnv(
      {
        GIT_AUTHOR_NAME: "E2E Create Adaptive",
        GIT_AUTHOR_EMAIL: profileEmail,
      },
      async () => {
        await runCli(["user", "create", userProfileId, "--name", "E2E Create Adaptive", "--email", profileEmail]);
        fs.rmSync(legacyGitCredential, { force: true });
        fs.writeFileSync(
          adaptiveAgentCredential,
          yaml.dump({
            id: "demo-codex",
            userId: userProfileId,
            kind: "codex-auth",
            label: "Demo Codex auth",
            purposes: ["agent-auth"],
            materialRef: {
              type: "file",
              key: "user-identity-state/default",
              files: [
                {
                  key: "codex-auth.json",
                  source_path: "credentials/codex/auth.json",
                },
              ],
            },
            status: "ready",
          }, { lineWidth: 120, noRefs: true }),
          "utf8",
        );
        fs.writeFileSync(
          adaptiveGitCredential,
          yaml.dump({
            id: "demo-ssh",
            userId: userProfileId,
            kind: "ssh-key",
            label: "Demo SSH key",
            purposes: ["git-auth"],
            materialRef: {
              type: "file",
              key: "demo-ssh",
              files: [
                {
                  key: "id_ed25519",
                  source_path: "credentials/ssh/github-ssh/id_ed25519",
                },
              ],
            },
            status: "ready",
          }, { lineWidth: 120, noRefs: true }),
          "utf8",
        );

        const output = await captureStdout(async () => {
          await runCli(["create", project, "--user", userProfileId]);
        });
        const parsed = parseJsonOutput<{
          credentials: {
            defaults: string[];
          };
        }>(output);

        assert.equal(fs.existsSync(configPath), true);
        const rendered = fs.readFileSync(configPath, "utf8");
        assert.match(rendered, /agent:\n  kind: multi/);
        assert.match(rendered, /credentialId: demo-ssh/);
        assert.doesNotMatch(rendered, /credentialId: demo-codex/);
        assert.doesNotMatch(rendered, /credentialId: codex-default/);
        assert.doesNotMatch(rendered, /purpose: agent-auth/);
        assert.deepEqual(parsed.credentials.defaults, ["demo-ssh"]);
      },
    );
  } finally {
    removeIfExists(configPath);
    removeIfExists(profilePath);
    removeIfExists(secretsRoot);
    removeIfExists(credentialRoot);
  }
});

test("create fails when the user has no git-auth credential", async () => {
  const project = `e2e-create-unbound-${Date.now()}`;
  const profileEmail = `${project}@polaris.local`;
  const userProfileId = `local-${project}-polaris.local`;
  const configPath = workspaceConfigPath(project, "docker", userProfileId);
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const secretsRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const credentialRoot = path.join(REPO_ROOT, "config", "users", userProfileId, "credentials");

  try {
    await withEnv(
      {
        GIT_AUTHOR_NAME: "E2E Create Unbound",
        GIT_AUTHOR_EMAIL: profileEmail,
      },
      async () => {
        await runCli(["user", "create", userProfileId, "--name", "E2E Create Unbound", "--email", profileEmail]);
        removeIfExists(credentialRoot);
        fs.mkdirSync(credentialRoot, { recursive: true });

        await assert.rejects(
          () => runCli(["create", project, "--user", userProfileId]),
          /Workspace create requires a git-auth credential/,
        );
        assert.equal(fs.existsSync(configPath), false);
      },
    );
  } finally {
    removeIfExists(configPath);
    removeIfExists(profilePath);
    removeIfExists(secretsRoot);
    removeIfExists(credentialRoot);
  }
});

test("default CLI dispatch uses status instead of apply", async () => {
  await withFakePath(
    {
      kubectl: `#!/usr/bin/env bash
if [[ "$*" == *"get deployment ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '{"metadata":{"name":"${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$1" == "exec" || "$*" == *" exec "* ]]; then
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
        await runCli(["demo"]);
      });
      assert.doesNotMatch(output, /"lifecycleAction":/);
      assert.match(output, /"statusFile":/);
    },
  );
});

test("backend selectors disambiguate shared project names like demo@docker", async () => {
  await withFakePath(
    {
      docker: `#!/usr/bin/env bash
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
      const output = await captureStdout(async () => {
        await runCli(["status", "demo@docker"]);
      });
      assert.match(output, /"backend": "docker"/);
      assert.match(output, /"project": "demo"/);
    },
  );
});

test("switch stops the previous backend, starts the new backend, and updates defaults", async () => {
  const project = "demo";
  const driverSelectionPath = workspaceSelectionPath(project, DEMO_USER_PROFILE_ID);
  const dockerStateFile = `/tmp/polaris-switch-basic-docker-state-${process.pid}-${Date.now()}`;
  const podStateFile = `/tmp/polaris-switch-basic-pod-state-${process.pid}-${Date.now()}`;
  cleanupSelectionFile(project);

  try {
    await withFakePath(
      {
        docker: `#!/usr/bin/env bash
state_file=${JSON.stringify(dockerStateFile)}
if [[ ! -f "$state_file" ]]; then
  printf 'running\n' > "$state_file"
fi
if [[ "$*" == *" stop"* ]]; then
  printf 'stopped\n' > "$state_file"
  exit 0
fi
if [[ "$*" == *" up -d"* ]]; then
  printf 'running\n' > "$state_file"
  exit 0
fi
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
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
if [[ "$1" == "exec" ]]; then
  exit 0
fi
exit 0
`,
        kubectl: `#!/usr/bin/env bash
state_file=${JSON.stringify(podStateFile)}
if [[ ! -f "$state_file" ]]; then
  printf 'running\n' > "$state_file"
fi
if [[ "$*" == *"apply -f "* ]]; then
  printf 'running\n' > "$state_file"
  exit 0
fi
if [[ "$*" == *"rollout restart"* ]]; then
  printf 'running\n' > "$state_file"
  exit 0
fi
if [[ "$*" == *"get deployment ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  if [[ "$(cat "$state_file")" == "running" ]]; then
    printf '{"metadata":{"name":"${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"}}'
    exit 0
  fi
  exit 1
fi
if [[ "$*" == *"get pod -l app=${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  if [[ "$(cat "$state_file")" == "running" ]]; then
    printf 'pod-1'
    exit 0
  fi
  exit 0
fi
if [[ "$1" == "exec" || "$*" == *" exec "* ]]; then
  exit 0
fi
if [[ "$*" == *"get svc ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}'
  exit 0
fi
if [[ "$*" == *"scale deployment ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")} --replicas=0"* ]]; then
  printf 'stopped\n' > "$state_file"
  exit 0
fi
exit 0
`,
      },
      async () => {
        const switched = await captureStdout(async () => {
          await runCli(["switch", "demo@docker"]);
        });
        assert.match(switched, /"selectedBackend": "docker"/);
        assert.match(switched, /"stoppedBackends": \[\s*"pod"\s*\]/);
        assert.equal(fs.existsSync(driverSelectionPath), true);

        const dockerOutput = await captureStdout(async () => {
          await runCli(["status", project]);
        });
        assert.match(dockerOutput, /"kind": "docker"/);

        const switchedAgain = await captureStdout(async () => {
          await runCli(["switch", "demo@pod"]);
        });
        assert.match(switchedAgain, /"selectedBackend": "pod"/);
        assert.match(switchedAgain, /"selectedProfile": "gvisor"/);
        assert.match(switchedAgain, /"stoppedBackends": \[\s*"docker"\s*\]/);

        const podOutput = await captureStdout(async () => {
          await runCli(["status", project]);
        });
        assert.match(podOutput, /"kind": "pod"/);
      },
    );
  } finally {
    cleanupSelectionFile(project);
    removeIfExists(dockerStateFile);
    removeIfExists(podStateFile);
  }
});

test("switch accepts pod driver variants such as kata", async () => {
  const project = "demo";
  const driverSelectionPath = workspaceSelectionPath(project, DEMO_USER_PROFILE_ID);
  cleanupSelectionFile(project);

  try {
    await withFakePath(
      {
        kubectl: `#!/usr/bin/env bash
if [[ "$*" == *"apply -f "* ]]; then
  exit 0
fi
if [[ "$*" == *"get deployment ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '{"metadata":{"name":"${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$1" == "exec" || "$*" == *" exec "* ]]; then
  exit 0
fi
if [[ "$*" == *"get svc ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  printf '${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}'
  exit 0
fi
exit 0
`,
        docker: `#!/usr/bin/env bash
exit 0
`,
      },
      async () => {
        const switched = await captureStdout(async () => {
          await runCli(["switch", "demo@pod:kata"]);
        });
        assert.match(switched, /"selectedBackend": "pod"/);
        assert.match(switched, /"selectedProfile": "kata"/);

        const saved = JSON.parse(fs.readFileSync(driverSelectionPath, "utf8")) as {
          backend: string;
          profile?: string;
        };
        assert.equal(saved.backend, "pod");
        assert.equal(saved.profile, "kata");
      },
    );
  } finally {
    cleanupSelectionFile(project);
  }
});

test("e2e switch chain keeps daemon connectivity across docker, pod:gvisor, pod:kata-container, and kubevirt while exposing timing from logs", async () => {
  const project = "demo";
  const driverSelectionPath = workspaceSelectionPath(project, DEMO_USER_PROFILE_ID);
  const podProfilePath = path.join(REPO_ROOT, "config", "pod", "profiles", "kata-container.yaml");
  cleanupSelectionFile(project);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-switch-sim-"));
  const statePath = path.join(tempDir, "backend-state.sh");
  fs.writeFileSync(
    statePath,
    [
      "DOCKER_RUNNING=1",
      "POD_EXISTS=1",
      "POD_RUNNING=0",
      "KUBEVIRT_EXISTS=1",
      "KUBEVIRT_RUNNING=0",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    podProfilePath,
    yaml.dump({ backend: { profile: "kata-qemu" } }, { lineWidth: 120, noRefs: true }),
    "utf8",
  );

  function parseSwitchDurations(stderr: string): {
    stopToStartMs: number;
    startToReadyMs: number;
    totalMs: number;
  } {
    const lines = stderr.split("\n").filter(Boolean);
    const extractTs = (pattern: RegExp): number => {
      const line = lines.find((entry) => pattern.test(entry));
      assert.ok(line, `Missing log line for pattern ${pattern}`);
      const match = /^\[([^\]]+)\]/.exec(line);
      assert.ok(match, `Missing timestamp in log line: ${line}`);
      return Date.parse(match[1]);
    };
    const stopTs = extractTs(/\[cli\] switch-stop-previous-backend/);
    const startTs = extractTs(/\[cli\] load-workspace/);
    const readyTs = extractTs(/\[cli\] workspace-ready/);
    return {
      stopToStartMs: startTs - stopTs,
      startToReadyMs: readyTs - startTs,
      totalMs: readyTs - stopTs,
    };
  }

  try {
    writeWorkspaceDriverSelection(project, { backend: "docker" }, DEMO_USER_PROFILE_ID);
    await withFakePath(
      {
        docker: `#!/usr/bin/env bash
set -euo pipefail
source ${JSON.stringify(statePath)}
save_state() {
  cat > ${JSON.stringify(statePath)} <<EOF
DOCKER_RUNNING=$DOCKER_RUNNING
POD_EXISTS=$POD_EXISTS
POD_RUNNING=$POD_RUNNING
KUBEVIRT_EXISTS=$KUBEVIRT_EXISTS
KUBEVIRT_RUNNING=$KUBEVIRT_RUNNING
EOF
}
if [[ "$*" == *"compose"* && "$*" == *"ps -q ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  [[ "$DOCKER_RUNNING" == "1" ]] && printf 'docker-id'
  exit 0
fi
if [[ "$*" == *"inspect docker-id"* ]]; then
  printf '[{"State":{"Running":%s}}]' "$([[ "$DOCKER_RUNNING" == "1" ]] && echo true || echo false)"
  exit 0
fi
if [[ "$*" == *"stop"* ]]; then
  DOCKER_RUNNING=0
  save_state
  sleep 0.1
  exit 0
fi
if [[ "$*" == *"up -d"* ]]; then
  DOCKER_RUNNING=1
  save_state
  sleep 0.1
  exit 0
fi
if [[ "$*" == *"restart"* ]]; then
  DOCKER_RUNNING=1
  save_state
  sleep 0.1
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  [[ "$DOCKER_RUNNING" == "1" ]] && exit 0
  exit 1
fi
if [[ "$1" == "cp" ]]; then
  exit 0
fi
exit 0
`,
        kubectl: `#!/usr/bin/env bash
set -euo pipefail
source ${JSON.stringify(statePath)}
save_state() {
  cat > ${JSON.stringify(statePath)} <<EOF
DOCKER_RUNNING=$DOCKER_RUNNING
POD_EXISTS=$POD_EXISTS
POD_RUNNING=$POD_RUNNING
KUBEVIRT_EXISTS=$KUBEVIRT_EXISTS
KUBEVIRT_RUNNING=$KUBEVIRT_RUNNING
EOF
}
if [[ "$*" == *"/generated/pod.yaml"* ]]; then
  POD_EXISTS=1
  POD_RUNNING=1
  save_state
  exit 0
fi
if [[ "$*" == *"/generated/kubevirt.yaml"* ]]; then
  KUBEVIRT_EXISTS=1
  save_state
  exit 0
fi
if [[ "$1" == "apply" && "$2" == "-f" && "$3" == "-" ]]; then
  exit 0
fi
if [[ "$*" == *"wait --for=condition=Ready pod/"* ]]; then
  exit 0
fi
if [[ "$*" == *"wait --for=jsonpath="* ]]; then
  exit 0
fi
if [[ "$*" == *"get deployment ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")} -o json"* ]]; then
  if [[ "$POD_EXISTS" == "1" ]]; then
    printf '{"metadata":{"name":"${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"}}'
    exit 0
  fi
  exit 1
fi
if [[ "$*" == *"get pod -l app=${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  [[ "$POD_RUNNING" == "1" ]] && printf 'pod-1'
  exit 0
fi
if [[ "$*" == *"get svc ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  if [[ "$POD_EXISTS" == "1" || "$KUBEVIRT_EXISTS" == "1" ]]; then
    printf '${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}'
    exit 0
  fi
  exit 1
fi
if [[ "$*" == *"scale deployment ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")} --replicas=0"* ]]; then
  POD_RUNNING=0
  POD_EXISTS=0
  save_state
  sleep 0.1
  exit 0
fi
if [[ "$*" == *"rollout restart deployment ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  POD_RUNNING=1
  POD_EXISTS=1
  save_state
  sleep 0.1
  exit 0
fi
if [[ "$*" == *"get vm ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "vm")}"* ]]; then
  [[ "$KUBEVIRT_EXISTS" == "1" ]] && printf '${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "vm")}'
  exit 0
fi
if [[ "$*" == *"get vmi ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "vm")}"* ]]; then
  [[ "$KUBEVIRT_RUNNING" == "1" ]] && printf 'Running'
  exit 0
fi
if [[ "$*" == *"get secret ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "vm-cloudinit")}"* ]]; then
  [[ "$KUBEVIRT_EXISTS" == "1" ]] && printf '${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "vm-cloudinit")}'
  exit 0
fi
if [[ "$*" == *"patch vm ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "vm")}"* && "$*" == *'"runStrategy":"Halted"'* ]]; then
  KUBEVIRT_RUNNING=0
  save_state
  sleep 0.1
  exit 0
fi
if [[ "$*" == *"patch vm ${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "vm")}"* && "$*" == *'"runStrategy":"Always"'* ]]; then
  KUBEVIRT_RUNNING=1
  KUBEVIRT_EXISTS=1
  save_state
  sleep 0.1
  exit 0
fi
if [[ "$*" == *"virt stop"* && "$*" == *"${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "vm")}"* ]]; then
  KUBEVIRT_RUNNING=0
  save_state
  sleep 0.1
  exit 0
fi
if [[ "$*" == *"virt start"* && "$*" == *"${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "vm")}"* ]]; then
  KUBEVIRT_RUNNING=1
  KUBEVIRT_EXISTS=1
  save_state
  sleep 0.1
  exit 0
fi
if [[ "$*" == *"virt restart"* && "$*" == *"${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, "demo", "vm")}"* ]]; then
  KUBEVIRT_RUNNING=1
  KUBEVIRT_EXISTS=1
  save_state
  sleep 0.1
  exit 0
fi
if [[ "$*" == *"port-forward svc/${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, "demo")}"* ]]; then
  port_spec=""
  for arg in "$@"; do
    case "$arg" in
      *:6767) port_spec="$arg" ;;
    esac
  done
  local_port="\${port_spec%%:*}"
  python3 - "$local_port" <<'PY' &
import socket
import sys
port = int(sys.argv[1])
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port))
s.listen(1)
conn, _ = s.accept()
conn.close()
s.close()
PY
  server_pid=$!
  trap 'kill $server_pid 2>/dev/null || true' EXIT TERM INT
  printf 'Forwarding from 127.0.0.1:%s -> 6767\n' "$local_port" >&2
  wait $server_pid
  exit 0
fi
if [[ "$1" == "exec" || "$*" == *" exec "* ]]; then
  exit 0
fi
if [[ "$1" == "cp" ]]; then
  exit 0
fi
if [[ "$1" == "-n" && "$3" == "delete" && "$4" == "pod" ]]; then
  exit 0
fi
exit 0
`,
      },
      async () => {
        const timingSummary: Array<{
          target: string;
          stopToStartMs: number;
          startToReadyMs: number;
          totalMs: number;
        }> = [];

        const dockerToGvisor = await captureOutput(async () => {
          await runCli(["switch", "demo@pod"]);
        });
        const gvisorStatus = parseJsonOutput<{ health: { backendLiveness: string; workspaceReadiness: string } }>(
          (await captureOutput(async () => runCli(["status", "demo@pod"]))).stdout,
        );
        assert.equal(gvisorStatus.health.backendLiveness, "running");
        assert.equal(gvisorStatus.health.workspaceReadiness, "ready");
        const gvisorDurations = parseSwitchDurations(dockerToGvisor.stderr);
        assert.ok(gvisorDurations.stopToStartMs >= 0);
        assert.ok(gvisorDurations.startToReadyMs >= 0);
        assert.ok(gvisorDurations.totalMs >= 0);
        timingSummary.push({
          target: "pod:gvisor",
          ...gvisorDurations,
        });

        const gvisorToKata = await captureOutput(async () => {
          await runCli(["switch", "demo@pod:kata-container"]);
        });
        const kataStatus = parseJsonOutput<{ health: { backendLiveness: string; workspaceReadiness: string } }>(
          (await captureOutput(async () => runCli(["status", "demo@pod:kata-container"]))).stdout,
        );
        assert.equal(kataStatus.health.backendLiveness, "running");
        assert.equal(kataStatus.health.workspaceReadiness, "ready");
        const kataDurations = parseSwitchDurations(gvisorToKata.stderr);
        assert.ok(kataDurations.stopToStartMs >= 0);
        assert.ok(kataDurations.startToReadyMs >= 0);
        assert.ok(kataDurations.totalMs >= 0);
        timingSummary.push({
          target: "pod:kata-container",
          ...kataDurations,
        });

        const kataToVm = await captureOutput(async () => {
          await runCli(["switch", "demo@kubevirt-vm"]);
        });
        const vmStatus = parseJsonOutput<{ health: { backendLiveness: string; workspaceReadiness: string } }>(
          (await captureOutput(async () => runCli(["status", "demo@kubevirt-vm"]))).stdout,
        );
        assert.equal(vmStatus.health.backendLiveness, "running");
        assert.equal(vmStatus.health.workspaceReadiness, "ready");
        const vmDurations = parseSwitchDurations(kataToVm.stderr);
        assert.ok(vmDurations.stopToStartMs >= 0);
        assert.ok(vmDurations.startToReadyMs >= 0);
        assert.ok(vmDurations.totalMs >= 0);
        timingSummary.push({
          target: "kubevirt-vm",
          ...vmDurations,
        });

        const vmToDocker = await captureOutput(async () => {
          await runCli(["switch", "demo@docker"]);
        });
        const dockerStatus = parseJsonOutput<{ health: { backendLiveness: string; workspaceReadiness: string } }>(
          (await captureOutput(async () => runCli(["status", "demo@docker"]))).stdout,
        );
        assert.equal(dockerStatus.health.backendLiveness, "running");
        assert.equal(dockerStatus.health.workspaceReadiness, "ready");
        const dockerDurations = parseSwitchDurations(vmToDocker.stderr);
        assert.ok(dockerDurations.stopToStartMs >= 0);
        assert.ok(dockerDurations.startToReadyMs >= 0);
        assert.ok(dockerDurations.totalMs >= 0);
        timingSummary.push({
          target: "docker",
          ...dockerDurations,
        });

        process.stderr.write(`[polaris-e2e] switch timings ${JSON.stringify(timingSummary)}\n`);

        const saved = JSON.parse(fs.readFileSync(driverSelectionPath, "utf8")) as {
          backend: string;
          profile?: string;
        };
        assert.equal(saved.backend, "docker");
      },
    );
  } finally {
    cleanupSelectionFile(project);
    removeIfExists(podProfilePath);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("logs command dispatches to each backend implementation", async () => {
  const podProject = `e2e-pod-${Date.now()}`;
  const dockerProject = `e2e-docker-${Date.now()}`;
  const vmProject = `e2e-vm-${Date.now()}`;
  const podSpec = writeProjectSpec("pod", podProject);
  const dockerSpec = writeProjectSpec("docker", dockerProject);
  const vmSpec = writeProjectSpec("kubevirt", vmProject);
  const podGeneratedPath = generatedOutputPath(loadWorkspaceFromRefForTest(`${podProject}@pod`));
  const dockerGeneratedPath = generatedOutputPath(loadWorkspaceFromRefForTest(`${dockerProject}@docker`));
  const vmGeneratedPath = generatedOutputPath(loadWorkspaceFromRefForTest(`${vmProject}@kubevirt-vm`));
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-trace-"));
  const traceFile = path.join(traceDir, "commands.log");

  try {
    await withFakePath(
      {
        kubectl: `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(traceFile)}
if [[ "$*" == *"get pod -l app=${podProject}"* ]]; then
  printf '${podProject}-pod'
  exit 0
fi
if [[ "$*" == *"get pod -l vm.kubevirt.io/name=${workspaceRuntimeResourceName(DEMO_USER_PROFILE_ID, vmProject, "vm")}"* ]]; then
  printf '${vmProject}-launcher'
  exit 0
fi
exit 0
`,
        docker: `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(traceFile)}
exit 0
`,
      },
      async () => {
        await runCli(["logs", podProject]);
        await runCli(["logs", dockerProject]);
        await runCli(["logs", vmProject]);
      },
    );

    const trace = fs.readFileSync(traceFile, "utf8");
    assert.match(
      trace,
      new RegExp(`logs deployment/${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, podProject)} --tail=200`),
    );
    assert.match(
      trace,
      new RegExp(`compose -f .*/workspaces/${dockerProject}/generated/docker\\.yaml logs --tail 200 ${workspaceRuntimeScopeName(DEMO_USER_PROFILE_ID, dockerProject)}`),
    );
    assert.match(trace, new RegExp(`logs ${vmProject}-launcher --tail=200`));
  } finally {
    removeIfExists(podSpec);
    removeIfExists(dockerSpec);
    removeIfExists(vmSpec);
    removeIfExists(podGeneratedPath);
    removeIfExists(dockerGeneratedPath);
    removeIfExists(vmGeneratedPath);
    removeIfExists(traceDir);
  }
});
