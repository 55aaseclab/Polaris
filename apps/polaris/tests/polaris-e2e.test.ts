import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runCli } from "../scripts/cli/main.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const STDOUT_CAPTURE_QUEUE_KEY = "__polaris_stdout_capture_queue__";

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

function removeIfExists(target: string): void {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
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

function selectionPath(project: string): string {
  return path.join(REPO_ROOT, "config", "state", `${project}.selection.json`);
}

function writeProjectSpec(backendDir: "pod" | "docker" | "kubevirt", project: string): string {
  const sourcePath = path.join(REPO_ROOT, "config", "specs", backendDir, "projects", "demo.agent.yaml");
  const outputPath = path.join(REPO_ROOT, "config", "specs", backendDir, "projects", `${project}.agent.yaml`);
  const source = fs.readFileSync(sourcePath, "utf8").replace(/^project: demo$/m, `project: ${project}`);
  fs.writeFileSync(outputPath, source, "utf8");
  return outputPath;
}

test("create scaffolds a docker-first saved spec when the project is new", async () => {
  const project = `e2e-create-${Date.now()}`;
  const profileEmail = `${project}@polaris.local`;
  const configPath = path.join(REPO_ROOT, "config", "specs", "docker", "projects", `${project}.agent.yaml`);
  const userProfileId = `local-${project}-polaris.local`;
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const secretsRoot = path.join(REPO_ROOT, "config", "users", userProfileId);

  try {
    await withEnv(
      {
        GIT_AUTHOR_NAME: "E2E Create",
        GIT_AUTHOR_EMAIL: profileEmail,
      },
      async () => {
        const output = await captureStdout(async () => {
          await runCli(["create", project]);
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
        }>(output);

        assert.equal(fs.existsSync(configPath), true);
        const rendered = fs.readFileSync(configPath, "utf8");
        assert.match(rendered, /backend:\n  kind: docker/);
        assert.match(rendered, /profile: morpheus/);
        assert.match(rendered, new RegExp(`user_profile: '?${userProfileId}'?`));
        assert.equal(parsed.created, "saved-spec");
        assert.equal(parsed.project, project);
        assert.equal(parsed.userProfile.id, userProfileId);
        assert.equal(parsed.userProfile.created, true);
        assert.equal(parsed.userProfile.profilePath, `config/users/profiles/${userProfileId}.yaml`);
        assert.equal(parsed.userProfile.secretsRoot, `config/users/${userProfileId}`);
        assert.equal(fs.existsSync(profilePath), true);
        assert.equal(fs.existsSync(path.join(secretsRoot, ".gitignore")), true);
      },
    );
  } finally {
    removeIfExists(configPath);
    removeIfExists(profilePath);
    removeIfExists(secretsRoot);
  }
});

test("default CLI dispatch uses status instead of apply", async () => {
  await withFakePath(
    {
      kubectl: `#!/usr/bin/env bash
if [[ "$*" == *"get deployment demo"* ]]; then
  printf '{"metadata":{"name":"demo"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=demo"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$1" == "exec" || "$*" == *" exec "* ]]; then
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
        await runCli(["demo"]);
      });
      assert.match(output, /"lifecycleAction": "status"/);
      assert.match(output, /"statusFile":/);
    },
  );
});

test("backend selectors disambiguate shared project names like demo@docker", async () => {
  await withFakePath(
    {
      docker: `#!/usr/bin/env bash
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
      const output = await captureStdout(async () => {
        await runCli(["status", "demo@docker"]);
      });
      assert.match(output, /"kind": "docker"/);
      assert.match(output, /"project": "demo"/);
    },
  );
});

test("switch stops the previous backend, starts the new backend, and updates defaults", async () => {
  const project = "demo";
  const driverSelectionPath = selectionPath(project);
  removeIfExists(driverSelectionPath);

  try {
    await withFakePath(
      {
        docker: `#!/usr/bin/env bash
if [[ "$*" == *" stop"* ]]; then
  exit 0
fi
if [[ "$*" == *" up -d"* ]]; then
  exit 0
fi
if [[ "$*" == *"compose"* && "$*" == *"ps -q demo"* ]]; then
  printf 'docker-id'
  exit 0
fi
if [[ "$*" == *"inspect docker-id"* ]]; then
  printf '[{"State":{"Running":true}}]'
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  exit 0
fi
exit 0
`,
        kubectl: `#!/usr/bin/env bash
if [[ "$*" == *"apply -f "* ]]; then
  exit 0
fi
if [[ "$*" == *"rollout restart"* ]]; then
  exit 0
fi
if [[ "$*" == *"get deployment demo"* ]]; then
  printf '{"metadata":{"name":"demo"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=demo"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$1" == "exec" || "$*" == *" exec "* ]]; then
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
    removeIfExists(driverSelectionPath);
  }
});

test("switch accepts pod driver variants such as kata", async () => {
  const project = "demo";
  const driverSelectionPath = selectionPath(project);
  removeIfExists(driverSelectionPath);

  try {
    await withFakePath(
      {
        kubectl: `#!/usr/bin/env bash
if [[ "$*" == *"apply -f "* ]]; then
  exit 0
fi
if [[ "$*" == *"get deployment demo"* ]]; then
  printf '{"metadata":{"name":"demo"}}'
  exit 0
fi
if [[ "$*" == *"get pod -l app=demo"* ]]; then
  printf 'pod-1'
  exit 0
fi
if [[ "$1" == "exec" || "$*" == *" exec "* ]]; then
  exit 0
fi
if [[ "$*" == *"get svc demo"* ]]; then
  printf 'demo'
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
    removeIfExists(driverSelectionPath);
  }
});

test("logs command dispatches to each backend implementation", async () => {
  const podProject = `e2e-pod-${Date.now()}`;
  const dockerProject = `e2e-docker-${Date.now()}`;
  const vmProject = `e2e-vm-${Date.now()}`;
  const podSpec = writeProjectSpec("pod", podProject);
  const dockerSpec = writeProjectSpec("docker", dockerProject);
  const vmSpec = writeProjectSpec("kubevirt", vmProject);
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
if [[ "$*" == *"get pod -l vm.kubevirt.io/name=${vmProject}-vm"* ]]; then
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
    assert.match(trace, new RegExp(`logs ${podProject}-pod --tail=200`));
    assert.match(trace, new RegExp(`compose -f .*${dockerProject}\\.yaml logs --tail 200 ${dockerProject}`));
    assert.match(trace, new RegExp(`logs ${vmProject}-launcher --tail=200`));
  } finally {
    removeIfExists(podSpec);
    removeIfExists(dockerSpec);
    removeIfExists(vmSpec);
    removeIfExists(path.join(REPO_ROOT, "config", "generated", "pod", `${podProject}.yaml`));
    removeIfExists(path.join(REPO_ROOT, "config", "generated", "docker", `${dockerProject}.yaml`));
    removeIfExists(path.join(REPO_ROOT, "config", "generated", "kubevirt", `${vmProject}.yaml`));
    removeIfExists(traceDir);
  }
});
