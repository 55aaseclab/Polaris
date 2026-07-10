import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCommand } from "../scripts/cli/commands/create.js";
import { createUserCommand } from "../scripts/cli/commands/create-user.js";
import {
  listPortalWorkspaceStaticSummaries,
  loadWorkspaceDetailStatic,
  projectPortalWorkspaceLiveStatus,
  readWorkspaceStatus,
  readPortalWorkspaceLiveSummary,
  type PortalWorkspaceStreamEvent,
} from "../scripts/core/portal.js";
import {
  workspaceSelectionPath,
  workspaceStatusPath,
  writeWorkspaceDriverSelection,
  writeWorkspaceStatus,
} from "../scripts/output/state-store.js";
import { updatePortalWorkspaceSelectedDriver } from "../scripts/executor/operations.js";
import { queueProvisionWorkspace } from "../scripts/executor/operations.js";
import { subscribePortalWorkspaceStream } from "../scripts/portal/workspace-live-hub.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

async function withTempPortalWorkspace(
  fn: (input: { userId: string; workspace: string }) => Promise<void>,
): Promise<void> {
  const userId = uniqueName("portal-live-user");
  const workspace = uniqueName("portal-live-workspace");
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userId);
  try {
    await createUserCommand([userId, "--name", "Portal Live User", "--email", `${userId}@polaris.local`]);
    await createCommand([workspace, "--user", userId]);
    await fn({ userId, workspace });
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
}

test("portal workspace projections split static, live, and detail-static data", async () => {
  await withTempPortalWorkspace(async ({ userId, workspace }) => {
    writeWorkspaceDriverSelection(workspace, { backend: "docker" }, userId);
    writeWorkspaceStatus({
      project: workspace,
      driver: {
        selected: { backend: "docker" },
        status: "running",
        runtimeKind: "docker-container",
        runtimeRef: `container/${workspace}-docker`,
      },
      paseo: {
        daemon: "ready",
        web: "connectable",
        reconnectMode: "reconnectable",
        liveTarget: "http://127.0.0.1:6767/h/demo",
        reconnectTarget: "http://127.0.0.1:6767/h/demo/reconnect",
      },
      details: {
        backendDetail: "docker ready",
      },
      credentials: {
        live: {
          supportedHarnesses: ["codex"],
          switchableHarnesses: ["codex"],
          selectedHarness: "codex",
          selectedCredentialId: "codex-rightcode",
          selectedCredentialLabel: "Codex RightCode",
          source: "user-active",
        },
      },
      evolution: {
        artifactCount: 2,
        activeWorkspaceArtifacts: 1,
        activeUserArtifacts: 1,
        latestTitles: ["Latest artifact"],
      },
    }, userId);

    const staticSummaries = listPortalWorkspaceStaticSummaries(userId);
    assert.equal(staticSummaries.length, 1);
    assert.equal(staticSummaries[0]?.name, workspace);
    assert.ok(staticSummaries[0]?.availableDrivers.some((driver) => driver.backend === "docker" && driver.available));

    const liveSummary = readPortalWorkspaceLiveSummary(userId, workspace);
    assert.equal(liveSummary.status?.driver?.status, "running");
    assert.equal(liveSummary.status?.paseo.web, "connectable");
    assert.equal(liveSummary.status?.credentials?.live?.selectedCredentialId, "codex-rightcode");
    assert.equal("details" in (liveSummary.status ?? {}), false);
    assert.equal("assets" in (liveSummary.status ?? {}), false);

    const detailStatic = loadWorkspaceDetailStatic(userId, workspace);
    assert.equal(detailStatic.name, workspace);
    assert.ok(Array.isArray(detailStatic.availableDrivers));
    assert.ok(Array.isArray(detailStatic.credentialBindings));
    assert.ok(detailStatic.assets?.dockerfile.path);
  });
});

test("workspace live hub publishes snapshot and live updates after status writes", async () => {
  await withTempPortalWorkspace(async ({ userId, workspace }) => {
    writeWorkspaceDriverSelection(workspace, { backend: "docker" }, userId);
    writeWorkspaceStatus({
      project: workspace,
      driver: {
        selected: { backend: "docker" },
        status: "stopped",
      },
      paseo: {
        daemon: "unknown",
        web: "unavailable",
        reconnectMode: "unknown",
        liveTarget: null,
        reconnectTarget: null,
      },
      details: {},
    }, userId);

    const events: PortalWorkspaceStreamEvent[] = [];
    const unsubscribe = subscribePortalWorkspaceStream(userId, (event) => {
      events.push(event);
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(events[0]?.type, "snapshot");
      writeWorkspaceStatus({
        project: workspace,
        driver: {
          selected: { backend: "docker" },
          status: "running",
        },
        paseo: {
          daemon: "ready",
          web: "connectable",
          reconnectMode: "reconnectable",
          liveTarget: "http://127.0.0.1:6767/h/demo",
          reconnectTarget: null,
        },
        details: {},
      }, userId);

      await new Promise<void>((resolve, reject) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
          const found = events.find((event) =>
            event.type === "live-upsert"
            && event.workspace.name === workspace
            && event.workspace.status?.driver?.status === "running"
          );
          if (found) {
            clearInterval(timer);
            resolve();
            return;
          }
          if (Date.now() - startedAt > 4000) {
            clearInterval(timer);
            reject(new Error("Timed out waiting for live-upsert"));
          }
        }, 50);
      });
    } finally {
      unsubscribe();
    }
  });
});

test("updating selected driver creates live driver state for workspaces without a status file", async () => {
  await withTempPortalWorkspace(async ({ userId, workspace }) => {
    const statusPath = workspaceStatusPath(workspace, userId);
    fs.rmSync(statusPath, { force: true });

    const events: PortalWorkspaceStreamEvent[] = [];
    const unsubscribe = subscribePortalWorkspaceStream(userId, (event) => {
      events.push(event);
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await updatePortalWorkspaceSelectedDriver({
        userId,
        workspace,
        target: { backend: "pod", profile: "gvisor" },
      });

      await new Promise<void>((resolve, reject) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
          const found = events.find((event) =>
            event.type === "live-upsert"
            && event.workspace.name === workspace
            && event.workspace.status?.driver?.selected?.backend === "pod"
            && event.workspace.status?.driver?.selected?.profile === "gvisor"
          );
          if (found) {
            clearInterval(timer);
            resolve();
            return;
          }
          if (Date.now() - startedAt > 4000) {
            clearInterval(timer);
            reject(new Error("Timed out waiting for selected-driver live-upsert"));
          }
        }, 50);
      });

      const persisted = JSON.parse(fs.readFileSync(statusPath, "utf8")) as {
        driver?: {
          selected?: { backend?: string; profile?: string };
          status?: string;
        };
      };
      assert.equal(persisted.driver?.selected?.backend, "pod");
      assert.equal(persisted.driver?.selected?.profile, "gvisor");
      assert.equal(persisted.driver?.status, "unknown");
    } finally {
      unsubscribe();
    }
  });
});

test("workspace live stream emits starting during create-and-start flow", async () => {
  const userId = uniqueName("portal-live-create-user");
  const workspace = uniqueName("portal-live-create-workspace");
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userId);
  const previousDelay = process.env.POLARIS_TEST_PROVISION_STEP_DELAY_MS;
  process.env.POLARIS_TEST_PROVISION_STEP_DELAY_MS = "150";
  try {
    await createUserCommand([userId, "--name", "Portal Live Create User", "--email", `${userId}@polaris.local`]);
    const events: PortalWorkspaceStreamEvent[] = [];
    const unsubscribe = subscribePortalWorkspaceStream(userId, (event) => {
      events.push(event);
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await queueProvisionWorkspace(userId, workspace, {
        defaultDockerOnly: true,
        startAfterCreate: true,
      });

      await new Promise<void>((resolve, reject) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
          const hasStarting = events.some((event) =>
            event.type === "live-upsert"
            && event.workspace.name === workspace
            && event.workspace.status?.driver?.status === "starting"
          );
          if (hasStarting) {
            clearInterval(timer);
            resolve();
            return;
          }
          if (Date.now() - startedAt > 8000) {
            clearInterval(timer);
            reject(new Error(`Timed out waiting for starting/running events: ${JSON.stringify(events)}`));
          }
        }, 50);
      });

      const statuses = events
        .filter((event) => event.type === "live-upsert" && event.workspace.name === workspace)
        .map((event) => event.workspace.status?.driver?.status ?? null);
      const startingIndex = statuses.indexOf("starting");
      assert.notEqual(startingIndex, -1);
      const stoppedIndex = statuses.indexOf("stopped");
      assert.notEqual(stoppedIndex, -1);
      assert.ok(stoppedIndex < startingIndex);
    } finally {
      unsubscribe();
    }
  } finally {
    if (previousDelay === undefined) {
      delete process.env.POLARIS_TEST_PROVISION_STEP_DELAY_MS;
    } else {
      process.env.POLARIS_TEST_PROVISION_STEP_DELAY_MS = previousDelay;
    }
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("portal live projection keeps the canonical live fields only", () => {
  const projected = projectPortalWorkspaceLiveStatus({
    project: "demo",
    schemaVersion: 1.1,
    driver: {
      selected: { backend: "docker" },
      status: "running",
      reason: "ready",
    },
    paseo: {
      daemon: "ready",
      web: "connectable",
      reconnectMode: "reconnectable",
      liveTarget: "http://127.0.0.1:6767/h/demo",
      reconnectTarget: null,
    },
    details: {
      backendDetail: "detail",
    },
    assets: {
      dockerfile: {
        file: "Dockerfile",
        path: "config/users/demo/workspaces/demo/Dockerfile",
      },
      specs: [],
      generatedManifests: [],
      imageTags: [],
      evolutionFiles: [],
      persistentVolumes: [],
    },
  });

  assert.equal(projected?.driver?.status, "running");
  assert.equal(projected?.paseo.daemon, "ready");
  assert.equal("details" in (projected ?? {}), false);
  assert.equal("assets" in (projected ?? {}), false);
});

test("writeWorkspaceStatus removes obsolete selection.json files", async () => {
  await withTempPortalWorkspace(async ({ userId, workspace }) => {
    const selectionPath = workspaceSelectionPath(workspace, userId);
    fs.mkdirSync(path.dirname(selectionPath), { recursive: true });
    fs.writeFileSync(selectionPath, `${JSON.stringify({ backend: "docker" }, null, 2)}\n`, "utf8");
    assert.equal(fs.existsSync(selectionPath), true);

    writeWorkspaceStatus({
      project: workspace,
      driver: {
        selected: { backend: "docker" },
        status: "running",
      },
      paseo: {
        daemon: "ready",
        web: "connectable",
        reconnectMode: "reconnectable",
        liveTarget: "http://127.0.0.1:6767/h/demo",
        reconnectTarget: null,
      },
      details: {},
    }, userId);

    assert.equal(fs.existsSync(selectionPath), false);
    const status = JSON.parse(fs.readFileSync(workspaceStatusPath(workspace, userId), "utf8")) as {
      driver?: { selected?: { backend?: string } | null };
    };
    assert.equal(status.driver?.selected?.backend, "docker");
  });
});
