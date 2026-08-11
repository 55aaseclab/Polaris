import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DockerDriver } from "../scripts/backends/docker/driver.js";
import { createCommand } from "../scripts/cli/commands/create.js";
import { loadVaultForProjectRef } from "../scripts/cli/commands/shared.js";
import { createUserCommand } from "../scripts/cli/commands/create-user.js";
import { vaultRuntimeScopeName } from "../scripts/core/vault-name.js";
import {
  ActiveVaultCapacityError,
  maxActiveVaults,
  withDockerActiveVaultCapacity,
} from "../scripts/control-plane/capacity.js";
import { polarisUsersRoot } from "../scripts/utils/paths.js";

const USER_ROOT = polarisUsersRoot(import.meta.url);
const APP_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function withFakePath(
  commands: Record<string, string>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-active-vault-capacity-"));
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

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test("active-vault capacity requires a release value and defaults to the reviewed local limit", () => {
  assert.equal(maxActiveVaults({}), 10);
  assert.equal(maxActiveVaults({ POLARIS_MAX_ACTIVE_VAULTS: "3" }), 3);
  assert.equal(maxActiveVaults({ POLARIS_MAX_ACTIVE_VAULTS: "20" }), 20);
  assert.throws(
    () => maxActiveVaults({ POLARIS_RELEASE_PROFILE: "0.3.0-single-host" }),
    /POLARIS_MAX_ACTIVE_VAULTS is required/i,
  );
  assert.throws(
    () => maxActiveVaults({ POLARIS_MAX_ACTIVE_VAULTS: "0" }),
    /positive integer/i,
  );
});

test("Docker start admits the 20th vault and rejects the 21st under the 0.3.4 ceiling", async () => {
  const users: string[] = [];
  const vaults: string[] = [];
  const activeContainersPath = path.join(os.tmpdir(), `${uniqueName("active-20")}.txt`);
  const previousLimit = process.env.POLARIS_MAX_ACTIVE_VAULTS;
  const previousContainersPath = process.env.POLARIS_TEST_ACTIVE_VAULTS_FILE;
  try {
    const lines: string[] = [];
    for (let index = 1; index <= 21; index += 1) {
      const userId = uniqueName(`cap20-user-${index}`);
      const vault = uniqueName(`cap20-vault-${index}`);
      users.push(userId);
      vaults.push(vault);
      await createUserCommand([userId, "--name", `Cap20 ${index}`, "--email", `${userId}@polaris.local`]);
      await createCommand([vault, "--user", userId]);
      if (index <= 19) {
        lines.push(`${vaultRuntimeScopeName(userId, vault)}-docker`);
      }
    }
    fs.writeFileSync(activeContainersPath, `${lines.join("\n")}\n`, "utf8");
    process.env.POLARIS_MAX_ACTIVE_VAULTS = "20";
    process.env.POLARIS_TEST_ACTIVE_VAULTS_FILE = activeContainersPath;

    await withFakePath(
      {
        docker: `
if [[ "$1" == "ps" && "$2" == "--format" ]]; then
  cat "$POLARIS_TEST_ACTIVE_VAULTS_FILE"
  exit 0
fi
exit 0
`,
      },
      async () => {
        const twentiethUser = users[19];
        const twentiethVault = vaults[19];
        const twentyFirstUser = users[20];
        const twentyFirstVault = vaults[20];
        assert.ok(twentiethUser && twentiethVault && twentyFirstUser && twentyFirstVault);

        let admitted = false;
        await withDockerActiveVaultCapacity(import.meta.url, {
          userId: twentiethUser,
          vault: twentiethVault,
        }, async () => {
          admitted = true;
          fs.appendFileSync(
            activeContainersPath,
            `${vaultRuntimeScopeName(twentiethUser, twentiethVault)}-docker\n`,
            "utf8",
          );
        });
        assert.equal(admitted, true);

        await assert.rejects(
          () => withDockerActiveVaultCapacity(import.meta.url, {
            userId: twentyFirstUser,
            vault: twentyFirstVault,
          }, async () => undefined),
          (error: unknown) => {
            assert.ok(error instanceof ActiveVaultCapacityError);
            assert.equal(error.limit, 20);
            assert.equal(error.activeVaults, 20);
            return true;
          },
        );
      },
    );
  } finally {
    restoreEnvironment("POLARIS_MAX_ACTIVE_VAULTS", previousLimit);
    restoreEnvironment("POLARIS_TEST_ACTIVE_VAULTS_FILE", previousContainersPath);
    fs.rmSync(activeContainersPath, { force: true });
    for (const userId of users) {
      fs.rmSync(path.join(USER_ROOT, "profiles", `${userId}.yaml`), { force: true });
      fs.rmSync(path.join(USER_ROOT, userId), { recursive: true, force: true });
    }
  }
});

test("the CLI entrypoint returns failure status for a rejected command", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-cli-entrypoint-"));
  try {
    const result = spawnSync(
      path.join(APP_ROOT, "node_modules", ".bin", "tsx"),
      ["scripts/polaris.ts", "vault", "start", "missing-vault@docker", "--user", "missing-user"],
      {
        cwd: APP_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          POLARIS_DATA_ROOT: dataRoot,
          POLARIS_TELEMETRY_ENABLED: "false",
        },
      },
    );
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /Config not found for project 'missing-vault'/i);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("Docker start rejects a new vault at capacity but permits an existing running vault", async () => {
  const userA = uniqueName("active-capacity-user-a");
  const userB = uniqueName("active-capacity-user-b");
  const vaultA = uniqueName("active-capacity-vault-a");
  const vaultB = uniqueName("active-capacity-vault-b");
  const activeContainersPath = path.join(os.tmpdir(), `${uniqueName("active-containers")}.txt`);
  const previousLimit = process.env.POLARIS_MAX_ACTIVE_VAULTS;
  const previousContainersPath = process.env.POLARIS_TEST_ACTIVE_VAULTS_FILE;
  try {
    await createUserCommand([userA, "--name", "Active Capacity A", "--email", `${userA}@polaris.local`]);
    await createUserCommand([userB, "--name", "Active Capacity B", "--email", `${userB}@polaris.local`]);
    await createCommand([vaultA, "--user", userA]);
    await createCommand([vaultB, "--user", userB]);
    fs.writeFileSync(
      activeContainersPath,
      `${vaultRuntimeScopeName(userA, vaultA)}-docker\n`,
      "utf8",
    );
    process.env.POLARIS_MAX_ACTIVE_VAULTS = "1";
    process.env.POLARIS_TEST_ACTIVE_VAULTS_FILE = activeContainersPath;

    await withFakePath(
      {
        docker: `
if [[ "$1" == "ps" && "$2" == "--format" ]]; then
  cat "$POLARIS_TEST_ACTIVE_VAULTS_FILE"
  exit 0
fi
exit 0
`,
      },
      async () => {
        const driver = new DockerDriver();
        const target = loadVaultForProjectRef(`${vaultB}@docker`, userB);
        await assert.rejects(
          () => driver.start(target),
          (error: unknown) => {
            assert.ok(error instanceof ActiveVaultCapacityError);
            assert.equal(error.limit, 1);
            assert.equal(error.activeVaults, 1);
            return true;
          },
        );

        let allowed = false;
        await withDockerActiveVaultCapacity(import.meta.url, {
          userId: userA,
          vault: vaultA,
        }, async () => {
          allowed = true;
        });
        assert.equal(allowed, true);
      },
    );
  } finally {
    restoreEnvironment("POLARIS_MAX_ACTIVE_VAULTS", previousLimit);
    restoreEnvironment("POLARIS_TEST_ACTIVE_VAULTS_FILE", previousContainersPath);
    fs.rmSync(activeContainersPath, { force: true });
    fs.rmSync(path.join(USER_ROOT, "profiles", `${userA}.yaml`), { force: true });
    fs.rmSync(path.join(USER_ROOT, "profiles", `${userB}.yaml`), { force: true });
    fs.rmSync(path.join(USER_ROOT, userA), { recursive: true, force: true });
    fs.rmSync(path.join(USER_ROOT, userB), { recursive: true, force: true });
  }
});

test("active-vault capacity serializes concurrent cross-tenant admissions", async () => {
  const userA = uniqueName("active-race-user-a");
  const userB = uniqueName("active-race-user-b");
  const vaultA = uniqueName("active-race-vault-a");
  const vaultB = uniqueName("active-race-vault-b");
  const activeContainersPath = path.join(os.tmpdir(), `${uniqueName("active-race-containers")}.txt`);
  const previousLimit = process.env.POLARIS_MAX_ACTIVE_VAULTS;
  const previousContainersPath = process.env.POLARIS_TEST_ACTIVE_VAULTS_FILE;
  try {
    await createUserCommand([userA, "--name", "Active Race A", "--email", `${userA}@polaris.local`]);
    await createUserCommand([userB, "--name", "Active Race B", "--email", `${userB}@polaris.local`]);
    await createCommand([vaultA, "--user", userA]);
    await createCommand([vaultB, "--user", userB]);
    fs.writeFileSync(activeContainersPath, "", "utf8");
    process.env.POLARIS_MAX_ACTIVE_VAULTS = "1";
    process.env.POLARIS_TEST_ACTIVE_VAULTS_FILE = activeContainersPath;

    await withFakePath(
      {
        docker: `
if [[ "$1" == "ps" && "$2" == "--format" ]]; then
  cat "$POLARIS_TEST_ACTIVE_VAULTS_FILE"
  exit 0
fi
exit 0
`,
      },
      async () => {
        const first = withDockerActiveVaultCapacity(import.meta.url, {
          userId: userA,
          vault: vaultA,
        }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 125));
          fs.appendFileSync(
            activeContainersPath,
            `${vaultRuntimeScopeName(userA, vaultA)}-docker\n`,
            "utf8",
          );
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        const second = withDockerActiveVaultCapacity(import.meta.url, {
          userId: userB,
          vault: vaultB,
        }, async () => {
          fs.appendFileSync(
            activeContainersPath,
            `${vaultRuntimeScopeName(userB, vaultB)}-docker\n`,
            "utf8",
          );
        });

        const [firstResult, secondResult] = await Promise.allSettled([first, second]);
        assert.equal(firstResult.status, "fulfilled");
        assert.equal(secondResult.status, "rejected");
        assert.ok(secondResult.reason instanceof ActiveVaultCapacityError);
        assert.equal(secondResult.reason.limit, 1);
        assert.equal(
          fs.readFileSync(activeContainersPath, "utf8").trim(),
          `${vaultRuntimeScopeName(userA, vaultA)}-docker`,
        );
      },
    );
  } finally {
    restoreEnvironment("POLARIS_MAX_ACTIVE_VAULTS", previousLimit);
    restoreEnvironment("POLARIS_TEST_ACTIVE_VAULTS_FILE", previousContainersPath);
    fs.rmSync(activeContainersPath, { force: true });
    fs.rmSync(path.join(USER_ROOT, "profiles", `${userA}.yaml`), { force: true });
    fs.rmSync(path.join(USER_ROOT, "profiles", `${userB}.yaml`), { force: true });
    fs.rmSync(path.join(USER_ROOT, userA), { recursive: true, force: true });
    fs.rmSync(path.join(USER_ROOT, userB), { recursive: true, force: true });
  }
});
