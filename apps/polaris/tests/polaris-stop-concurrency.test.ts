import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createExecutorServer } from "../scripts/executor/server.js";
import { stopPortalVault } from "../scripts/portal/service.js";
import { createCommand } from "../scripts/cli/commands/create.js";
import { createUserCommand } from "../scripts/cli/commands/create-user.js";
import {
  vaultSelectionPath,
  vaultStatusPath,
  writeVaultDriverSelection,
  writeVaultStatus,
} from "../scripts/output/state-store.js";
import { vaultRuntimeScopeName } from "../scripts/core/vault-name.js";
import { polarisUsersRoot } from "../scripts/utils/paths.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const USER_ROOT = polarisUsersRoot(import.meta.url);
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
  ]) {
    previousExecutorEnv.set(name, process.env[name]);
  }
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

test("portal vault stop waits for backend completion and converges both vaults", async () => {
  const userId = uniqueName("portal-stop-concurrent-user");
  const firstVault = uniqueName("portal-stop-concurrent-a");
  const secondVault = uniqueName("portal-stop-concurrent-b");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);
  try {
    await createUserCommand([userId, "--name", "Portal Stop Concurrent User", "--email", `${userId}@polaris.local`]);
    await createCommand([firstVault, "--user", userId]);
    await createCommand([secondVault, "--user", userId]);
    writeVaultDriverSelection(firstVault, { backend: "docker" }, userId);
    writeVaultDriverSelection(secondVault, { backend: "docker" }, userId);
    writeVaultStatus({
      project: firstVault,
      driver: {
        backend: "docker",
        baseImage: "ttl.sh/example:24h",
        runtimeKind: "docker-container",
        runtimeRef: `container/${vaultRuntimeScopeName(userId, firstVault)}-docker`,
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
    writeVaultStatus({
      project: secondVault,
      driver: {
        backend: "docker",
        baseImage: "ttl.sh/example:24h",
        runtimeKind: "docker-container",
        runtimeRef: `container/${vaultRuntimeScopeName(userId, secondVault)}-docker`,
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
          stopPortalVault(userId, firstVault),
          stopPortalVault(userId, secondVault),
        ]);
        const elapsedMs = Date.now() - startedAt;
        assert.ok(
          elapsedMs >= 550,
          `expected stop requests to wait for backend stop completion, received ${elapsedMs}ms`,
        );
        const firstStatus = JSON.parse(
          fs.readFileSync(vaultStatusPath(firstVault, userId), "utf8"),
        ) as { driver?: { status?: string } };
        const secondStatus = JSON.parse(
          fs.readFileSync(vaultStatusPath(secondVault, userId), "utf8"),
        ) as { driver?: { status?: string } };
        assert.equal(firstStatus.driver?.status, "stopped");
        assert.equal(secondStatus.driver?.status, "stopped");
      },
    );
  } finally {
    fs.rmSync(vaultSelectionPath(firstVault, userId), { force: true });
    fs.rmSync(vaultSelectionPath(secondVault, userId), { force: true });
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});
