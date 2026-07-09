import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createExecutorServer } from "../scripts/executor/server.js";
import { stopPortalWorkspace } from "../scripts/portal/service.js";
import { createCommand } from "../scripts/cli/commands/create.js";
import { createUserCommand } from "../scripts/cli/commands/create-user.js";
import {
  workspaceSelectionPath,
  workspaceStatusPath,
  writeWorkspaceDriverSelection,
  writeWorkspaceStatus,
} from "../scripts/output/state-store.js";
import { workspaceRuntimeScopeName } from "../scripts/core/workspace-name.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const EXECUTOR_TEST_SECRET = "polaris-executor-test-secret";
const previousExecutorEnv = new Map<string, string | undefined>();

let executorServer: import("node:http").Server | null = null;

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

async function withFakePath(
  commands: Record<string, string>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-stop-concurrency-"));
  const originalPath = process.env.PATH || "";
  for (const [name, body] of Object.entries(commands)) {
    fs.writeFileSync(
      path.join(tempDir, name),
      `#!/usr/bin/env bash
${body}
`,
      { mode: 0o755 },
    );
  }
  process.env.PATH = `${tempDir}:${originalPath}`;
  try {
    await fn();
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test.before(async () => {
  for (const name of [
    "POLARIS_EXECUTOR_BASE_URL",
    "POLARIS_EXECUTOR_SHARED_SECRET",
  ]) {
    previousExecutorEnv.set(name, process.env[name]);
  }
  process.env.POLARIS_EXECUTOR_SHARED_SECRET = EXECUTOR_TEST_SECRET;
  executorServer = createExecutorServer(0);
  await once(executorServer, "listening");
  const address = executorServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Executor server did not expose a TCP address");
  }
  process.env.POLARIS_EXECUTOR_BASE_URL = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  if (executorServer) {
    executorServer.close();
    await once(executorServer, "close");
    executorServer = null;
  }
  for (const [name, value] of previousExecutorEnv.entries()) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

test("portal workspace stop waits for backend completion and converges both workspaces", async () => {
  const userId = uniqueName("portal-stop-concurrent-user");
  const firstWorkspace = uniqueName("portal-stop-concurrent-a");
  const secondWorkspace = uniqueName("portal-stop-concurrent-b");
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userId);
  try {
    await createUserCommand([userId, "--name", "Portal Stop Concurrent User", "--email", `${userId}@polaris.local`]);
    await createCommand([firstWorkspace, "--user", userId]);
    await createCommand([secondWorkspace, "--user", userId]);
    writeWorkspaceDriverSelection(firstWorkspace, { backend: "docker" }, userId);
    writeWorkspaceDriverSelection(secondWorkspace, { backend: "docker" }, userId);
    writeWorkspaceStatus({
      project: firstWorkspace,
      driver: {
        backend: "docker",
        baseImage: "ttl.sh/example:24h",
        runtimeKind: "docker-container",
        runtimeRef: `container/${workspaceRuntimeScopeName(userId, firstWorkspace)}-docker`,
      },
      runtime: {
        selectedDriver: { backend: "docker" },
        lifecycle: "running",
        reason: "test setup",
      },
      paseo: {
        daemon: "ready",
        web: "connectable",
        reconnectMode: "reconnectable",
        liveTarget: "https://app.paseo.test/#offer=a",
        reconnectTarget: "https://app.paseo.test/h/srv_a?scope=test",
        reason: "test setup",
      },
      details: {},
    }, userId);
    writeWorkspaceStatus({
      project: secondWorkspace,
      driver: {
        backend: "docker",
        baseImage: "ttl.sh/example:24h",
        runtimeKind: "docker-container",
        runtimeRef: `container/${workspaceRuntimeScopeName(userId, secondWorkspace)}-docker`,
      },
      runtime: {
        selectedDriver: { backend: "docker" },
        lifecycle: "running",
        reason: "test setup",
      },
      paseo: {
        daemon: "ready",
        web: "connectable",
        reconnectMode: "reconnectable",
        liveTarget: "https://app.paseo.test/#offer=b",
        reconnectTarget: "https://app.paseo.test/h/srv_b?scope=test",
        reason: "test setup",
      },
      details: {},
    }, userId);

    await withFakePath(
      {
        docker: "if [ \"$1\" = \"compose\" ] && [ \"$4\" = \"stop\" ]; then sleep 0.6; exit 0; fi\nif [ \"$1\" = \"compose\" ] && [ \"$4\" = \"ps\" ]; then exit 0; fi\nif [ \"$1\" = \"compose\" ]; then exit 0; fi\nif [ \"$1\" = \"image\" ] && [ \"$2\" = \"inspect\" ]; then exit 0; fi\nexit 0\n",
        kubectl: "exit 0\n",
      },
      async () => {
        const startedAt = Date.now();
        await Promise.all([
          stopPortalWorkspace(userId, firstWorkspace),
          stopPortalWorkspace(userId, secondWorkspace),
        ]);
        const elapsedMs = Date.now() - startedAt;
        assert.ok(
          elapsedMs >= 550,
          `expected stop requests to wait for backend stop completion, received ${elapsedMs}ms`,
        );
        const firstStatus = JSON.parse(
          fs.readFileSync(workspaceStatusPath(firstWorkspace, userId), "utf8"),
        ) as { driver?: { status?: string } };
        const secondStatus = JSON.parse(
          fs.readFileSync(workspaceStatusPath(secondWorkspace, userId), "utf8"),
        ) as { driver?: { status?: string } };
        assert.equal(firstStatus.driver?.status, "stopped");
        assert.equal(secondStatus.driver?.status, "stopped");
      },
    );
  } finally {
    fs.rmSync(workspaceSelectionPath(firstWorkspace, userId), { force: true });
    fs.rmSync(workspaceSelectionPath(secondWorkspace, userId), { force: true });
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});
