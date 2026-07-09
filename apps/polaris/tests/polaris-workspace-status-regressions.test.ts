import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function withTempDataRoot(
  fn: (dataRoot: string) => Promise<void>,
): Promise<void> {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-status-regression-"));
  const previousDataRoot = process.env.POLARIS_DATA_ROOT;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.POLARIS_DATA_ROOT = dataRoot;
  process.env.NODE_ENV = "test";
  try {
    await fn(dataRoot);
  } finally {
    if (previousDataRoot === undefined) {
      delete process.env.POLARIS_DATA_ROOT;
    } else {
      process.env.POLARIS_DATA_ROOT = previousDataRoot;
    }
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

test("normalizeWorkspaceStatus accepts schema-less 1.1-shaped statuses", async () => {
  await withTempDataRoot(async () => {
    const { normalizeWorkspaceStatus } = await import(
      `../scripts/output/state-store.ts?case=${Date.now()}`
    );
    const normalized = normalizeWorkspaceStatus({
      project: "demo",
      driver: {
        selected: { backend: "docker" },
        status: "running",
        reason: "heartbeat",
      },
      paseo: {
        daemon: "ready",
        web: "connectable",
        reconnectMode: "reconnectable",
        liveTarget: null,
        reconnectTarget: null,
      },
      details: {},
    });
    assert.equal(normalized.schemaVersion, 1.1);
    assert.equal(normalized.driver?.status, "running");
    assert.deepEqual(normalized.driver?.selected, { backend: "docker" });
  });
});

test("reportPortalWorkspaceStatus tolerates current statuses without paseo", async () => {
  await withTempDataRoot(async (dataRoot) => {
    const { reportPortalWorkspaceStatus } = await import(
      `../scripts/executor/operations.ts?case=${Date.now()}`
    );
    const statusPath = path.join(
      dataRoot,
      "users",
      "demo-user",
      "workspaces",
      "demo-workspace",
      "state",
      "status.json",
    );
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(
      statusPath,
      `${JSON.stringify({
        schemaVersion: 1.1,
        project: "demo-workspace",
        driver: {
          selected: null,
          status: "unknown",
        },
        details: {},
      }, null, 2)}\n`,
      "utf8",
    );

    await assert.doesNotReject(async () => {
      await reportPortalWorkspaceStatus({
        userId: "demo-user",
        workspace: "demo-workspace",
        status: {
          driver: {
            selected: { backend: "docker" },
            status: "running",
            reason: "runtime status observer heartbeat",
          },
          details: {
            backendDetail: "runtime status observer heartbeat",
          },
        },
      });
    });

    const persisted = JSON.parse(fs.readFileSync(statusPath, "utf8")) as {
      driver?: { selected?: { backend?: string }; status?: string };
      paseo?: { daemon?: string; web?: string };
    };
    assert.equal(persisted.driver?.selected?.backend, "docker");
    assert.equal(persisted.driver?.status, "running");
    assert.equal(persisted.paseo?.daemon, "unknown");
    assert.equal(persisted.paseo?.web, "unavailable");
  });
});
