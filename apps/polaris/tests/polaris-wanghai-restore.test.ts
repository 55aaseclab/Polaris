import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { VaultSpec } from "../scripts/core/vault.js";
import {
  ensureWanghaiBackupKey,
  wanghaiBackupArchiveName,
} from "../scripts/runtime/wanghai-backup.js";
import {
  WanghaiRestoreError,
  buildWanghaiRestoreDockerRunArgs,
  buildWanghaiRestoreVerificationDockerRunArgs,
  parseWanghaiRestoreLog,
  resolveWanghaiRestoreSettings,
  wanghaiRestoreDedupeKey,
  wanghaiRestoreStagingVolumeName,
} from "../scripts/runtime/wanghai-restore.js";

const IMAGE = `registry.example.test/wanghai@sha256:${"b".repeat(64)}`;

function vault(): VaultSpec {
  return {
    identity: { projectName: "vault-a" },
    userProfile: { id: "tenant-a" },
    runtime: { baseImage: IMAGE },
    attachments: {
      vaultData: { source: { kind: "persistent-volume", volumeRef: "vault-data" } },
    },
  } as VaultSpec;
}

test("Polaris restore uses an isolated staging-volume Docker contract", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-restore-key-"));
  fs.chmodSync(root, 0o700);
  try {
    const settings = resolveWanghaiRestoreSettings({
      POLARIS_WANGHAI_BACKUP_KEY_ROOT: root,
      POLARIS_WANGHAI_RESTORE_MAX_ARCHIVE_BYTES: "1048576",
    });
    assert.equal(settings.submissionsPerHour, 2);
    assert.equal(settings.maxArchiveBytes, 1_048_576);
    const keyFile = ensureWanghaiBackupKey({
      keyRoot: settings.keyRoot,
      tenantId: "tenant-a",
      vaultId: "vault-a",
    });
    const jobId = "a0f7194d-433f-40b5-9f2a-43d6094bd8bf";
    const archiveName = wanghaiBackupArchiveName({
      tenantId: "tenant-a",
      vaultId: "vault-a",
      jobId: "source-backup-a",
    });
    const args = buildWanghaiRestoreDockerRunArgs({
      vault: vault(),
      jobId,
      tenantId: "tenant-a",
      vaultId: "vault-a",
      archiveName,
      keyFile,
      settings,
    });

    const stagingVolume = wanghaiRestoreStagingVolumeName(vault(), jobId);
    assert.ok(args.includes("--network"));
    assert.ok(args.includes("none"));
    assert.ok(args.includes("--read-only"));
    assert.ok(args.includes("--cap-drop"));
    assert.ok(args.includes("--security-opt"));
    assert.ok(args.includes("--pids-limit"));
    assert.ok(args.includes("type=volume,source=tenant-a-vault-a-wanghai-backup,target=/backup,readonly"));
    assert.ok(args.includes(`type=volume,source=${stagingVolume},target=/restore`));
    assert.equal(args.some((entry) => entry.includes("target=/vault/project")), false);
    assert.ok(args.some((entry) => entry.includes("target=/run/secrets/wanghai-backup.key,readonly")));
    assert.ok(args.includes("WANGHAI_RUNTIME_MODE=polaris"));
    assert.ok(args.includes("WANGHAI_RESTORE_MAX_ARCHIVE_BYTES=1048576"));
    assert.equal(args.some((entry) => entry.includes("WANGHAI_DATA_ROOT")), false);
    assert.equal(args.some((entry) => entry === "-p" || entry === "--publish"), false);
    assert.equal(args.at(-2), "/opt/wanghai/scripts/polaris-restore-workspaces.sh");
    assert.equal(args.at(-1), archiveName);

    const verification = buildWanghaiRestoreVerificationDockerRunArgs({
      vault: vault(),
      jobId,
    });
    assert.ok(verification.includes("--rm"));
    assert.ok(verification.includes("none"));
    assert.ok(verification.some((entry) => entry.includes("find /restore/workspaces -type l")));
    assert.deepEqual(
      parseWanghaiRestoreLog("restored_to=/restore/workspaces\nverified=1\n"),
      { checksumVerified: true },
    );
    assert.throws(
      () => parseWanghaiRestoreLog("verified=1\n"),
      (error: unknown) => error instanceof WanghaiRestoreError
        && error.code === "restore-result-invalid",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Polaris restore binds deduplication to the source backup and rejects bad inputs", () => {
  assert.equal(
    wanghaiRestoreDedupeKey("tenant-a", "vault-a", "source-a", "request-a"),
    wanghaiRestoreDedupeKey("tenant-a", "vault-a", "source-a", "request-a"),
  );
  assert.notEqual(
    wanghaiRestoreDedupeKey("tenant-a", "vault-a", "source-a", "request-a"),
    wanghaiRestoreDedupeKey("tenant-a", "vault-a", "source-b", "request-a"),
  );
  assert.throws(
    () => resolveWanghaiRestoreSettings({
      POLARIS_WANGHAI_BACKUP_KEY_ROOT: "/missing",
      POLARIS_WANGHAI_RESTORE_MAX_ARCHIVE_BYTES: "invalid",
    }),
    (error: unknown) => error instanceof WanghaiRestoreError
      && error.code === "restore-configuration-invalid",
  );
});
