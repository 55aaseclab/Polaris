import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../scripts/cli/main.js";
import { createCommand } from "../scripts/cli/commands/create.js";
import { createUserCommand } from "../scripts/cli/commands/create-user.js";
import {
  vaultSelectionPath,
  vaultStatusPath,
} from "../scripts/output/state-store.js";
import { polarisUsersRoot } from "../scripts/utils/paths.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const USER_ROOT = polarisUsersRoot(import.meta.url);

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

async function withFakePath(
  commands: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-ops-"));
  const originalPath = process.env.PATH || "";
  for (const [name, body] of Object.entries(commands)) {
    fs.writeFileSync(path.join(tempDir, name), body, { mode: 0o755 });
  }
  process.env.PATH = `${tempDir}:${originalPath}`;
  try {
    await fn();
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
    return chunks.join("");
  } finally {
    process.stdout.write = originalWrite;
  }
}

test("ops reconcile-vaults migrates status, removes selection, and rebuilds running docker vaults", async () => {
  const userId = uniqueName("ops-user");
  const vault = uniqueName("ops-vault");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);
  const commandLogPath = path.join(os.tmpdir(), `${vault}-docker.log`);
  try {
    await createUserCommand([userId, "--name", "Ops User", "--email", `${userId}@polaris.local`]);
    await createCommand([vault, "--user", userId]);

    const statusPath = vaultStatusPath(vault, userId);
    const selectionPath = vaultSelectionPath(vault, userId);
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(statusPath, `${JSON.stringify({
      schemaVersion: 1,
      project: vault,
      driver: {
        backend: "docker",
      },
      runtime: {
        selectedDriver: {
          backend: "docker",
        },
        lifecycle: "running",
      },
      details: {},
    }, null, 2)}\n`, "utf8");
    fs.writeFileSync(selectionPath, `${JSON.stringify({ backend: "docker" }, null, 2)}\n`, "utf8");
    fs.rmSync(commandLogPath, { force: true });

    await withFakePath(
      {
        docker: `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(commandLogPath)}
if [[ "$1" == "compose" && "$4" == "ps" ]]; then
  printf 'ops-running-id'
  exit 0
fi
if [[ "$1" == "inspect" && "$2" == "ops-running-id" ]]; then
  printf '[{"State":{"Running":true}}]'
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  exit 0
fi
if [[ "$1" == "image" && "$2" == "inspect" ]]; then
  exit 0
fi
if [[ "$1" == "compose" && "$4" == "up" ]]; then
  exit 0
fi
exit 0
`,
      },
      async () => {
        const output = await captureStdout(async () => {
          await runCli([
            "ops",
            "reconcile-vaults",
            "--user",
            userId,
            "--vault",
            vault,
            "--json",
          ]);
        });
        const parsed = JSON.parse(output) as {
          vaultCount: number;
          migratedCount: number;
          removedSelectionCount: number;
          rebuiltCount: number;
          results: Array<{
            migratedStatusFile: boolean;
            removedSelectionFile: boolean;
            rebuiltRunningDocker: boolean;
            finalDriverStatus: string | null;
          }>;
        };
        assert.equal(parsed.vaultCount, 1);
        assert.equal(parsed.migratedCount, 1);
        assert.equal(parsed.removedSelectionCount, 1);
        assert.equal(parsed.rebuiltCount, 1);
        assert.equal(parsed.results[0]?.migratedStatusFile, true);
        assert.equal(parsed.results[0]?.removedSelectionFile, true);
        assert.equal(parsed.results[0]?.rebuiltRunningDocker, true);
        assert.equal(parsed.results[0]?.finalDriverStatus, "running");
      },
    );

    const migrated = JSON.parse(fs.readFileSync(statusPath, "utf8")) as {
      schemaVersion?: number;
      driver?: {
        selected?: {
          backend?: string;
        };
        status?: string;
      };
    };
    assert.equal(migrated.schemaVersion, 1.1);
    assert.equal(migrated.driver?.selected?.backend, "docker");
    assert.equal(migrated.driver?.status, "running");
    assert.equal(fs.existsSync(selectionPath), false);

    const commandLog = fs.readFileSync(commandLogPath, "utf8");
    assert.match(commandLog, /compose .* up -d --force-recreate/);
  } finally {
    fs.rmSync(commandLogPath, { force: true });
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});
