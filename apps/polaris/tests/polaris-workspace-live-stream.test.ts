import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCommand } from "../scripts/cli/commands/create.js";
import { createUserCommand } from "../scripts/cli/commands/create-user.js";
import { deleteVaultOwnedByUser } from "../scripts/cli/commands/delete.js";
import {
  listPortalVaultStaticSummaries,
  loadVaultDetailStatic,
  projectPortalVaultLiveStatus,
  readVaultStatus,
  readPortalVaultLiveSummary,
  type PortalVaultStreamEvent,
} from "../scripts/core/portal.js";
import {
  vaultSelectionPath,
  vaultStatusPath,
  writeVaultDriverSelection,
  writeVaultStatus,
} from "../scripts/output/state-store.js";
import {
  queueProvisionVault,
  stopPortalVault,
  updatePortalVaultSelectedDriver,
} from "../scripts/control-plane/operations.js";
import { subscribePortalVaultStream } from "../scripts/portal/vault-live-hub.js";
import { polarisUsersRoot } from "../scripts/utils/paths.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const USER_ROOT = polarisUsersRoot(import.meta.url);

function repoRelative(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, "/") || ".";
}

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

async function cleanupStartedVault(userId: string, vault: string): Promise<void> {
  try {
    await stopPortalVault(userId, vault);
  } catch {
    // Ignore cleanup failures so file cleanup still runs.
  }
  try {
    await deleteVaultOwnedByUser(userId, vault);
  } catch {
    // Ignore cleanup failures so file cleanup still runs.
  }
}

async function withTempPortalVault(
  fn: (input: { userId: string; vault: string }) => Promise<void>,
): Promise<void> {
  const userId = uniqueName("portal-live-user");
  const vault = uniqueName("portal-live-vault");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);
  try {
    await createUserCommand([userId, "--name", "Portal Live User", "--email", `${userId}@polaris.local`]);
    await createCommand([vault, "--user", userId]);
    await fn({ userId, vault });
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
}

test("portal vault projections split static, live, and detail-static data", async () => {
  await withTempPortalVault(async ({ userId, vault }) => {
    writeVaultDriverSelection(vault, { backend: "docker" }, userId);
    writeVaultStatus({
      project: vault,
      driver: {
        selected: { backend: "docker" },
        status: "running",
        runtimeKind: "docker-container",
        runtimeRef: `container/${vault}-docker`,
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
        activeVaultArtifacts: 1,
        activeUserArtifacts: 1,
        latestTitles: ["Latest artifact"],
      },
    }, userId);

    const staticSummaries = listPortalVaultStaticSummaries(userId);
    assert.equal(staticSummaries.length, 1);
    assert.equal(staticSummaries[0]?.name, vault);
    assert.ok(staticSummaries[0]?.availableDrivers.some((driver) => driver.backend === "docker" && driver.available));

    const liveSummary = readPortalVaultLiveSummary(userId, vault);
    assert.equal(liveSummary.status?.driver?.status, "running");
    assert.equal(liveSummary.status?.paseo.web, "connectable");
    assert.equal(liveSummary.status?.credentials?.live?.selectedCredentialId, "codex-rightcode");
    assert.equal("details" in (liveSummary.status ?? {}), false);
    assert.equal("assets" in (liveSummary.status ?? {}), false);

    const detailStatic = loadVaultDetailStatic(userId, vault);
    assert.equal(detailStatic.name, vault);
    assert.ok(Array.isArray(detailStatic.availableDrivers));
    assert.ok(Array.isArray(detailStatic.credentialBindings));
    assert.ok(detailStatic.assets?.dockerfile.path);
  });
});

test("vault live hub publishes snapshot and live updates after status writes", async () => {
  await withTempPortalVault(async ({ userId, vault }) => {
    writeVaultDriverSelection(vault, { backend: "docker" }, userId);
    writeVaultStatus({
      project: vault,
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

    const events: PortalVaultStreamEvent[] = [];
    const unsubscribe = subscribePortalVaultStream(userId, (event) => {
      events.push(event);
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(events[0]?.type, "snapshot");
      writeVaultStatus({
        project: vault,
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
            && event.vault.name === vault
            && event.vault.status?.driver?.status === "running"
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

test("updating selected driver creates live driver state for vaults without a status file", async () => {
  await withTempPortalVault(async ({ userId, vault }) => {
    const statusPath = vaultStatusPath(vault, userId);
    fs.rmSync(statusPath, { force: true });

    const events: PortalVaultStreamEvent[] = [];
    const unsubscribe = subscribePortalVaultStream(userId, (event) => {
      events.push(event);
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await updatePortalVaultSelectedDriver({
        userId,
        vault,
        target: { backend: "pod", profile: "gvisor" },
      });

      await new Promise<void>((resolve, reject) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
          const found = events.find((event) =>
            event.type === "live-upsert"
            && event.vault.name === vault
            && event.vault.status?.driver?.selected?.backend === "pod"
            && event.vault.status?.driver?.selected?.profile === "gvisor"
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

test("vault live stream emits starting during create-and-start flow", async () => {
  const userId = uniqueName("portal-live-create-user");
  const vault = uniqueName("portal-live-create-vault");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);
  const previousDelay = process.env.POLARIS_TEST_PROVISION_STEP_DELAY_MS;
  process.env.POLARIS_TEST_PROVISION_STEP_DELAY_MS = "150";
  try {
    await createUserCommand([userId, "--name", "Portal Live Create User", "--email", `${userId}@polaris.local`]);
    const events: PortalVaultStreamEvent[] = [];
    const unsubscribe = subscribePortalVaultStream(userId, (event) => {
      events.push(event);
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await queueProvisionVault(userId, vault, {
        defaultDockerOnly: true,
        startAfterCreate: true,
      });

      await new Promise<void>((resolve, reject) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
          const hasStarting = events.some((event) =>
            event.type === "live-upsert"
            && event.vault.name === vault
            && event.vault.status?.driver?.status === "starting"
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
        .filter((event) => event.type === "live-upsert" && event.vault.name === vault)
        .map((event) => event.vault.status?.driver?.status ?? null);
      const startingIndex = statuses.indexOf("starting");
      assert.notEqual(startingIndex, -1);
      const stoppedIndex = statuses.indexOf("stopped");
      assert.notEqual(stoppedIndex, -1);
      assert.ok(stoppedIndex < startingIndex);
    } finally {
      unsubscribe();
    }
  } finally {
    await cleanupStartedVault(userId, vault);
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
  const projected = projectPortalVaultLiveStatus({
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
        path: repoRelative(path.join(USER_ROOT, "demo", "vaults", "demo", "Dockerfile")),
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

test("writeVaultStatus removes obsolete selection.json files", async () => {
  await withTempPortalVault(async ({ userId, vault }) => {
    const selectionPath = vaultSelectionPath(vault, userId);
    fs.mkdirSync(path.dirname(selectionPath), { recursive: true });
    fs.writeFileSync(selectionPath, `${JSON.stringify({ backend: "docker" }, null, 2)}\n`, "utf8");
    assert.equal(fs.existsSync(selectionPath), true);

    writeVaultStatus({
      project: vault,
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
    const status = JSON.parse(fs.readFileSync(vaultStatusPath(vault, userId), "utf8")) as {
      driver?: { selected?: { backend?: string } | null };
    };
    assert.equal(status.driver?.selected?.backend, "docker");
  });
});
