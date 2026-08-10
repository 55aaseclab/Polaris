import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { VaultSpec } from "../scripts/core/vault.js";
import {
  ensureWanghaiBackupKey,
  wanghaiBackupArchiveName,
} from "../scripts/control-plane/jobs/wanghai-backup.js";
import {
  WanghaiRestoreError,
  buildWanghaiRestoreActivationDockerRunArgs,
  buildWanghaiRestoreActivationVerificationDockerRunArgs,
  buildWanghaiRestoreDockerRunArgs,
  buildWanghaiRestoreRollbackDockerRunArgs,
  buildWanghaiRestoreRollbackVerificationDockerRunArgs,
  buildWanghaiRestoreVerificationDockerRunArgs,
  parseWanghaiRestoreActivationLog,
  parseWanghaiRestoreLog,
  parseWanghaiRestoreRollbackLog,
  resolveWanghaiRestoreSettings,
  wanghaiRestoreActivationDedupeKey,
  wanghaiRestorePreviousWorkspaceName,
  wanghaiRestoreRollbackDedupeKey,
  wanghaiRestoreRollbackFailedWorkspaceName,
  wanghaiRestoreDedupeKey,
  wanghaiRestoreStagingVolumeName,
} from "../scripts/control-plane/jobs/wanghai-restore.js";

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
  const dataRoot = path.join(root, "data");
  const keyRoot = path.join(dataRoot, "control", "backup-keys");
  fs.mkdirSync(keyRoot, { recursive: true, mode: 0o700 });
  try {
    const settings = resolveWanghaiRestoreSettings({
      POLARIS_DATA_ROOT: dataRoot,
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
    assert.equal(args.some((entry) => entry.includes("target=/vault/")), false);
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
      POLARIS_DATA_ROOT: "/missing",
      POLARIS_WANGHAI_RESTORE_MAX_ARCHIVE_BYTES: "invalid",
    }),
    (error: unknown) => error instanceof WanghaiRestoreError
      && error.code === "restore-configuration-invalid",
  );
});

test("Polaris restore activation and rollback use scoped, syntax-checked Docker contracts", () => {
  const restoreJobId = "restore-source-a";
  const activationJobId = "activation-a";
  const rollbackJobId = "rollback-a";
  const stagingVolume = wanghaiRestoreStagingVolumeName(vault(), restoreJobId);
  const previousWorkspaceName = wanghaiRestorePreviousWorkspaceName(activationJobId);
  const failedWorkspaceName = wanghaiRestoreRollbackFailedWorkspaceName(rollbackJobId);

  const activation = buildWanghaiRestoreActivationDockerRunArgs({
    vault: vault(),
    jobId: activationJobId,
    restoreJobId,
    stagingVolume,
  });
  assert.ok(activation.includes("--network"));
  assert.ok(activation.includes("none"));
  assert.ok(activation.includes("--read-only"));
  assert.ok(activation.includes("type=volume,source=vault-data,target=/vault/workspaces,volume-subpath=workspaces"));
  assert.ok(activation.includes("type=volume,source=vault-data,target=/vault/backups,volume-subpath=backups"));
  assert.ok(activation.includes("type=volume,source=vault-data,target=/vault/cache,volume-subpath=cache"));
  assert.ok(activation.includes(`type=volume,source=${stagingVolume},target=/restore,readonly`));
  assert.equal(activation.some((entry) => entry === "-p" || entry === "--publish"), false);
  const activationCommand = activation.at(-1) ?? "";
  assert.match(activationCommand, new RegExp(`activation_job_id=\"${activationJobId}\"`, "u"));
  assert.match(activationCommand, new RegExp(`restore_job_id=\"${restoreJobId}\"`, "u"));
  assert.match(activationCommand, new RegExp(`previous_workspace_name=\"${previousWorkspaceName}\"`, "u"));
  assert.equal(activationCommand.includes("$previousWorkspaceName"), false);
  const activationSyntax = spawnSync("bash", ["-n"], {
    encoding: "utf8",
    input: activationCommand,
  });
  assert.equal(activationSyntax.status, 0, activationSyntax.stderr);
  assert.deepEqual(
    parseWanghaiRestoreActivationLog({
      output: [
        `activation_job_id=${activationJobId}`,
        `restore_job_id=${restoreJobId}`,
        "activated_workspace=workspaces",
        `previous_workspace=${previousWorkspaceName}`,
        "verified=1",
      ].join("\n"),
      jobId: activationJobId,
      restoreJobId,
    }),
    { previousWorkspaceName, checksumVerified: true },
  );
  assert.throws(
    () => buildWanghaiRestoreActivationDockerRunArgs({
      vault: vault(),
      jobId: activationJobId,
      restoreJobId,
      stagingVolume: "another-restore-volume",
    }),
    (error: unknown) => error instanceof WanghaiRestoreError
      && error.code === "restore-contract-invalid",
  );

  const activationVerification = buildWanghaiRestoreActivationVerificationDockerRunArgs({
    vault: vault(),
    jobId: activationJobId,
    restoreJobId,
    stagingVolume,
  });
  assert.ok(activationVerification.includes("type=volume,source=vault-data,target=/vault/workspaces,volume-subpath=workspaces,readonly"));
  assert.ok(activationVerification.includes(`type=volume,source=${stagingVolume},target=/restore,readonly`));

  const rollback = buildWanghaiRestoreRollbackDockerRunArgs({
    vault: vault(),
    jobId: rollbackJobId,
    activationJobId,
    previousWorkspaceName,
  });
  assert.ok(rollback.includes("--network"));
  assert.ok(rollback.includes("none"));
  assert.ok(rollback.includes("type=volume,source=vault-data,target=/vault/workspaces,volume-subpath=workspaces"));
  const rollbackCommand = rollback.at(-1) ?? "";
  assert.match(rollbackCommand, new RegExp(`rollback_job_id=\"${rollbackJobId}\"`, "u"));
  assert.match(rollbackCommand, new RegExp(`activation_job_id=\"${activationJobId}\"`, "u"));
  assert.match(rollbackCommand, new RegExp(`failed_workspace_name=\"${failedWorkspaceName}\"`, "u"));
  assert.equal(rollbackCommand.includes("$failedWorkspaceName"), false);
  const rollbackSyntax = spawnSync("bash", ["-n"], {
    encoding: "utf8",
    input: rollbackCommand,
  });
  assert.equal(rollbackSyntax.status, 0, rollbackSyntax.stderr);
  assert.deepEqual(
    parseWanghaiRestoreRollbackLog({
      output: [
        `rollback_job_id=${rollbackJobId}`,
        `activation_job_id=${activationJobId}`,
        "rolled_back_workspace=workspaces",
        `failed_workspace=${failedWorkspaceName}`,
        "verified=1",
      ].join("\n"),
      jobId: rollbackJobId,
      activationJobId,
    }),
    { failedWorkspaceName, rollbackVerified: true },
  );
  assert.throws(
    () => buildWanghaiRestoreRollbackDockerRunArgs({
      vault: vault(),
      jobId: rollbackJobId,
      activationJobId,
      previousWorkspaceName: "workspaces.pre-restore-other",
    }),
    (error: unknown) => error instanceof WanghaiRestoreError
      && error.code === "restore-contract-invalid",
  );

  const rollbackVerification = buildWanghaiRestoreRollbackVerificationDockerRunArgs({
    vault: vault(),
    jobId: rollbackJobId,
    failedWorkspaceName,
  });
  assert.ok(rollbackVerification.includes("type=volume,source=vault-data,target=/vault/workspaces,volume-subpath=workspaces,readonly"));
  assert.equal(
    wanghaiRestoreActivationDedupeKey("tenant-a", "vault-a", restoreJobId, "request-a"),
    wanghaiRestoreActivationDedupeKey("tenant-a", "vault-a", restoreJobId, "request-a"),
  );
  assert.notEqual(
    wanghaiRestoreRollbackDedupeKey("tenant-a", "vault-a", activationJobId, "request-a"),
    wanghaiRestoreRollbackDedupeKey("tenant-a", "vault-a", activationJobId, "request-b"),
  );
});

test("Polaris restore activation recovers the original root after a partial candidate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-restore-activation-recovery-"));
  const dataRoot = path.join(root, "data");
  const restoreRoot = path.join(root, "restore");
  const activationJobId = "activation-recovery-a";
  const restoreJobId = "restore-source-a";
  const previousWorkspaceName = wanghaiRestorePreviousWorkspaceName(activationJobId);
  const candidateWorkspaceName = `workspaces.restore-pending-${activationJobId}`;
  const command = (buildWanghaiRestoreActivationDockerRunArgs({
    vault: vault(),
    jobId: activationJobId,
    restoreJobId,
    stagingVolume: wanghaiRestoreStagingVolumeName(vault(), restoreJobId),
  }).at(-1) ?? "")
    .replaceAll("/activation-root", dataRoot)
    .replaceAll("/restore", restoreRoot);
  try {
    fs.mkdirSync(path.join(dataRoot, previousWorkspaceName), { recursive: true });
    fs.mkdirSync(path.join(dataRoot, candidateWorkspaceName), { recursive: true });
    fs.mkdirSync(path.join(restoreRoot, "workspaces"), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, previousWorkspaceName, "state.txt"), "original", "utf8");
    fs.writeFileSync(path.join(dataRoot, candidateWorkspaceName, "state.txt"), "partial", "utf8");
    fs.writeFileSync(path.join(restoreRoot, "workspaces", "state.txt"), "restored", "utf8");

    const result = spawnSync("bash", ["-lc", command], { encoding: "utf8" });
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(
      fs.readFileSync(path.join(dataRoot, "workspaces", "state.txt"), "utf8"),
      "original",
    );
    assert.equal(fs.existsSync(path.join(dataRoot, previousWorkspaceName)), false);
    assert.equal(fs.existsSync(path.join(dataRoot, candidateWorkspaceName)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
