import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCommand } from "../scripts/cli/commands/create.js";
import { createUserCommand } from "../scripts/cli/commands/create-user.js";
import { refreshPortalVaultStatus } from "../scripts/control-plane/operations.js";
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

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

async function withFakePath(
  commands: Record<string, string>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-stop-refresh-race-"));
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

test("status refresh converges stopped docker vault when docker exec races after stop", async () => {
  const userId = uniqueName("portal-stop-refresh-user");
  const vault = uniqueName("portal-stop-refresh-vault");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);
  try {
    await createUserCommand([
      userId,
      "--name",
      "Portal Stop Refresh User",
      "--email",
      `${userId}@polaris.local`,
    ]);
    await createCommand([vault, "--user", userId]);
    writeVaultDriverSelection(vault, { backend: "docker" }, userId);
    writeVaultStatus(
      {
        project: vault,
        driver: {
          backend: "docker",
          baseImage: "ttl.sh/example:24h",
          runtimeKind: "docker-container",
          runtimeRef: `container/${vaultRuntimeScopeName(userId, vault)}-docker`,
        },
        operation: {
          kind: "stop",
          updatedAt: new Date().toISOString(),
        },
        runtime: {
          selectedDriver: { backend: "docker" },
          lifecycle: "running",
          reason: "test setup",
        },
        paseo: {
          daemon: "pending",
          web: "pairing-required",
          reconnectMode: "needs-pairing",
          liveTarget: "https://app.paseo.test/#offer=stop-refresh",
          reconnectTarget: "https://app.paseo.test/#offer=stop-refresh",
          reason: "test setup",
        },
        details: {},
      },
      userId,
    );

    await withFakePath(
      {
        docker: `
if [ "$1" = "compose" ] && [ "$4" = "ps" ]; then
  printf '%s\\n' "fake-container-id"
  exit 0
fi
if [ "$1" = "inspect" ]; then
  printf '%s\\n' '[{"State":{"Running":true}}]'
  exit 0
fi
if [ "$1" = "exec" ]; then
  echo 'cannot exec in a stopped state: unknown' >&2
  exit 126
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  exit 0
fi
exit 0
`,
        kubectl: "exit 0\n",
      },
      async () => {
        await refreshPortalVaultStatus(userId, vault);
      },
    );

    const status = JSON.parse(
      fs.readFileSync(vaultStatusPath(vault, userId), "utf8"),
    ) as {
      driver?: { status?: string; reason?: string };
    };
    assert.equal(status.driver?.status, "stopped");
  } finally {
    fs.rmSync(vaultSelectionPath(vault, userId), { force: true });
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});
