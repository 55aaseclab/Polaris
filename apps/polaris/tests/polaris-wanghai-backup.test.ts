import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { VaultSpec } from "../scripts/core/vault.js";
import { createUserCommand } from "../scripts/cli/commands/create-user.js";
import { scaffoldDockerVault } from "../scripts/config/scaffold.js";
import { writeVaultStatus } from "../scripts/output/state-store.js";
import { createPortalServer } from "../scripts/portal/server.js";
import {
  closePolarisControlStore,
  getPolarisControlStore,
} from "../scripts/portal/control-store.js";
import {
  deleteUserMapEntriesForPolarisUserId,
  upsertUserMapEntry,
} from "../scripts/portal/user-map.js";
import {
  queueWanghaiBackup,
  queueWanghaiRestore,
  requestWanghaiBackupCancellation,
  resumeDurableVaultJobs,
} from "../scripts/runtime/operations.js";
import { polarisUsersRoot } from "../scripts/utils/paths.js";
import {
  WanghaiBackupError,
  buildWanghaiBackupDockerRunArgs,
  buildWanghaiBackupVerificationDockerRunArgs,
  ensureWanghaiBackupKey,
  parseWanghaiBackupArchiveLog,
  resolveWanghaiBackupSettings,
  wanghaiBackupArchiveName,
  wanghaiBackupDedupeKey,
} from "../scripts/runtime/wanghai-backup.js";

const IMAGE = `registry.example.test/wanghai@sha256:${"a".repeat(64)}`;
const USER_ROOT = polarisUsersRoot(import.meta.url);

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
}

async function withEnv<T>(
  entries: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(entries)) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withFakeDocker<T>(
  input: { tenantId: string; vaultId: string; recovery?: boolean; hold?: boolean },
  fn: (readCommands: () => string[]) => Promise<T>,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-backup-docker-"));
  const commandLog = path.join(root, "commands.log");
  const stateFile = path.join(root, "container-state.json");
  const logsFile = path.join(root, "container-logs.txt");
  const stopFile = path.join(root, "container-stop");
  const dockerPath = path.join(root, "docker");
  const previousPath = process.env.PATH ?? "";
  fs.writeFileSync(dockerPath, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(commandLog)}
state_file=${JSON.stringify(stateFile)}
logs_file=${JSON.stringify(logsFile)}
container_name() {
  local value="\${!#}"
  printf '%s' "\${value}"
}
archive_path() {
  local name job
  name="$(container_name "$@")"
  job="\${name#polaris-wanghai-backup-}"
  printf '/backup/backup-%s-%s-%s.tar.gz.enc\\n' "\${FAKE_BACKUP_TENANT}" "\${FAKE_BACKUP_VAULT}" "\${job}"
}
case "\${1:-}" in
  inspect)
    if [ "\${FAKE_BACKUP_RECOVERY:-0}" = "1" ]; then
      printf '[{"State":{"Running":false,"ExitCode":0}}]'
      exit 0
    fi
    if [ -f "\${state_file}" ]; then
      cat "\${state_file}"
      exit 0
    fi
    printf 'Error: No such object: %s\\n' "\${2:-}" >&2
    exit 1
    ;;
  logs)
    if [ -f "\${logs_file}" ]; then
      cat "\${logs_file}"
    else
      archive_path "$@"
    fi
    exit 0
    ;;
  run)
    if [ "\${2:-}" = "--rm" ]; then
      printf 'archive checksum: OK\\n'
      exit 0
    fi
    name=""
    tenant=""
    vault=""
    args=("$@")
    for ((index = 0; index < \${#args[@]}; index += 1)); do
      case "\${args[$index]}" in
        --name)
          name="\${args[$((index + 1))]:-}"
          ;;
        --env)
          value="\${args[$((index + 1))]:-}"
          case "\${value}" in
            WANGHAI_TENANT_ID=*) tenant="\${value#WANGHAI_TENANT_ID=}" ;;
            WANGHAI_VAULT_ID=*) vault="\${value#WANGHAI_VAULT_ID=}" ;;
          esac
          ;;
      esac
    done
    if [[ "\${name}" = polaris-wanghai-restore-* ]]; then
      printf '[{"State":{"Running":false,"ExitCode":0}}]' > "\${state_file}"
      printf 'restored_to=/restore/workspaces\\nverified=1\\n' > "\${logs_file}"
      cat "\${logs_file}"
      exit 0
    fi
    job="\${name#polaris-wanghai-backup-}"
    if [ "\${FAKE_BACKUP_HOLD:-0}" = "1" ]; then
      printf '[{"State":{"Running":true,"ExitCode":0}}]' > "\${state_file}"
      while [ ! -f "${stopFile}" ]; do
        sleep 0.05
      done
      printf '[{"State":{"Running":false,"ExitCode":137}}]' > "\${state_file}"
      exit 137
    fi
    printf '[{"State":{"Running":false,"ExitCode":0}}]' > "\${state_file}"
    printf '/backup/backup-%s-%s-%s.tar.gz.enc\\n' "\${tenant}" "\${vault}" "\${job}" > "\${logs_file}"
    cat "\${logs_file}"
    exit 0
    ;;
  rm)
    rm -f "\${state_file}" "\${logs_file}" "${stopFile}"
    exit 0
    ;;
  stop|kill)
    touch "${stopFile}"
    printf '[{"State":{"Running":false,"ExitCode":137}}]' > "\${state_file}"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`, { mode: 0o755 });
  process.env.PATH = `${root}:${previousPath}`;
  process.env.FAKE_BACKUP_TENANT = input.tenantId;
  process.env.FAKE_BACKUP_VAULT = input.vaultId;
  process.env.FAKE_BACKUP_RECOVERY = input.recovery ? "1" : "0";
  process.env.FAKE_BACKUP_HOLD = input.hold ? "1" : "0";
  try {
    return await fn(() => (
      fs.existsSync(commandLog)
        ? fs.readFileSync(commandLog, "utf8").split("\n").map((line) => line.trim()).filter(Boolean)
        : []
    ));
  } finally {
    process.env.PATH = previousPath;
    delete process.env.FAKE_BACKUP_TENANT;
    delete process.env.FAKE_BACKUP_VAULT;
    delete process.env.FAKE_BACKUP_RECOVERY;
    delete process.env.FAKE_BACKUP_HOLD;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function waitFor<T>(read: () => T | null, timeoutMs = 5_000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function withBackupVault<T>(
  fn: (input: { tenantId: string; vaultId: string }) => Promise<T>,
): Promise<T> {
  const tenantId = uniqueName("backup-tenant");
  const vaultId = uniqueName("backup-vault");
  const profilePath = path.join(USER_ROOT, "profiles", `${tenantId}.yaml`);
  const userRoot = path.join(USER_ROOT, tenantId);
  try {
    await createUserCommand([
      tenantId,
      "--name",
      "Backup Test User",
      "--email",
      `${tenantId}@polaris.local`,
    ]);
    scaffoldDockerVault(vaultId, tenantId, {
      baseImage: IMAGE,
      line: "vertical",
      paseoFreeWanghaiTest: true,
    });
    writeVaultStatus({
      schemaVersion: 1.1,
      project: vaultId,
      driver: {
        selected: { backend: "docker" },
        status: "stopped",
      },
      paseo: {
        daemon: "absent",
        web: "unavailable",
        reconnectMode: "unknown",
        liveTarget: null,
        reconnectTarget: null,
      },
      details: {},
    }, tenantId);
    return await fn({ tenantId, vaultId });
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
}

function vault(source: Record<string, unknown>): VaultSpec {
  return {
    identity: { projectName: "vault-a" },
    userProfile: { id: "tenant-a" },
    runtime: { baseImage: IMAGE },
    attachments: {
      vaultData: { source },
    },
  } as VaultSpec;
}

test("Polaris backup uses a private one-shot Docker contract", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-backup-key-"));
  const keyRoot = path.join(root, "keys");
  fs.mkdirSync(keyRoot, { mode: 0o700 });
  try {
    const settings = resolveWanghaiBackupSettings({
      POLARIS_WANGHAI_BACKUP_KEY_ROOT: keyRoot,
      POLARIS_WANGHAI_BACKUP_RETENTION_COUNT: "2",
      POLARIS_WANGHAI_BACKUP_TIMEOUT_MS: "60000",
    });
    assert.equal(settings.submissionsPerHour, 6);
    const keyFile = ensureWanghaiBackupKey({
      keyRoot: settings.keyRoot,
      tenantId: "tenant-a",
      vaultId: "vault-a",
    });
    const jobId = "a0f7194d-433f-40b5-9f2a-43d6094bd8bf";
    const archiveName = wanghaiBackupArchiveName({
      tenantId: "tenant-a",
      vaultId: "vault-a",
      jobId,
    });
    const args = buildWanghaiBackupDockerRunArgs({
      vault: vault({ kind: "persistent-volume", volumeRef: "vault-data" }),
      jobId,
      tenantId: "tenant-a",
      vaultId: "vault-a",
      keyFile,
      settings,
    });

    assert.ok(args.includes("--network"));
    assert.ok(args.includes("none"));
    assert.ok(args.includes("--read-only"));
    assert.ok(args.includes("--cap-drop"));
    assert.ok(args.includes("--security-opt"));
    assert.ok(args.includes("--pids-limit"));
    assert.ok(args.includes("type=volume,source=vault-data,target=/vault/project,readonly"));
    assert.ok(args.includes("type=volume,source=tenant-a-vault-a-wanghai-backup,target=/backup"));
    assert.ok(args.some((arg) => arg.includes("target=/run/secrets/wanghai-backup.key,readonly")));
    assert.ok(args.includes("WANGHAI_RUNTIME_MODE=polaris"));
    assert.ok(args.includes(`WANGHAI_BACKUP_ARCHIVE_ID=${jobId}`));
    assert.equal(args.some((arg) => arg.includes("WANGHAI_DATA_ROOT")), false);
    assert.equal(args.some((arg) => arg === "-p" || arg === "--publish"), false);
    assert.equal(args.at(-2), "/opt/wanghai/scripts/polaris-backup-workspaces.sh");
    assert.equal(args.at(-1), "/backup");

    const verification = buildWanghaiBackupVerificationDockerRunArgs({
      vault: vault({ kind: "persistent-volume", volumeRef: "vault-data" }),
      archiveName,
    });
    assert.ok(verification.includes("--rm"));
    assert.ok(verification.includes("none"));
    assert.ok(verification.some((arg) => arg.includes("sha256sum --check")));
    assert.deepEqual(
      parseWanghaiBackupArchiveLog(`/backup/${archiveName}\n`, archiveName),
      { archiveName, checksumVerified: true },
    );
    assert.throws(
      () => parseWanghaiBackupArchiveLog("unexpected output\n", archiveName),
      (error: unknown) => error instanceof WanghaiBackupError && error.code === "backup-result-invalid",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Polaris backup derives stable private keys and deduplication keys", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-backup-key-"));
  fs.chmodSync(root, 0o700);
  try {
    const first = ensureWanghaiBackupKey({
      keyRoot: root,
      tenantId: "tenant-a",
      vaultId: "vault-a",
    });
    const second = ensureWanghaiBackupKey({
      keyRoot: root,
      tenantId: "tenant-a",
      vaultId: "vault-a",
    });
    assert.equal(first, second);
    assert.equal(fs.lstatSync(first).isSymbolicLink(), false);
    assert.equal(fs.statSync(first).mode & 0o077, 0);
    assert.equal(
      wanghaiBackupDedupeKey("tenant-a", "vault-a", "request-a"),
      wanghaiBackupDedupeKey("tenant-a", "vault-a", "request-a"),
    );
    assert.notEqual(
      wanghaiBackupDedupeKey("tenant-a", "vault-a", "request-a"),
      wanghaiBackupDedupeKey("tenant-a", "vault-a", "request-b"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Polaris backup rejects unpinned images and unsafe data roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-backup-key-"));
  fs.chmodSync(root, 0o700);
  try {
    const settings = resolveWanghaiBackupSettings({
      POLARIS_WANGHAI_BACKUP_KEY_ROOT: root,
    });
    const keyFile = ensureWanghaiBackupKey({
      keyRoot: root,
      tenantId: "tenant-a",
      vaultId: "vault-a",
    });
    assert.throws(
      () => buildWanghaiBackupDockerRunArgs({
        vault: {
          ...vault({ kind: "persistent-volume", volumeRef: "vault-data" }),
          runtime: { baseImage: "wanghai-admin-portal:latest" },
        } as VaultSpec,
        jobId: "job-a",
        tenantId: "tenant-a",
        vaultId: "vault-a",
        keyFile,
        settings,
      }),
      (error: unknown) => error instanceof WanghaiBackupError && error.code === "backup-image-unpinned",
    );

    fs.chmodSync(root, 0o755);
    assert.throws(
      () => resolveWanghaiBackupSettings({ POLARIS_WANGHAI_BACKUP_KEY_ROOT: root }),
      (error: unknown) => error instanceof WanghaiBackupError && error.code === "backup-configuration-invalid",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("durable Wanghai backup runs once with no network or published port", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-backup-worker-"));
  const keyRoot = path.join(root, "keys");
  const controlPath = path.join(root, "control.sqlite");
  fs.mkdirSync(keyRoot, { mode: 0o700 });
  try {
    await withBackupVault(async ({ tenantId, vaultId }) => {
      await withFakeDocker({ tenantId, vaultId }, async (readCommands) => {
        await withEnv({
          POLARIS_CONTROL_STORE_PATH: controlPath,
          POLARIS_WANGHAI_BACKUP_KEY_ROOT: keyRoot,
          POLARIS_WANGHAI_BACKUP_TIMEOUT_MS: "60000",
        }, async () => {
          closePolarisControlStore();
          try {
            const job = await queueWanghaiBackup({
              actorId: "backup-operator",
              tenantId,
              vaultId,
              idempotencyKey: "backup-request-a",
            });
            await resumeDurableVaultJobs();
            const finished = getPolarisControlStore(import.meta.url).getJob(job.id);
            assert.equal(finished?.status, "succeeded");
            assert.deepEqual(finished?.result, {
              archiveName: `backup-${tenantId}-${vaultId}-${job.id}.tar.gz.enc`,
              checksumVerified: true,
              retentionCount: 2,
            });
            const replay = await queueWanghaiBackup({
              actorId: "backup-operator",
              tenantId,
              vaultId,
              idempotencyKey: "backup-request-a",
            });
            assert.equal(replay.id, job.id);
            const commands = readCommands();
            const backupRun = commands.find((entry) => entry.startsWith("run --name polaris-wanghai-backup-"));
            assert.ok(backupRun);
            assert.match(backupRun, /--network none/u);
            assert.match(backupRun, /--read-only/u);
            assert.match(backupRun, /target=\/vault\/project,readonly/u);
            assert.equal(/(?:^|\s)(?:-p|--publish)(?:\s|$)/u.test(backupRun), false);
            assert.equal(commands.filter((entry) => entry.startsWith("run --name polaris-wanghai-backup-")).length, 1);
            assert.ok(commands.some((entry) => entry.startsWith("rm -f polaris-wanghai-backup-")));
          } finally {
            closePolarisControlStore();
          }
        });
      });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("durable Wanghai restore stages a completed same-scope backup once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-restore-worker-"));
  const keyRoot = path.join(root, "keys");
  const controlPath = path.join(root, "control.sqlite");
  fs.mkdirSync(keyRoot, { mode: 0o700 });
  try {
    await withBackupVault(async ({ tenantId, vaultId }) => {
      await withFakeDocker({ tenantId, vaultId }, async (readCommands) => {
        await withEnv({
          POLARIS_CONTROL_STORE_PATH: controlPath,
          POLARIS_WANGHAI_BACKUP_KEY_ROOT: keyRoot,
          POLARIS_WANGHAI_BACKUP_TIMEOUT_MS: "60000",
          POLARIS_WANGHAI_RESTORE_MAX_ARCHIVE_BYTES: "1048576",
        }, async () => {
          closePolarisControlStore();
          try {
            const backup = await queueWanghaiBackup({
              actorId: "restore-operator",
              tenantId,
              vaultId,
              idempotencyKey: "restore-source-a",
            });
            await resumeDurableVaultJobs();
            const restore = await queueWanghaiRestore({
              actorId: "restore-operator",
              tenantId,
              vaultId,
              sourceBackupJobId: backup.id,
              idempotencyKey: "restore-request-a",
            });
            await resumeDurableVaultJobs();
            const finished = getPolarisControlStore(import.meta.url).getJob(restore.id);
            assert.equal(finished?.status, "succeeded");
            assert.equal(finished?.result?.sourceBackupJobId, backup.id);
            assert.equal(
              finished?.result?.archiveName,
              `backup-${tenantId}-${vaultId}-${backup.id}.tar.gz.enc`,
            );
            assert.equal(finished?.result?.checksumVerified, true);
            assert.equal(typeof finished?.result?.stagingVolume, "string");
            const replay = await queueWanghaiRestore({
              actorId: "restore-operator",
              tenantId,
              vaultId,
              sourceBackupJobId: backup.id,
              idempotencyKey: "restore-request-a",
            });
            assert.equal(replay.id, restore.id);
            const commands = readCommands();
            const restoreRun = commands.find((entry) => entry.startsWith("run --name polaris-wanghai-restore-"));
            assert.ok(restoreRun);
            assert.match(restoreRun, /--network none/u);
            assert.match(restoreRun, /--read-only/u);
            assert.match(restoreRun, /target=\/backup,readonly/u);
            assert.match(restoreRun, /target=\/restore/u);
            assert.equal(/target=\/vault\/project/u.test(restoreRun), false);
            assert.equal(/(?:^|\s)(?:-p|--publish)(?:\s|$)/u.test(restoreRun), false);
            assert.equal(commands.filter((entry) => entry.startsWith("run --name polaris-wanghai-restore-")).length, 1);
            assert.ok(commands.some((entry) => entry.startsWith("rm -f polaris-wanghai-restore-")));
            assert.equal(commands.some((entry) => entry.startsWith("volume rm ")), false);
          } finally {
            closePolarisControlStore();
          }
        });
      });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("durable Wanghai backup cancellation stops the named one-shot container", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-backup-cancel-"));
  const keyRoot = path.join(root, "keys");
  const controlPath = path.join(root, "control.sqlite");
  fs.mkdirSync(keyRoot, { mode: 0o700 });
  try {
    await withBackupVault(async ({ tenantId, vaultId }) => {
      await withFakeDocker({ tenantId, vaultId, hold: true }, async (readCommands) => {
        await withEnv({
          POLARIS_CONTROL_STORE_PATH: controlPath,
          POLARIS_WANGHAI_BACKUP_KEY_ROOT: keyRoot,
          POLARIS_WANGHAI_BACKUP_TIMEOUT_MS: "60000",
        }, async () => {
          closePolarisControlStore();
          try {
            const job = await queueWanghaiBackup({
              actorId: "backup-operator",
              tenantId,
              vaultId,
              idempotencyKey: "backup-cancel-a",
            });
            await waitFor(() => (
              readCommands().some((entry) => entry.startsWith("run --name polaris-wanghai-backup-"))
                ? true
                : null
            ));
            assert.equal(requestWanghaiBackupCancellation({
              actorId: "backup-operator",
              tenantId,
              vaultId,
              jobId: job.id,
            }), true);
            await resumeDurableVaultJobs();
            const cancelled = getPolarisControlStore(import.meta.url).getJob(job.id);
            assert.equal(cancelled?.status, "failed");
            assert.equal(cancelled?.cancelRequested, true);
            assert.equal(cancelled?.errorCode, "durable-job-cancelled");
            const commands = readCommands();
            assert.ok(commands.some((entry) => entry.startsWith("stop --time 10 polaris-wanghai-backup-")));
            assert.ok(commands.some((entry) => entry.startsWith("rm -f polaris-wanghai-backup-")));
          } finally {
            closePolarisControlStore();
          }
        });
      });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("durable Wanghai backup finalizes an exited named container after restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-backup-recovery-"));
  const keyRoot = path.join(root, "keys");
  const controlPath = path.join(root, "control.sqlite");
  fs.mkdirSync(keyRoot, { mode: 0o700 });
  try {
    await withBackupVault(async ({ tenantId, vaultId }) => {
      await withFakeDocker({ tenantId, vaultId, recovery: true }, async (readCommands) => {
        await withEnv({
          POLARIS_CONTROL_STORE_PATH: controlPath,
          POLARIS_WANGHAI_BACKUP_KEY_ROOT: keyRoot,
          POLARIS_WANGHAI_BACKUP_TIMEOUT_MS: "60000",
        }, async () => {
          closePolarisControlStore();
          try {
            const job = await queueWanghaiBackup({
              actorId: "backup-operator",
              tenantId,
              vaultId,
              idempotencyKey: "backup-recovery-a",
            });
            await resumeDurableVaultJobs();
            assert.equal(getPolarisControlStore(import.meta.url).getJob(job.id)?.status, "succeeded");
            const commands = readCommands();
            assert.equal(commands.some((entry) => entry.startsWith("run --name polaris-wanghai-backup-")), false);
            assert.ok(commands.some((entry) => entry.startsWith("inspect polaris-wanghai-backup-")));
            assert.ok(commands.some((entry) => entry.startsWith("rm -f polaris-wanghai-backup-")));
          } finally {
            closePolarisControlStore();
          }
        });
      });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("portal scopes Wanghai backup submission and status to the current vertical user", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-backup-api-"));
  const keyRoot = path.join(root, "keys");
  const controlPath = path.join(root, "control.sqlite");
  fs.mkdirSync(keyRoot, { mode: 0o700 });
  let portal: ReturnType<typeof createPortalServer> | null = null;
  try {
    await withBackupVault(async ({ tenantId, vaultId }) => {
      await upsertUserMapEntry(tenantId, {
        polarisUserId: tenantId,
        role: "user",
        plan: "pro",
        line: "vertical",
      });
      try {
        await withFakeDocker({ tenantId, vaultId }, async () => {
          await withEnv({
            POLARIS_AUTH_MODE: "disabled",
            POLARIS_AUTH_DEFAULT_USER_ID: tenantId,
            POLARIS_AUTH_DEFAULT_ROLE: "user",
            POLARIS_CONTROL_STORE_PATH: controlPath,
            POLARIS_WANGHAI_BACKUP_KEY_ROOT: keyRoot,
            POLARIS_WANGHAI_BACKUP_TIMEOUT_MS: "60000",
            POLARIS_WANGHAI_BACKUP_SUBMISSIONS_PER_HOUR: "1",
          }, async () => {
            closePolarisControlStore();
            portal = createPortalServer(0);
            await once(portal, "listening");
            const address = portal.address();
            if (!address || typeof address === "string") {
              throw new Error("Portal server did not expose a TCP address");
            }
            const baseUrl = `http://127.0.0.1:${address.port}`;
            const endpoint = `${baseUrl}/api/users/${encodeURIComponent(tenantId)}/vaults/${encodeURIComponent(vaultId)}/backups`;

            const missingKey = await fetch(endpoint, { method: "POST" });
            assert.equal(missingKey.status, 428);

            const submitted = await fetch(endpoint, {
              method: "POST",
              headers: { "idempotency-key": "portal-backup-request-a" },
            });
            assert.ok(submitted.status === 200 || submitted.status === 202);
            const submittedBody = await submitted.json() as { job: { id: string } };
            assert.ok(submittedBody.job.id);

            await resumeDurableVaultJobs();
            const status = await fetch(`${endpoint}/${encodeURIComponent(submittedBody.job.id)}`);
            assert.equal(status.status, 200);
            const statusBody = await status.json() as {
              job: { status: string; result?: { archiveName: string } };
            };
            assert.equal(statusBody.job.status, "succeeded");
            assert.equal(
              statusBody.job.result?.archiveName,
              `backup-${tenantId}-${vaultId}-${submittedBody.job.id}.tar.gz.enc`,
            );

            const replay = await fetch(endpoint, {
              method: "POST",
              headers: { "idempotency-key": "portal-backup-request-a" },
            });
            assert.equal(replay.status, 200);

            const rateLimited = await fetch(endpoint, {
              method: "POST",
              headers: { "idempotency-key": "portal-backup-request-b" },
            });
            assert.equal(rateLimited.status, 429);
          });
        });
      } finally {
        await deleteUserMapEntriesForPolarisUserId(tenantId);
      }
    });
  } finally {
    if (portal) {
      portal.close();
      await once(portal, "close");
    }
    closePolarisControlStore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
