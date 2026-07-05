import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCommand } from "../scripts/cli/commands/create.js";
import { createUserCommand } from "../scripts/cli/commands/create-user.js";
import { refreshPortalWorkspaceStatus } from "../scripts/executor/operations.js";
import {
  workspaceSelectionPath,
  workspaceStatusPath,
  writeWorkspaceDriverSelection,
  writeWorkspaceStatus,
} from "../scripts/output/state-store.js";
import { workspaceRuntimeScopeName } from "../scripts/core/workspace-name.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

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

test("status refresh converges stopped docker workspace when docker exec races after stop", async () => {
  const userId = uniqueName("portal-stop-refresh-user");
  const workspace = uniqueName("portal-stop-refresh-workspace");
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userId);
  try {
    await createUserCommand([
      userId,
      "--name",
      "Portal Stop Refresh User",
      "--email",
      `${userId}@polaris.local`,
    ]);
    await createCommand([workspace, "--user", userId]);
    writeWorkspaceDriverSelection(workspace, { backend: "docker" }, userId);
    writeWorkspaceStatus(
      {
        project: workspace,
        driver: {
          backend: "docker",
          baseImage: "ttl.sh/example:24h",
          runtimeKind: "docker-container",
          runtimeRef: `container/${workspaceRuntimeScopeName(userId, workspace)}-docker`,
        },
        health: {
          backendLiveness: "stopping",
          workspaceReadiness: "not-ready",
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
        await refreshPortalWorkspaceStatus(userId, workspace);
      },
    );

    const status = JSON.parse(
      fs.readFileSync(workspaceStatusPath(workspace, userId), "utf8"),
    ) as {
      health: { backendLiveness: string; workspaceReadiness: string; reason?: string };
    };
    assert.equal(status.health.backendLiveness, "stopped");
    assert.equal(status.health.workspaceReadiness, "not-ready");
  } finally {
    fs.rmSync(workspaceSelectionPath(workspace, userId), { force: true });
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});
