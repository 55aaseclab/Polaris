import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  addDomainPack,
} from "../scripts/config/domain-packs.js";
import { runWorkflowLiveMetadataDrill } from "../scripts/cli/commands/workflow-live-metadata-drill.js";
import { closePolarisControlStore, PolarisControlStore } from "../scripts/portal/control-store.js";
import {
  WORKFLOW_LIVE_ADAPTER_FLAG,
  WORKFLOW_LIVE_WORKER_BINDING_FLAG,
  WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID,
} from "../scripts/portal/workflow-live-boundary.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ADMISSION_METADATA_PACK_SOURCE = `
domain MetadataPack version "1.0.0"
title "Synthetic metadata pack"
description "Synthetic live metadata workflow fixture"

port ArtifactMetadata version "1.0.0" {
  in {
    artifactScope: String?
  }
  out {
    artifactCount: Number
    latestTitles: String
    pendingMemoryChanges: Number
  }
  effect read
}

flow ReadMetadata title "Read metadata" create {
  needs { ArtifactMetadata }
  input {
    artifactScope: String
  }
  steps {
    metadata "Read metadata" {
      uses { artifactScope }
      call ArtifactMetadata
      output {
        artifactCount: Number
        latestTitles: String
        pendingMemoryChanges: Number
      }
    }
  }
  output {
    artifactCount: Number from artifactCount
    latestTitles: String from latestTitles
    pendingMemoryChanges: Number from pendingMemoryChanges
  }
  ui { layout form primary "Read" }
}
`;

type DrillOutput = {
  mode: string;
  tool: string;
  workerBinding: string;
  allowed: boolean;
  tenantId: string;
  vaultId: string;
  runId: string;
  requestId: string;
  attempts: number;
  receipts: number;
  auditEvents: number;
  auditChainValid: boolean;
  metadata?: {
    artifactCount: number;
    latestTitles: string[];
  };
};

type AdmitOutput = {
  mode: string;
  action: string;
  admitted: boolean;
  tenantId: string;
  vaultId: string;
  packId: string;
  flowId: string;
  runId: string;
  status: string;
  receipts: number;
  artifacts: number;
  auditEvents: number;
};

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

async function withLiveMetadataFixture<T>(
  fn: (input: {
    root: string;
    userId: string;
    vault: string;
    controlStorePath: string;
  }) => Promise<T> | T,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-live-metadata-drill-"));
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    POLARIS_DATA_ROOT: process.env.POLARIS_DATA_ROOT,
    POLARIS_CONTROL_STORE_PATH: process.env.POLARIS_CONTROL_STORE_PATH,
  };
  const userId = uniqueName("live-metadata-user");
  const vault = uniqueName("live-metadata-vault");
  const controlStorePath = path.join(root, "control.sqlite");
  process.env.NODE_ENV = "test";
  process.env.POLARIS_DATA_ROOT = path.join(root, "data");
  process.env.POLARIS_CONTROL_STORE_PATH = controlStorePath;
  closePolarisControlStore();

  try {
    const createUser = spawnSync(
      "pnpm",
      [
        "--filter",
        "polaris",
        "exec",
        "tsx",
        "scripts/polaris.ts",
        "user",
        "create",
        userId,
        "--name",
        "Live Metadata User",
        "--email",
        `${userId}@polaris.local`,
      ],
      {
        cwd: APP_ROOT,
        encoding: "utf8",
        env: process.env,
      },
    );
    assert.equal(createUser.status, 0, createUser.stderr);

    const createVault = spawnSync(
      "pnpm",
      [
        "--filter",
        "polaris",
        "exec",
        "tsx",
        "scripts/polaris.ts",
        "vault",
        "create",
        vault,
        "--user",
        userId,
      ],
      {
        cwd: APP_ROOT,
        encoding: "utf8",
        env: process.env,
      },
    );
    assert.equal(createVault.status, 0, createVault.stderr);

    const vaultStateRoot = path.join(
      process.env.POLARIS_DATA_ROOT,
      "control",
      "users",
      userId,
      "vaults",
      vault,
      "state",
    );
    fs.mkdirSync(vaultStateRoot, { recursive: true });
    fs.writeFileSync(
      path.join(vaultStateRoot, "selection.json"),
      `${JSON.stringify({ backend: "docker" }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(vaultStateRoot, "status.json"), `${JSON.stringify({
      schemaVersion: 1.1,
      project: vault,
      driver: {
        selected: { backend: "docker" },
        status: "running",
      },
      paseo: {
        daemon: "ready",
        web: "connectable",
        reconnectMode: "reconnectable",
        liveTarget: "https://paseo.example.test/#offer=synthetic",
        reconnectTarget: "https://paseo.example.test/h/synthetic",
      },
      details: {},
      evolution: {
        artifactCount: 2,
        activeVaultArtifacts: 1,
        activeUserArtifacts: 1,
        latestTitles: ["Drill artifact"],
        latestArtifacts: [{
          title: "Drill artifact",
          kind: "vault-memory",
          status: "active",
          whyExists: "synthetic drill",
          whyRetrieved: ["recent"],
          curatorAction: "kept",
        }],
        pendingMemoryChanges: 0,
      },
    }, null, 2)}\n`);
    return await fn({ root, userId, vault, controlStorePath });
  } finally {
    closePolarisControlStore();
    if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.NODE_ENV;
    if (previous.POLARIS_DATA_ROOT === undefined) delete process.env.POLARIS_DATA_ROOT;
    else process.env.POLARIS_DATA_ROOT = previous.POLARIS_DATA_ROOT;
    if (previous.POLARIS_CONTROL_STORE_PATH === undefined) {
      delete process.env.POLARIS_CONTROL_STORE_PATH;
    } else {
      process.env.POLARIS_CONTROL_STORE_PATH = previous.POLARIS_CONTROL_STORE_PATH;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("workflow live metadata drill requires explicit live flags", async () => {
  await withLiveMetadataFixture(({ userId, vault }) => {
    const result = spawnSync(
      "pnpm",
      [
        "--filter",
        "polaris",
        "exec",
        "tsx",
        "scripts/polaris.ts",
        "ops",
        "workflow-live-metadata-drill",
        "--user",
        userId,
        "--vault",
        vault,
        "--candidate-live-enabled",
        "--json",
      ],
      {
        cwd: APP_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          [WORKFLOW_LIVE_ADAPTER_FLAG]: undefined,
          [WORKFLOW_LIVE_WORKER_BINDING_FLAG]: undefined,
        },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires POLARIS_WORKFLOW_LIVE_ADAPTER=enabled, POLARIS_WORKFLOW_LIVE_WORKER_BINDING=enabled/u);
  });
});

test("workflow live metadata admission CLI admits a pinned pack flow", async () => {
  await withLiveMetadataFixture(async ({ root, userId, vault, controlStorePath }) => {
    const sourcePath = path.join(root, "metadata-pack.ord");
    fs.writeFileSync(sourcePath, ADMISSION_METADATA_PACK_SOURCE, "utf8");
    const installed = await addDomainPack(import.meta.url, sourcePath);

    const result = spawnSync(
      "pnpm",
      [
        "--filter",
        "polaris",
        "exec",
        "tsx",
        "scripts/polaris.ts",
        "ops",
        "workflow-admit-live-metadata",
        "--tenant",
        userId,
        "--vault",
        vault,
        "--pack",
        installed.pack.id,
        "--flow",
        "ReadMetadata",
        "--operator",
        "operator-synthetic",
        "--candidate-live-enabled",
        "--value",
        "artifactScope=latest",
        "--release-id",
        "release-synthetic",
        "--dedupe-key",
        `workflow-admit-live-metadata:${userId}:${vault}`,
        "--wait",
        "--json",
      ],
      {
        cwd: APP_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          [WORKFLOW_LIVE_ADAPTER_FLAG]: "enabled",
          [WORKFLOW_LIVE_WORKER_BINDING_FLAG]: "enabled",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as AdmitOutput;
    assert.equal(parsed.mode, "live");
    assert.equal(parsed.action, WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID);
    assert.equal(parsed.admitted, true);
    assert.equal(parsed.tenantId, userId);
    assert.equal(parsed.vaultId, vault);
    assert.equal(parsed.packId, installed.pack.id);
    assert.equal(parsed.flowId, "ReadMetadata");
    assert.equal(parsed.status, "succeeded");
    assert.equal(parsed.receipts, 1);
    assert.equal(parsed.artifacts, 1);
    assert.equal(parsed.auditEvents, 2);

    const store = PolarisControlStore.open(controlStorePath);
    try {
      const run = store.getWorkflowRun(userId, parsed.runId);
      assert.equal(run?.status, "succeeded");
      assert.equal(run?.policy.mode, "live");
      assert.equal(run?.policy.reasons.includes("operator-live-admission"), true);
      assert.equal(run?.receipts[0]?.status, "completed");
      assert.deepEqual(
        store.listAuditEvents().map((event) => event.action).sort(),
        [
          "workflow.live.admit",
          "workflow.live.vault.metadata.read",
        ],
      );
      assert.deepEqual(store.verifyAuditChain(), { valid: true, checked: 2 });
    } finally {
      store.close();
    }
  });
});

test("workflow live metadata drill requires explicit candidate action acknowledgement", async () => {
  await withLiveMetadataFixture(async ({ userId, vault }) => {
    await assert.rejects(
      () => runWorkflowLiveMetadataDrill({
        userId,
        vault,
        json: true,
        candidateLiveEnabled: false,
      }),
      /requires --candidate-live-enabled/u,
    );
  });
});

test("workflow live metadata drill reads Vault metadata and records evidence", async () => {
  await withLiveMetadataFixture(({ userId, vault, controlStorePath }) => {
    const result = spawnSync(
      "pnpm",
      [
        "--filter",
        "polaris",
        "exec",
        "tsx",
        "scripts/polaris.ts",
        "ops",
        "workflow-live-metadata-drill",
        "--user",
        userId,
        "--vault",
        vault,
        "--candidate-live-enabled",
        "--release-id",
        "release-synthetic",
        "--json",
      ],
      {
        cwd: APP_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          [WORKFLOW_LIVE_ADAPTER_FLAG]: "enabled",
          [WORKFLOW_LIVE_WORKER_BINDING_FLAG]: "enabled",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as DrillOutput;
    assert.equal(parsed.mode, "live");
    assert.equal(parsed.tool, WORKFLOW_LIVE_VAULT_METADATA_ACTION_ID);
    assert.equal(parsed.workerBinding, "executed");
    assert.equal(parsed.allowed, true);
    assert.equal(parsed.tenantId, userId);
    assert.equal(parsed.vaultId, vault);
    assert.equal(parsed.attempts, 1);
    assert.equal(parsed.receipts, 1);
    assert.equal(parsed.auditEvents, 1);
    assert.equal(parsed.auditChainValid, true);
    assert.equal(parsed.metadata?.artifactCount, 2);
    assert.deepEqual(parsed.metadata?.latestTitles, ["Drill artifact"]);

    const store = PolarisControlStore.open(controlStorePath);
    try {
      const run = store.getWorkflowRun(userId, parsed.runId);
      assert.equal(run?.status, "succeeded");
      assert.equal(run?.policy.mode, "live");
      assert.equal(run?.receipts[0]?.requestId, parsed.requestId);
      assert.equal(run?.receipts[0]?.status, "completed");
      assert.equal(store.listAuditEvents().length, 1);
      assert.deepEqual(store.verifyAuditChain(), { valid: true, checked: 1 });
    } finally {
      store.close();
    }
  });
});
