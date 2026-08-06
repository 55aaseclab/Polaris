import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import yaml from "js-yaml";
import { createClerkClient } from "@clerk/backend";
import { createPortalServer } from "../scripts/portal/server.js";
import {
  deleteUserMapEntriesForPolarisUserId,
  readUserAccessSummary,
  upsertUserMapEntry,
  upsertUserMapUserId,
} from "../scripts/portal/user-map.js";
import { withUserMutationLock } from "../scripts/utils/user-mutation-lock.js";
import { withVaultLifecycleLock } from "../scripts/utils/vault-lifecycle-lock.js";
import {
  activatePortalCredential,
  bindPortalVaultAgent,
  cancelPortalVaultProvision,
  createPortalCredential,
  createPortalSkill,
  deletePortalVault,
  deletePortalCredential,
  deletePortalSkill,
  deletePortalUser,
  getPortalCredentialCatalog,
  getPortalVaultDetail,
  listPortalAdminUsers,
  listPortalVaults,
  listUserPortalCredentials,
  readUserPortalCredentialRecord,
  listUserPortalSkills,
  queueProvisionVault,
  readUserPortalCredentialPreview,
  readUserPortalVaultAssetPreview,
  reportPortalVaultStatus,
  startPortalVault,
  stopPortalVault,
  switchPortalVault,
  switchPortalVaultLiveCredential,
  syncPortalVaultSkills,
  unbindPortalVaultAgent,
  installPortalVaultSkill,
  listPortalVaultSkills,
  uninstallPortalVaultSkill,
} from "../scripts/portal/service.js";
import { subscribePortalVaultStream } from "../scripts/portal/vault-live-hub.js";
import { createCommand } from "../scripts/cli/commands/create.js";
import { createUserCommand } from "../scripts/cli/commands/create-user.js";
import { deleteVaultOwnedByUser } from "../scripts/cli/commands/delete.js";
import {
  scaffoldDockerVault,
  scaffoldUserProfileById,
  vaultConfigPath,
} from "../scripts/config/scaffold.js";
import {
  listOwnedVaults,
  readPortalProfile,
  readVaultProvisionProgress,
  readVaultStatus,
  updatePortalProfile,
  wanghaiGatewayId,
  writeVaultProvisionProgress,
  clearVaultProvisionProgress,
} from "../scripts/core/portal.js";
import {
  vaultPaseoStateDir,
  vaultSelectionPath,
  writeVaultDriverSelection,
  writeVaultStatus,
} from "../scripts/output/state-store.js";
import {
  resumeDurableVaultJobs,
  stopPortalVault as stopPortalVaultDirect,
} from "../scripts/runtime/operations.js";
import {
  closePolarisControlStore,
  getPolarisControlStore,
} from "../scripts/portal/control-store.js";
import { vaultRuntimeScopeName } from "../scripts/core/vault-name.js";
import { readVaultDriverSelection } from "../scripts/output/state-store.js";
import { polarisUsersRoot } from "../scripts/utils/paths.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const USER_ROOT = polarisUsersRoot(import.meta.url);
const USER_MAP_PATH = path.join(USER_ROOT, "user-map.json");
const DEMO_USER_ID = "100000000000000001";

function repoRelative(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, "/") || ".";
}

interface LivePortalIdentity {
  clerkUserId: string;
  clerkUsername: string;
  token: string;
  cleanup: () => Promise<void>;
}

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

function uniquePassword(): string {
  return `PolarisPortal!${Date.now()}aa`;
}

function clerkSecretKey(): string {
  const value = process.env.CLERK_SECRET_KEY?.trim();
  if (!value) {
    throw new Error("CLERK_SECRET_KEY is required for Polaris portal tests");
  }
  return value;
}

function clerkClient() {
  return createClerkClient({
    secretKey: clerkSecretKey(),
  });
}

async function createLivePortalIdentity(
  username = uniqueName("portal-clerk"),
): Promise<LivePortalIdentity> {
  const password = uniquePassword();
  const client = clerkClient();
  const user = await client.users.createUser({
    username,
    password,
    firstName: "Portal",
    lastName: "Test",
  });
  const session = await client.sessions.createSession({
    userId: user.id,
  });
  const token = await client.sessions.getToken(session.id);
  return {
    clerkUserId: user.id,
    clerkUsername: user.username?.trim().toLowerCase() || username.trim().toLowerCase(),
    token: token.jwt,
    cleanup: async () => {
      try {
        await client.sessions.revokeSession(session.id);
      } catch {
        // Ignore already-revoked sessions during test cleanup.
      }
      try {
        await client.users.deleteUser(user.id);
      } catch {
        // Ignore already-deleted users during test cleanup.
      }
    },
  };
}

async function mapIdentityToPolarisUser(
  identity: LivePortalIdentity,
  input: {
    polarisUserId: string;
    role?: "admin" | "user";
    plan?: "free" | "pro";
    line?: "coding" | "vertical";
  },
): Promise<void> {
  const entry = {
    polarisUserId: input.polarisUserId,
    role: input.role ?? "user" as const,
    plan: input.plan ?? "free" as const,
    line: input.line ?? "coding" as const,
  };
  await upsertUserMapEntry(identity.clerkUsername, entry);
  await upsertUserMapUserId(identity.clerkUserId, entry);
}

function removeIdentityMappings(identity: LivePortalIdentity): void {
  if (!fs.existsSync(USER_MAP_PATH)) {
    return;
  }
  const current = JSON.parse(fs.readFileSync(USER_MAP_PATH, "utf8")) as {
    users?: Record<string, { polarisUserId: string }>;
    userIds?: Record<string, { polarisUserId: string }>;
  };
  if (current.users?.[identity.clerkUsername]) {
    delete current.users[identity.clerkUsername];
  }
  if (current.userIds?.[identity.clerkUserId]) {
    delete current.userIds[identity.clerkUserId];
  }
  fs.writeFileSync(USER_MAP_PATH, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

async function waitFor<T>(
  read: () => T | null,
  options?: {
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 15000;
  const intervalMs = options?.intervalMs ?? 100;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function waitForProvisionDone(userId: string, vault: string) {
  return waitFor(() => {
    const progress = readVaultProvisionProgress(userId, vault);
    return progress?.done ? progress : null;
  });
}

async function waitForVaultStatusFile(userId: string, vault: string) {
  return waitFor(() => {
    const status = readVaultStatus(userId, vault);
    return status ? status : null;
  });
}

async function waitForCommandLogMatch(
  readCommandLog: () => string[],
  pattern: (entry: string) => boolean,
) {
  return waitFor(() => {
    const entries = readCommandLog();
    return entries.some(pattern) ? entries : null;
  });
}

async function cleanupVaultRuntime(
  userId: string,
  vault: string,
): Promise<void> {
  try {
    await stopPortalVaultDirect(userId, vault);
  } catch {
    // Ignore cleanup failures so filesystem cleanup still runs.
  }
  try {
    await deleteVaultOwnedByUser(userId, vault);
  } catch {
    // Ignore cleanup failures so tests do not mask the original assertion.
  }
}

async function withFakePath(
  commands: Record<string, string>,
  fn: (ctx: { readCommandLog: () => string[] }) => Promise<void> | void,
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-portal-"));
  const commandLogPath = path.join(tempDir, "commands.log");
  const originalPath = process.env.PATH || "";
  for (const [name, body] of Object.entries(commands)) {
    fs.writeFileSync(
      path.join(tempDir, name),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(commandLogPath)}
${body}
`,
      { mode: 0o755 },
    );
  }
  process.env.PATH = `${tempDir}:${originalPath}`;
  try {
    await fn({
      readCommandLog: () =>
        fs.existsSync(commandLogPath)
          ? fs.readFileSync(commandLogPath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean)
          : [],
    });
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function withPortalServerIdentity(
  identity: LivePortalIdentity,
  fn: (baseUrl: string) => Promise<void>,
  env?: Record<string, string>,
): Promise<void> {
  const entries = Object.entries(env ?? {});
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of entries) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  const server = createPortalServer(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Portal server did not expose a TCP address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(baseUrl)) {
      return originalFetch(input, init);
    }
    const headers = new Headers(init?.headers ?? {});
    if (!headers.has("authorization")) {
      headers.set("authorization", `Bearer ${identity.token}`);
    }
    return originalFetch(input, {
      ...init,
      headers,
    });
  }) as typeof fetch;
  try {
    await fn(baseUrl);
  } finally {
    globalThis.fetch = originalFetch;
    server.close();
    await once(server, "close");
    for (const [key] of entries) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withPortalServer(
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const adminIdentity = await createLivePortalIdentity();
  try {
    await mapIdentityToPolarisUser(adminIdentity, {
      polarisUserId: DEMO_USER_ID,
      role: "admin",
      plan: "pro",
    });
    await withPortalServerIdentity(
      adminIdentity,
      fn,
    );
  } finally {
    removeIdentityMappings(adminIdentity);
    await adminIdentity.cleanup();
  }
}

async function withEnv(
  name: string,
  value: string,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

async function withSyntheticMemberUser(
  fn: (userId: string, vault: string) => Promise<void>,
): Promise<void> {
  const userId = uniqueName("portal-member");
  const vault = uniqueName("portal-member-vault");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const vaultRoot = path.join(USER_ROOT, userId, "vaults", vault);
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.mkdirSync(vaultRoot, { recursive: true });
  fs.writeFileSync(
    profilePath,
    yaml.dump({
      id: userId,
      name: "Portal Member",
      email: `${userId}@polaris.local`,
      vaults: [vault],
      github: {
        account: null,
      },
      ssh: {
        mode: "managed-key",
        comment: `${userId}@polaris.local`,
      },
    }, { lineWidth: 120, noRefs: true }),
    "utf8",
  );
  try {
    await fn(userId, vault);
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(path.join(USER_ROOT, userId), {
      recursive: true,
      force: true,
    });
  }
}

test("vault ownership is derived from the project directory", () => {
  const userId = "100000000000000001";
  const vault = uniqueName("portal-owned");
  const root = path.join(USER_ROOT, userId, "vaults", vault);
  fs.mkdirSync(root, { recursive: true });
  fs.copyFileSync(
    vaultConfigPath("demo", "docker", userId),
    path.join(root, "docker.agent.yaml"),
  );
  try {
    assert.ok(listOwnedVaults(userId).includes(vault));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("portal provisioning progress persists across reads", () => {
  const userId = DEMO_USER_ID;
  const vault = uniqueName("portal-progress");
  const progress = {
    userId,
    vault,
    phase: "images",
    step: 2,
    totalSteps: 6,
    percent: 33,
    message: "building images",
    updatedAt: new Date().toISOString(),
    done: false,
  };
  try {
    writeVaultProvisionProgress(userId, vault, progress);
    assert.deepEqual(readVaultProvisionProgress(userId, vault), progress);
  } finally {
    clearVaultProvisionProgress(userId, vault);
  }
});

test("portal vault detail returns cached detail without triggering a backend refresh", async () => {
  await withFakePath(
    {
      docker: "#!/bin/sh\nexit 0\n",
      kubectl: "#!/bin/sh\nexit 0\n",
    },
    async ({ readCommandLog }) => {
      const previousSelection = readVaultDriverSelection("demo", DEMO_USER_ID);
      try {
        writeVaultDriverSelection("demo", { backend: "docker" }, DEMO_USER_ID);
        const detail = await getPortalVaultDetail(DEMO_USER_ID, "demo");
        assert.equal(detail.name, "demo");
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(readCommandLog().length, 0);
      } finally {
        if (previousSelection) {
          writeVaultDriverSelection("demo", previousSelection, DEMO_USER_ID);
        } else {
          fs.rmSync(vaultSelectionPath("demo", DEMO_USER_ID), { force: true });
        }
      }
    },
  );
});

test("portal vault list refreshes status before returning", async () => {
  await withFakePath(
    {
      docker: "#!/bin/sh\nexit 0\n",
      kubectl: "#!/bin/sh\nexit 0\n",
    },
    async ({ readCommandLog }) => {
      const previousSelection = readVaultDriverSelection("demo", DEMO_USER_ID);
      try {
        writeVaultDriverSelection("demo", { backend: "docker" }, DEMO_USER_ID);
        const vaults = await listPortalVaults(DEMO_USER_ID);
        const demoVault = vaults.find((vault) => vault.name === "demo");
        assert.ok(demoVault);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(readCommandLog().length, 0);
      } finally {
        if (previousSelection) {
          writeVaultDriverSelection("demo", previousSelection, DEMO_USER_ID);
        } else {
          fs.rmSync(vaultSelectionPath("demo", DEMO_USER_ID), { force: true });
        }
      }
    },
  );
});

test("portal vault stop writes cached status before the async refresh completes", async () => {
  const userId = uniqueName("portal-stop-cache-user");
  const vault = uniqueName("portal-stop-cache");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const vaultRoot = path.join(USER_ROOT, userId, "vaults", vault);
  try {
    await createUserCommand([userId, "--name", "Portal Stop Cache User", "--email", `${userId}@polaris.local`]);
    await createCommand([vault, "--user", userId]);
    writeVaultDriverSelection(vault, { backend: "docker" }, userId);
    writeVaultStatus({
      project: vault,
      driver: {
        backend: "docker",
        baseImage: "ttl.sh/example:24h",
        runtimeKind: "docker-container",
        runtimeRef: `container/${vaultRuntimeScopeName(userId, vault)}-docker`,
      },
      runtime: {
        selectedDriver: { backend: "docker" },
        lifecycle: "running",
        reason: "test setup",
      },
      paseo: {
        daemon: "ready",
        web: "connectable",
        reconnectMode: "reconnectable",
        liveTarget: "https://app.paseo.test/#offer=ready",
        reconnectTarget: "https://app.paseo.test/h/srv_ready?scope=test",
      },
      details: {},
    }, userId);

    await withFakePath(
      {
        docker: "#!/bin/sh\nif [ \"$1\" = \"compose\" ] && [ \"$4\" = \"stop\" ]; then sleep 0.05; exit 0; fi\nif [ \"$1\" = \"compose\" ] && [ \"$4\" = \"ps\" ]; then sleep 0.3; exit 0; fi\nif [ \"$1\" = \"compose\" ]; then exit 0; fi\nif [ \"$1\" = \"image\" ] && [ \"$2\" = \"inspect\" ]; then exit 0; fi\nexit 0\n",
        kubectl: "#!/bin/sh\nexit 0\n",
      },
      async () => {
        const stderrChunks: string[] = [];
        const originalWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
          stderrChunks.push(
            typeof chunk === "string"
              ? chunk
              : Buffer.from(chunk).toString("utf8"),
          );
          const callback = args.find((arg) => typeof arg === "function") as (() => void) | undefined;
          callback?.();
          return true;
        }) as typeof process.stderr.write;
        try {
          await stopPortalVaultDirect(userId, vault);
          const cachedStatus = readVaultStatus(userId, vault);
          assert.equal(cachedStatus?.driver?.status, "stopped");
        } finally {
          process.stderr.write = originalWrite;
        }
      },
    );
  } finally {
    fs.rmSync(vaultRoot, { recursive: true, force: true });
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(path.join(USER_ROOT, userId), {
      recursive: true,
      force: true,
    });
  }
});

test("portal vault stop publishes stopping to the live stream before completion", async () => {
  const userId = uniqueName("portal-stop-live-user");
  const vault = uniqueName("portal-stop-live");
  const vaultRoot = path.join(USER_ROOT, userId, "vaults", vault);
  const profileFile = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);
  try {
    await createUserCommand([userId, "--name", "Portal Stop Live User", "--email", `${userId}@polaris.local`]);
    await createCommand([`${vault}@docker`, "--user", userId]);
    writeVaultStatus({
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
        liveTarget: "http://127.0.0.1:6767/h/demo",
        reconnectTarget: null,
      },
      details: {},
    }, userId);

    await withFakePath(
      {
        docker: `
if [[ "$1" == "compose" && "$4" == "stop" ]]; then
  sleep 1
  exit 0
fi
if [[ "$1" == "compose" && "$4" == "ps" ]]; then
  exit 0
fi
if [[ "$1" == "inspect" ]]; then
  printf '[{"State":{"Running":false}}]'
  exit 0
fi
exit 0
`,
      },
      async () => {
        const events: Array<{ status: string | null }> = [];
        const unsubscribe = subscribePortalVaultStream(userId, (event) => {
          if (event.type === "live-upsert" && event.vault.name === vault) {
            events.push({
              status: event.vault.status?.driver?.status ?? null,
            });
          }
        });
        try {
          await new Promise((resolve) => setTimeout(resolve, 50));
          await stopPortalVault(userId, vault);
          await waitFor(() => {
            return events.some((event) => event.status === "stopping") ? true : null;
          });
        } finally {
          unsubscribe();
        }
      },
    );
  } finally {
    fs.rmSync(vaultRoot, { recursive: true, force: true });
    fs.rmSync(profileFile, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("portal vault stop surfaces backend stop failures instead of reporting success", async () => {
  const userId = uniqueName("portal-stop-failure-user");
  const vault = uniqueName("portal-stop-failure");
  const userRoot = path.join(USER_ROOT, userId);
  const vaultRoot = path.join(userRoot, "vaults", vault);
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);

  try {
    await createUserCommand([userId, "--name", "Portal Stop Failure User", "--email", `${userId}@polaris.local`]);
    await createCommand([vault, "--user", userId]);
    writeVaultStatus({
      project: vault,
      schemaVersion: 1.1,
      driver: {
        selected: { backend: "docker" },
        status: "running",
        reason: "test setup",
      },
      paseo: {
        daemon: "ready",
        web: "connectable",
        reconnectMode: "reconnectable",
        liveTarget: "https://app.paseo.test/#offer=ready",
        reconnectTarget: "https://app.paseo.test/h/srv_ready?scope=test",
      },
      details: {},
    }, userId);

    await withFakePath(
      {
        docker: `
if [[ "$1" == "compose" && "$4" == "stop" ]]; then
  echo "stop failed" >&2
  exit 1
fi
exit 0
`,
        kubectl: "#!/bin/sh\nexit 0\n",
      },
      async () => {
        await assert.rejects(
          stopPortalVault(userId, vault),
          /stop failed|docker compose/i,
        );
      },
    );
  } finally {
    fs.rmSync(vaultRoot, { recursive: true, force: true });
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(path.join(USER_ROOT, userId), {
      recursive: true,
      force: true,
    });
  }
});

test("portal API rejects unauthenticated admin access", async () => {
  const server = createPortalServer(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Portal server did not expose a TCP address");
  }
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/admin/users`);
    assert.equal(response.status, 401);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("portal API rejects invalid Authing sessions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    assert.equal(url, "https://auth.example/oidc/me");
    const headers = new Headers(init?.headers ?? {});
    assert.equal(headers.get("authorization"), "Bearer fake-token");
    return new Response(
      JSON.stringify({ message: "invalid token" }),
      {
        status: 401,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  try {
    await withEnv("POLARIS_AUTHING_ISSUER", "https://auth.example/oidc", async () => {
      const server = createPortalServer(0);
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Portal server did not expose a TCP address");
      }
      try {
        const response = await originalFetch(`http://127.0.0.1:${address.port}/api/session`, {
          headers: {
            authorization: "Bearer fake-token",
          },
        });
        assert.equal(response.status, 401);
        const payload = await response.json() as { error?: string };
        assert.match(payload.error ?? "", /Authing user info request failed/i);
      } finally {
        server.close();
        await once(server, "close");
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("user-map writes recover from a stale lock directory", async () => {
  const originalUserMap = fs.existsSync(USER_MAP_PATH)
    ? fs.readFileSync(USER_MAP_PATH, "utf8")
    : null;
  const lockPath = `${USER_MAP_PATH}.lock`;
  fs.mkdirSync(lockPath, { recursive: true });
  const staleAt = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, staleAt, staleAt);
  try {
    const username = uniqueName("stale-lock-user");
    await upsertUserMapEntry(username, {
      polarisUserId: username,
      role: "user",
      plan: "free",
    });
    const written = JSON.parse(fs.readFileSync(USER_MAP_PATH, "utf8")) as {
      users?: Record<string, { polarisUserId?: string }>;
    };
    assert.equal(written.users?.[username]?.polarisUserId, username);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("user-map waits through the TTL window and then recovers a stranded fresh lock", async () => {
  const originalUserMap = fs.existsSync(USER_MAP_PATH)
    ? fs.readFileSync(USER_MAP_PATH, "utf8")
    : null;
  const lockPath = `${USER_MAP_PATH}.lock`;
  const previousTtl = process.env.POLARIS_USER_MAP_LOCK_TTL_MS;
  fs.mkdirSync(lockPath, { recursive: true });
  try {
    process.env.POLARIS_USER_MAP_LOCK_TTL_MS = "200";
    const username = uniqueName("stale-lock-window-user");
    const startedAt = Date.now();
    await upsertUserMapEntry(username, {
      polarisUserId: username,
      role: "user",
      plan: "free",
    });
    assert.ok(Date.now() - startedAt >= 200);
    const written = JSON.parse(fs.readFileSync(USER_MAP_PATH, "utf8")) as {
      users?: Record<string, { polarisUserId?: string }>;
    };
    assert.equal(written.users?.[username]?.polarisUserId, username);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    if (previousTtl === undefined) {
      delete process.env.POLARIS_USER_MAP_LOCK_TTL_MS;
    } else {
      process.env.POLARIS_USER_MAP_LOCK_TTL_MS = previousTtl;
    }
    fs.rmSync(lockPath, { recursive: true, force: true });
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("user mutation lock serializes same-user writers", async () => {
  const userId = uniqueName("portal-lock-user");
  const events: string[] = [];
  const first = withUserMutationLock(import.meta.url, userId, async () => {
    events.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 150));
    events.push("first:end");
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = withUserMutationLock(import.meta.url, userId, async () => {
    events.push("second:start");
    events.push("second:end");
  });
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});

test("vault lifecycle lock serializes same-vault writers", async () => {
  const userId = uniqueName("portal-vault-lock-user");
  const vault = uniqueName("portal-vault-lock");
  const events: string[] = [];
  const first = withVaultLifecycleLock(
    import.meta.url,
    userId,
    vault,
    async () => {
      events.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 150));
      events.push("first:end");
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = withVaultLifecycleLock(
    import.meta.url,
    userId,
    vault,
    async () => {
      events.push("second:start");
      events.push("second:end");
    },
  );
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});


test("portal credential preview hides material content", async () => {
  const credentialId = uniqueName("portal-preview");
  const userId = DEMO_USER_ID;

  try {
    await createPortalCredential({
      userId,
      harness: "codex",
      credentialId,
      label: "Portal Preview Credential",
      providerName: "rightcode",
      baseUrl: "https://right.codes/codex/v1",
      apiKey: "preview-test",
    });

    const preview = readUserPortalCredentialPreview(
      userId,
      `credentials/codex/${credentialId}/auth.json`,
    );
    assert.equal(preview.path, `credentials/codex/${credentialId}/auth.json`);
    assert.equal(preview.content, "[credential preview hidden]");
    assert.equal(preview.truncated, false);
  } finally {
    fs.rmSync(path.join(USER_ROOT, userId, "credentials", `${credentialId}.yaml`), {
      force: true,
    });
    fs.rmSync(path.join(USER_ROOT, userId, "credentials", "codex", credentialId), {
      recursive: true,
      force: true,
    });
  }
});

test("portal service lists and reads profile auth files for user settings", () => {
  const userId = uniqueName("portal-profile-auth");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);

  try {
    scaffoldUserProfileById({
      id: userId,
      name: "Portal Profile Auth User",
      email: "portal-profile-auth@example.com",
    });
    fs.writeFileSync(
      path.join(userRoot, "wanghai", ".env"),
      "WANGHAI_VAULTS_ROOT=/vault/project/vaults\nPORTAL_PROFILE_AUTH=1\n",
      "utf8",
    );

    const credential = listUserPortalCredentials(userId).find((entry) =>
      entry.paths.includes("wanghai/.env")
    );
    assert.ok(credential);
    assert.equal(credential?.label, "Wanghai .env");
    assert.equal(credential?.status, "ready");
    assert.equal(credential?.readOnly, true);

    const record = readUserPortalCredentialRecord(userId, credential?.id || "");
    assert.equal(record.credential.id, credential?.id);
    assert.deepEqual(record.files.map((file) => ({
      key: file.key,
      sourcePath: file.sourcePath,
      mountPath: file.mountPath,
    })), [{
      key: "wanghai-root-env",
      sourcePath: "wanghai/.env",
      mountPath: "/opt/wanghai/.env",
    }]);
    assert.match(record.files[0]?.content || "", /PORTAL_PROFILE_AUTH=1/);
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("portal service creates activates and deletes a codex credential for an existing user", async () => {
  const userId = uniqueName("portal-credential-user");
  const userRoot = path.join(USER_ROOT, userId);
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);

  try {
    await createUserCommand([userId, "--name", "Portal Credential User", "--email", `${userId}@polaris.local`]);

    const created = await createPortalCredential({
      userId,
      harness: "codex",
      label: "RightCode Codex",
      providerName: "rightcode",
      baseUrl: "https://right.codes/codex/v1",
      apiKey: "test-api-key",
    });
    const createdCredentialId = created.id;
    assert.equal(created.kind, "codex-auth");
    assert.equal(created.active, false);
    assert.deepEqual(created.paths, [
      `credentials/codex/${created.id}/auth.json`,
      `credentials/codex/${created.id}/config.toml`,
    ]);

    const createdRegistryPath = path.join(userRoot, "credentials", `${created.id}.yaml`);
    const createdAuthPath = path.join(userRoot, "credentials", "codex", created.id, "auth.json");
    const createdConfigPath = path.join(userRoot, "credentials", "codex", created.id, "config.toml");
    assert.equal(fs.existsSync(createdRegistryPath), true);
    assert.equal(fs.existsSync(createdAuthPath), true);
    assert.equal(fs.existsSync(createdConfigPath), true);

      const registry = (yaml.load(fs.readFileSync(createdRegistryPath, "utf8")) ?? {}) as {
        id?: string;
        kind?: string;
        label?: string;
        purposes?: string[];
        materialRef?: {
          files?: Array<{ key?: string; source_path?: string }>;
        };
      };
      assert.equal(registry.id, created.id);
      assert.equal(registry.kind, "codex-auth");
      assert.equal(registry.label, "RightCode Codex");
      assert.deepEqual(registry.purposes, ["agent-auth"]);
      assert.equal((registry as { metadata?: { active?: boolean } }).metadata?.active, false);
      assert.deepEqual(registry.materialRef?.files, [
        {
          key: "codex-auth.json",
          source_path: `credentials/codex/${created.id}/auth.json`,
        },
        {
          key: "codex-config.toml",
          source_path: `credentials/codex/${created.id}/config.toml`,
        },
      ]);

      const auth = JSON.parse(fs.readFileSync(createdAuthPath, "utf8")) as {
        OPENAI_API_KEY?: string;
      };
      assert.equal(auth.OPENAI_API_KEY, "test-api-key");

      const configToml = fs.readFileSync(createdConfigPath, "utf8");
      assert.match(configToml, /model_provider = "rightcode"/);
      assert.match(configToml, /model = "gpt-5\.5"/);
      assert.match(configToml, /\[model_providers\.rightcode\]/);
      assert.match(configToml, /base_url = "https:\/\/right\.codes\/codex\/v1"/);

    const activated = await activatePortalCredential(userId, createdCredentialId);
    assert.equal(activated.id, createdCredentialId);
    assert.equal(activated.active, true);
    const activatedRegistry = (yaml.load(fs.readFileSync(createdRegistryPath, "utf8")) ?? {}) as {
      metadata?: { active?: boolean };
    };
    assert.equal(activatedRegistry.metadata?.active, true);

    const deleted = await deletePortalCredential(userId, createdCredentialId);
    assert.equal(deleted.credential.id, createdCredentialId);
    assert.equal(deleted.credential.removed, true);
    assert.deepEqual(deleted.credential.removedPaths, [
      `credentials/codex/${createdCredentialId}/auth.json`,
      `credentials/codex/${createdCredentialId}/config.toml`,
    ]);

    assert.equal(fs.existsSync(path.join(userRoot, "credentials", `${createdCredentialId}.yaml`)), false);
    assert.equal(fs.existsSync(path.join(userRoot, "credentials", "codex", createdCredentialId, "auth.json")), false);
    assert.equal(fs.existsSync(path.join(userRoot, "credentials", "codex", createdCredentialId, "config.toml")), false);
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("portal service creates and deletes a codex credential for demo user 001", async () => {
  const userId = DEMO_USER_ID;
  const credentialId = uniqueName("demo-codex");
  const registryPath = path.join(USER_ROOT, userId, "credentials", `${credentialId}.yaml`);
  const authPath = path.join(USER_ROOT, userId, "credentials", "codex", credentialId, "auth.json");
  const configPath = path.join(USER_ROOT, userId, "credentials", "codex", credentialId, "config.toml");

  try {
    const created = await createPortalCredential({
      userId,
      harness: "codex",
      credentialId,
      label: "rightcode",
      providerName: "rightcode",
      baseUrl: "https://right.codes/codex/v1",
      apiKey: "demo-user-test-key",
    });
    assert.equal(created.id, credentialId);
    assert.equal(created.kind, "codex-auth");
    assert.equal(created.label, "rightcode");
    assert.deepEqual(created.paths, [
      `credentials/codex/${credentialId}/auth.json`,
      `credentials/codex/${credentialId}/config.toml`,
    ]);
    assert.equal(fs.existsSync(registryPath), true);
    assert.equal(fs.existsSync(authPath), true);
    assert.equal(fs.existsSync(configPath), true);

    const registry = (yaml.load(fs.readFileSync(registryPath, "utf8")) ?? {}) as {
      id?: string;
      kind?: string;
      label?: string;
      purposes?: string[];
    };
    assert.equal(registry.id, credentialId);
    assert.equal(registry.kind, "codex-auth");
    assert.equal(registry.label, "rightcode");
    assert.deepEqual(registry.purposes, ["agent-auth"]);

    const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as {
      OPENAI_API_KEY?: string;
    };
    assert.equal(auth.OPENAI_API_KEY, "demo-user-test-key");

    const configToml = fs.readFileSync(configPath, "utf8");
    assert.match(configToml, /model_provider = "rightcode"/);
    assert.match(configToml, /model = "gpt-5\.5"/);
    assert.match(configToml, /base_url = "https:\/\/right\.codes\/codex\/v1"/);

    const deleted = await deletePortalCredential(userId, credentialId);
    assert.equal(deleted.credential.id, credentialId);
    assert.equal(deleted.credential.removed, true);
    assert.deepEqual(deleted.credential.removedPaths, [
      `credentials/codex/${credentialId}/auth.json`,
      `credentials/codex/${credentialId}/config.toml`,
    ]);

    assert.equal(fs.existsSync(registryPath), false);
    assert.equal(fs.existsSync(authPath), false);
    assert.equal(fs.existsSync(configPath), false);
  } finally {
    fs.rmSync(registryPath, { force: true });
    fs.rmSync(authPath, { force: true });
    fs.rmSync(configPath, { force: true });
    fs.rmSync(path.dirname(authPath), { recursive: true, force: true });
  }
});

test("portal service lists, creates, and deletes user skill registry entries", async () => {
  const userId = uniqueName("portal-skill-user");
  const userRoot = path.join(USER_ROOT, userId);
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);

  try {
    await createUserCommand([userId, "--name", "Portal Skill User", "--email", `${userId}@polaris.local`]);

    const created = await createPortalSkill({
      userId,
      skillId: "use-polaris",
      harness: "codex",
      source: "vercel-labs/agent-skills",
      skillName: "use-polaris",
    });
    assert.equal(created.id, "use-polaris");
    assert.equal(created.packageName, "skills");
    assert.equal(created.source, "vercel-labs/agent-skills");
    assert.equal(created.selectedSkillName, "use-polaris");

    const listed = listUserPortalSkills(userId);
    assert.ok(listed.some((skill) => skill.id === "use-polaris"));

    const deleted = await deletePortalSkill(userId, "use-polaris");
    assert.equal(deleted.skill.id, "use-polaris");
    assert.equal(deleted.skill.removed, true);
    assert.equal(fs.existsSync(path.join(userRoot, "skills", "use-polaris.yaml")), false);
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("portal service exposes the credential catalog and creates a claude inventory credential", async () => {
  const userId = uniqueName("portal-claude-user");
  const userRoot = path.join(USER_ROOT, userId);
  const profilePath = path.join(
    REPO_ROOT,
    "config",
    "users",
    "profiles",
    `${userId}.yaml`,
  );

  try {
    await createUserCommand([
      userId,
      "--name",
      "Portal Claude User",
      "--email",
      `${userId}@polaris.local`,
    ]);

    const catalog = getPortalCredentialCatalog() as {
      harnesses: Array<{ id: string; supportsCreate: boolean; supportsLiveSwitch: boolean }>;
      presetsByHarness: Record<string, Array<{ id: string }>>;
    };
      assert.ok(catalog.harnesses.some((item) => item.id === "claude"));
      assert.ok(catalog.harnesses.some((item) => item.id === "ssh" && item.supportsLiveSwitch === true));
      assert.ok(catalog.harnesses.some((item) => item.id === "codex" && item.supportsLiveSwitch === true));
      assert.ok(catalog.harnesses.some((item) => item.id === "claude" && item.supportsLiveSwitch === true));
      assert.ok(catalog.harnesses.some((item) => item.id === "copilot" && item.supportsLiveSwitch === true));
      assert.ok(catalog.harnesses.some((item) => item.id === "opencode" && item.supportsLiveSwitch === true));
      assert.ok(catalog.harnesses.some((item) => item.id === "pi" && item.supportsLiveSwitch === true));
      assert.ok(catalog.presetsByHarness.codex?.some((item) => item.id === "rightcode"));
      assert.ok(catalog.presetsByHarness.claude?.some((item) => item.id === "anthropic"));
      assert.ok(
        catalog.presetsByHarness.copilot?.some(
          (item) => item.id === "github-copilot",
        ),
      );
      assert.ok(
        catalog.presetsByHarness.opencode?.some(
          (item) => item.id === "openrouter",
        ),
      );
      assert.ok(
        catalog.presetsByHarness.pi?.some(
          (item) => item.id === "openai-compatible",
        ),
      );

    const created = await createPortalCredential({
      userId,
      harness: "claude",
      credentialId: "claude-default",
      presetId: "anthropic",
      apiKey: "claude-secret",
    });
      assert.equal(created.id, "claude-default");
      assert.equal(created.harness, "claude");
      assert.equal(created.kind, "api-key");
      assert.equal(created.liveSwitchSupported, true);
      assert.deepEqual(created.paths, [
        "credentials/claude/claude-default/credential.json",
      ]);

      const materialPath = path.join(
        userRoot,
        "credentials",
        "claude",
        "claude-default",
        "credential.json",
      );
      assert.equal(fs.existsSync(materialPath), true);
      const material = JSON.parse(fs.readFileSync(materialPath, "utf8")) as {
        harness?: string;
        providerName?: string;
        baseUrl?: string;
        presetId?: string;
        apiKey?: string;
      };
      assert.equal(material.harness, "claude");
      assert.equal(material.providerName, "anthropic");
      assert.equal(material.baseUrl, "https://api.anthropic.com");
      assert.equal(material.presetId, "anthropic");
      assert.equal(material.apiKey, "claude-secret");

    const activated = await activatePortalCredential(userId, "claude-default");
    assert.equal(activated.id, "claude-default");
    assert.equal(activated.harness, "claude");
    assert.equal(activated.active, true);
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("portal profile reads and updates", async () => {
  const userId = "100000000000000001";
  const profileFilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const original = fs.readFileSync(profileFilePath, "utf8");
  const originalDoc = (yaml.load(original) ?? {}) as {
    email?: unknown;
    github?: { account?: unknown };
    name?: unknown;
    ssh?: { comment?: unknown };
  };

  try {
    const profile = readPortalProfile(userId);
    assert.equal(profile?.name, String(originalDoc.name ?? ""));
    assert.equal(profile?.email, String(originalDoc.email ?? ""));

    const updated = updatePortalProfile(userId, {
      name: "Demo User Updated",
      email: "demo@example.com",
      githubAccount: "demo-account",
      sshComment: "demo@example.com",
    });
    assert.equal(updated.name, "Demo User Updated");
    assert.equal(updated.githubAccount, "demo-account");
  } finally {
    fs.writeFileSync(profileFilePath, original, "utf8");
  }
});

test("portal vault detail loads for a user-scoped vault", async () => {
  const payload = await getPortalVaultDetail(DEMO_USER_ID, "demo");
  assert.equal(payload.name, "demo");
  assert.ok(Array.isArray(payload.availableDrivers));
  assert.ok(payload.availableDrivers.some((driver) => driver.backend === "docker"));
  assert.ok(Array.isArray(payload.credentialBindings));
});

test("portal vault detail does not leak bindings from another user with the same vault name", async () => {
  const vault = uniqueName("shared-name");
  const firstUserId = uniqueName("portal-scope-a");
  const secondUserId = uniqueName("portal-scope-b");
  const firstUserRoot = path.join(USER_ROOT, firstUserId);
  const secondUserRoot = path.join(USER_ROOT, secondUserId);
  const firstProfilePath = path.join(USER_ROOT, "profiles", `${firstUserId}.yaml`);
  const secondProfilePath = path.join(USER_ROOT, "profiles", `${secondUserId}.yaml`);

  try {
    await createUserCommand([firstUserId, "--name", "Scope A", "--email", `${firstUserId}@polaris.local`]);
    await createUserCommand([secondUserId, "--name", "Scope B", "--email", `${secondUserId}@polaris.local`]);
    await createCommand([vault, "--user", firstUserId]);

    const firstSpecPath = path.join(firstUserRoot, "vaults", vault, "docker.agent.yaml");
    const secondVaultRoot = path.join(secondUserRoot, "vaults", vault);
    const secondSpecPath = path.join(secondVaultRoot, "docker.agent.yaml");
    const firstSpec = (yaml.load(fs.readFileSync(firstSpecPath, "utf8")) ?? {}) as Record<string, unknown>;
    const firstCredentials = typeof firstSpec.credentials === "object" && firstSpec.credentials
      ? { ...(firstSpec.credentials as Record<string, unknown>) }
      : {};
    firstSpec.credentials = {
      ...firstCredentials,
      bindings: [
        { purpose: "agent-auth", credentialId: "scope-a-codex", required: true },
        { purpose: "git-auth", credentialId: "github-ssh", required: false },
      ],
    };
    firstSpec.agent = {
      ...(typeof firstSpec.agent === "object" && firstSpec.agent ? firstSpec.agent as Record<string, unknown> : {}),
      kind: "multi",
      persist_state: true,
    };
    fs.writeFileSync(firstSpecPath, yaml.dump(firstSpec, { lineWidth: 120, noRefs: true }), "utf8");

    fs.mkdirSync(secondVaultRoot, { recursive: true });
    const secondSpec = JSON.parse(JSON.stringify(firstSpec)) as Record<string, unknown>;
    secondSpec.user_profile = secondUserId;
    secondSpec.credentials = {
      bindings: [
        { purpose: "git-auth", credentialId: "github-ssh", required: false },
      ],
    };
    secondSpec.agent = {
      ...(typeof secondSpec.agent === "object" && secondSpec.agent ? secondSpec.agent as Record<string, unknown> : {}),
      kind: "disabled",
      persist_state: false,
    };
    fs.writeFileSync(secondSpecPath, yaml.dump(secondSpec, { lineWidth: 120, noRefs: true }), "utf8");

    const payload = await getPortalVaultDetail(secondUserId, vault);
    assert.deepEqual(payload.credentialBindings, [
      { purpose: "git-auth", credentialId: "github-ssh", required: false },
    ]);
  } finally {
    fs.rmSync(firstProfilePath, { force: true });
    fs.rmSync(secondProfilePath, { force: true });
    fs.rmSync(firstUserRoot, { recursive: true, force: true });
    fs.rmSync(secondUserRoot, { recursive: true, force: true });
  }
});

test("portal service can provision the same vault name for a different user", async () => {
  const vault = uniqueName("portal-shared-name");
  const firstUserId = uniqueName("portal-shared-a");
  const secondUserId = uniqueName("portal-shared-b");
  const firstUserRoot = path.join(USER_ROOT, firstUserId);
  const secondUserRoot = path.join(USER_ROOT, secondUserId);
  const firstProfilePath = path.join(USER_ROOT, "profiles", `${firstUserId}.yaml`);
  const secondProfilePath = path.join(USER_ROOT, "profiles", `${secondUserId}.yaml`);

  try {
    await createUserCommand([firstUserId, "--name", "Shared A", "--email", `${firstUserId}@polaris.local`]);
    await createUserCommand([secondUserId, "--name", "Shared B", "--email", `${secondUserId}@polaris.local`]);
    await createCommand([vault, "--user", firstUserId]);

    await withFakePath(
      {
        docker: "#!/bin/sh\nif [ \"$1\" = \"image\" ] && [ \"$2\" = \"inspect\" ]; then exit 0; fi\nif [ \"$1\" = \"pull\" ]; then exit 0; fi\nexit 0\n",
      },
      async () => {
        await queueProvisionVault(secondUserId, vault, {
          defaultDockerOnly: true,
          startAfterCreate: false,
        });
        const finalStatus = await waitForVaultStatusFile(secondUserId, vault);
        assert.notEqual(finalStatus.driver?.status, "running");
        assert.equal(
          fs.existsSync(path.join(secondUserRoot, "vaults", vault, "docker.agent.yaml")),
          true,
        );
      },
    );
  } finally {
    clearVaultProvisionProgress(secondUserId, vault);
    fs.rmSync(firstProfilePath, { force: true });
    fs.rmSync(secondProfilePath, { force: true });
    fs.rmSync(firstUserRoot, { recursive: true, force: true });
    fs.rmSync(secondUserRoot, { recursive: true, force: true });
  }
});

test("portal vault asset preview reads vault files", async () => {
  const previewPath = repoRelative(
    path.join(USER_ROOT, DEMO_USER_ID, "vaults", "demo", "docker.agent.yaml"),
  );
  const payload = readUserPortalVaultAssetPreview(
    DEMO_USER_ID,
    "demo",
    previewPath,
  );
  assert.equal(payload.path, previewPath);
  assert.match(payload.content, /backend:/);
  assert.equal(payload.truncated, false);
});








test("portal service provisions a new vault through the CLI-backed scaffold flow", async () => {
  const userId = uniqueName("portal-vault-user");
  const vault = uniqueName("portal-create");
  const vaultRoot = path.join(USER_ROOT, userId, "vaults", vault);
  const profileFile = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);
  const codexAuth = path.join(userRoot, "credentials", "codex", "auth.json");
  const codexConfig = path.join(userRoot, "credentials", "codex", "config.toml");
  const claudeSettings = path.join(userRoot, "credentials", "claude", "settings.json");
  const privateKey = path.join(userRoot, "credentials", "ssh", "id_ed25519");
  const publicKey = path.join(userRoot, "credentials", "ssh", "id_ed25519.pub");
  try {
    await createUserCommand([userId, "--name", "Portal Vault User", "--email", `${userId}@polaris.local`]);
    fs.mkdirSync(path.dirname(codexAuth), { recursive: true });
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.mkdirSync(path.dirname(privateKey), { recursive: true });
    fs.writeFileSync(codexAuth, "{}\n", "utf8");
    fs.writeFileSync(codexConfig, "model = 'gpt-5'\n", "utf8");
    fs.writeFileSync(claudeSettings, "{}\n", "utf8");
    fs.writeFileSync(privateKey, "dummy-private-key\n", "utf8");
    fs.writeFileSync(
      publicKey,
      `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey ${userId}@polaris.local\n`,
      "utf8",
    );
    writeVaultProvisionProgress(userId, vault, {
      userId,
      vault,
      phase: "error",
      step: 6,
      totalSteps: 7,
      percent: 86,
      message: "stale failure",
      updatedAt: new Date().toISOString(),
      done: true,
      error: "stale failure",
    });

    await withFakePath(
      {
        docker: "#!/bin/sh\nif [ \"$1\" = \"image\" ] && [ \"$2\" = \"inspect\" ]; then exit 0; fi\nif [ \"$1\" = \"pull\" ]; then exit 0; fi\nexit 0\n",
      },
      async () => {
        const payload = await queueProvisionVault(userId, vault);
        assert.equal(payload.vault, vault);
        assert.equal(payload.queued, true);
        const finalStatus = await waitForVaultStatusFile(userId, vault);
        assert.notEqual(finalStatus.driver?.status, "running");
      },
    );

    const vaultStatusPath = path.join(vaultRoot, "state", "status.json");
    assert.equal(fs.existsSync(vaultStatusPath), true);
    const finalStatus = JSON.parse(fs.readFileSync(vaultStatusPath, "utf8")) as {
      runtime?: { lifecycle?: string };
    };
    assert.notEqual(finalStatus.runtime?.lifecycle, "running");

    assert.equal(fs.existsSync(path.join(vaultRoot, "docker.agent.yaml")), true);
    assert.equal(fs.existsSync(path.join(vaultRoot, "pod.agent.yaml")), true);
    assert.equal(fs.existsSync(path.join(vaultRoot, "kubevirt.agent.yaml")), true);

    assert.ok((await listPortalVaults(userId)).some((entry) => entry.name === vault));
  } finally {
    fs.rmSync(vaultRoot, { recursive: true, force: true });
    clearVaultProvisionProgress(userId, vault);
    fs.rmSync(codexAuth, { force: true });
    fs.rmSync(codexConfig, { force: true });
    fs.rmSync(claudeSettings, { force: true });
    fs.rmSync(privateKey, { force: true });
    fs.rmSync(publicKey, { force: true });
    fs.rmSync(profileFile, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("portal service can cancel a queued or running vault provision job", async () => {
  const userId = uniqueName("portal-cancel-user");
  const vault = uniqueName("portal-cancel");
  const vaultRoot = path.join(USER_ROOT, userId, "vaults", vault);
  const profileFile = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);
  const codexAuth = path.join(userRoot, "credentials", "codex", "auth.json");
  const codexConfig = path.join(userRoot, "credentials", "codex", "config.toml");
  const claudeSettings = path.join(userRoot, "credentials", "claude", "settings.json");
  const privateKey = path.join(userRoot, "credentials", "ssh", "id_ed25519");
  const publicKey = path.join(userRoot, "credentials", "ssh", "id_ed25519.pub");

  try {
    await createUserCommand([userId, "--name", "Portal Cancel User", "--email", `${userId}@polaris.local`]);
    fs.mkdirSync(path.dirname(codexAuth), { recursive: true });
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.mkdirSync(path.dirname(privateKey), { recursive: true });
    fs.writeFileSync(codexAuth, "{}\n", "utf8");
    fs.writeFileSync(codexConfig, "model = 'gpt-5'\n", "utf8");
    fs.writeFileSync(claudeSettings, "{}\n", "utf8");
    fs.writeFileSync(privateKey, "dummy-private-key\n", "utf8");
    fs.writeFileSync(
      publicKey,
      `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey ${userId}@polaris.local\n`,
      "utf8",
    );

    await withEnv("POLARIS_TEST_PROVISION_STEP_DELAY_MS", "250", async () => {
      await withFakePath(
        {
          docker: "#!/bin/sh\nif [ \"$1\" = \"image\" ] && [ \"$2\" = \"inspect\" ]; then exit 0; fi\nif [ \"$1\" = \"pull\" ]; then exit 0; fi\nexit 0\n",
        },
        async () => {
          await queueProvisionVault(userId, vault);
          await new Promise((resolve) => setTimeout(resolve, 25));
          await cancelPortalVaultProvision(userId, vault);

          const finalProgress = await waitFor(() => {
            const progress = readVaultProvisionProgress(userId, vault);
            return progress?.done ? progress : null;
          }, { timeoutMs: 10000 });
          assert.equal(finalProgress.status, "cancelled");
          assert.equal(finalProgress.phase, "cancelled");
          assert.equal(finalProgress.errorCode, "vault-provision-cancelled");
          assert.equal(finalProgress.retryable, true);
          await new Promise((resolve) => setTimeout(resolve, 300));
          assert.equal(readVaultProvisionProgress(userId, vault)?.status, "cancelled");
        },
      );
    });
  } finally {
    fs.rmSync(vaultRoot, { recursive: true, force: true });
    clearVaultProvisionProgress(userId, vault);
    fs.rmSync(codexAuth, { force: true });
    fs.rmSync(codexConfig, { force: true });
    fs.rmSync(claudeSettings, { force: true });
    fs.rmSync(privateKey, { force: true });
    fs.rmSync(publicKey, { force: true });
    fs.rmSync(profileFile, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("portal cancellation does not overwrite a completed provision state", async () => {
  const userId = uniqueName("portal-cancel-complete-user");
  const vault = uniqueName("portal-cancel-complete");
  const userRoot = path.join(USER_ROOT, userId);

  try {
    writeVaultProvisionProgress(userId, vault, {
      userId,
      vault,
      phase: "complete",
      status: "succeeded",
      message: "vault provision complete",
      done: true,
      updatedAt: new Date().toISOString(),
    });

    await assert.rejects(
      () => cancelPortalVaultProvision(userId, vault),
      /pending provision job/u,
    );
    assert.equal(readVaultProvisionProgress(userId, vault)?.status, "succeeded");
  } finally {
    clearVaultProvisionProgress(userId, vault);
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("durable provisioning abandons a deleted tenant without recreating its root", async () => {
  const userId = uniqueName("portal-deleted-provision-user");
  const vault = uniqueName("portal-deleted-provision-vault");
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-deleted-provision-"));
  const controlPath = path.join(controlRoot, "control.sqlite");

  await withEnv("POLARIS_CONTROL_STORE_PATH", controlPath, async () => {
    closePolarisControlStore();
    try {
      const store = getPolarisControlStore(import.meta.url);
      const job = store.enqueueJob({
        kind: "vault-provision",
        dedupeKey: `vault-provision:${userId}:${vault}`,
        tenantId: userId,
        vaultId: vault,
      });

      await resumeDurableVaultJobs();

      assert.equal(store.getJob(job.id)?.status, "failed");
      assert.equal(store.getJob(job.id)?.errorCode, "tenant-not-found");
      assert.equal(fs.existsSync(path.join(USER_ROOT, userId)), false);
    } finally {
      closePolarisControlStore();
      fs.rmSync(controlRoot, { recursive: true, force: true });
    }
  });
});

test("vault deletion refuses a queued durable job before removing its root", async () => {
  const userId = uniqueName("portal-delete-pending-user");
  const vault = uniqueName("portal-delete-pending-vault");
  const userRoot = path.join(USER_ROOT, userId);
  const vaultRoot = path.join(userRoot, "vaults", vault);
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-delete-pending-"));
  const controlPath = path.join(controlRoot, "control.sqlite");
  fs.mkdirSync(vaultRoot, { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, "marker"), "synthetic\n", "utf8");

  await withEnv("POLARIS_CONTROL_STORE_PATH", controlPath, async () => {
    closePolarisControlStore();
    try {
      getPolarisControlStore(import.meta.url).enqueueJob({
        kind: "vault-provision",
        dedupeKey: `vault-provision:${userId}:${vault}`,
        tenantId: userId,
        vaultId: vault,
      });

      await assert.rejects(
        () => deleteVaultOwnedByUser(userId, vault),
        /durable jobs are queued or running/u,
      );
      assert.equal(fs.existsSync(path.join(vaultRoot, "marker")), true);
    } finally {
      closePolarisControlStore();
    }
  });

  fs.rmSync(userRoot, { recursive: true, force: true });
  fs.rmSync(controlRoot, { recursive: true, force: true });
});

test("portal service stops the selected vault driver", async () => {
  const userId = uniqueName("portal-stop-user");
  const vault = uniqueName("portal-stop");
  const userRoot = path.join(USER_ROOT, userId);
  const vaultRoot = path.join(userRoot, "vaults", vault);
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const codexAuth = path.join(userRoot, "credentials", "codex", "auth.json");
  const codexConfig = path.join(userRoot, "credentials", "codex", "config.toml");
  const claudeSettings = path.join(userRoot, "credentials", "claude", "settings.json");
  const privateKey = path.join(userRoot, "credentials", "ssh", "id_ed25519");
  const publicKey = path.join(userRoot, "credentials", "ssh", "id_ed25519.pub");

  try {
    await createUserCommand([userId, "--name", "Portal Stop User", "--email", `${userId}@polaris.local`]);
    await createCommand([vault, "--user", userId]);
    fs.mkdirSync(path.dirname(codexAuth), { recursive: true });
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.mkdirSync(path.dirname(privateKey), { recursive: true });
    fs.writeFileSync(codexAuth, "{}\n", "utf8");
    fs.writeFileSync(codexConfig, "model = 'gpt-5'\n", "utf8");
    fs.writeFileSync(claudeSettings, "{}\n", "utf8");
    fs.writeFileSync(privateKey, "dummy-private-key\n", "utf8");
    fs.writeFileSync(
      publicKey,
      `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey ${userId}@polaris.local\n`,
      "utf8",
    );
    writeVaultDriverSelection(vault, { backend: "docker" }, userId);
    writeVaultStatus({
      project: vault,
      runtime: {
        selectedDriver: { backend: "docker" },
        lifecycle: "running",
      },
      paseo: {
        daemon: "ready",
        web: "connectable",
        reconnectMode: "reconnectable",
        liveTarget: "https://app.paseo.test/#offer=portal-stop",
        reconnectTarget: "https://app.paseo.test/h/srv_portal_stop?scope=test",
      },
      details: {},
    }, userId);

    await withFakePath(
      {
        docker: `
if [[ "$1" == "compose" && "$4" == "stop" ]]; then
  exit 0
fi
if [[ "$1" == "compose" && "$4" == "ps" ]]; then
  printf 'portal-stop-id'
  exit 0
fi
if [[ "$1" == "inspect" && "$2" == "portal-stop-id" ]]; then
  printf '[{"State":{"Running":false}}]'
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  exit 0
fi
exit 0
`,
      },
      async ({ readCommandLog }) => {
        const payload = await stopPortalVault(userId, vault);
        assert.equal(payload.stopped, true);
        await waitForCommandLogMatch(
          readCommandLog,
          (entry) => entry.includes("compose") && entry.includes("stop"),
        );
        await waitForCommandLogMatch(
          readCommandLog,
          (entry) => entry.includes("compose") && entry.includes("ps"),
        );
        await waitForCommandLogMatch(
          readCommandLog,
          (entry) => entry.includes("inspect portal-stop-id"),
        );
        const commandLog = readCommandLog();
        assert.ok(commandLog.some((entry) => entry.includes("compose") && entry.includes("stop")));
        assert.ok(commandLog.some((entry) => entry.includes("compose") && entry.includes("ps")));
        assert.ok(commandLog.some((entry) => entry.includes("inspect portal-stop-id")));
      },
    );
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
    fs.rmSync(privateKey, { force: true });
    fs.rmSync(publicKey, { force: true });
  }
});

test("portal service can create and start a new vault in one flow", async () => {
  const userId = uniqueName("portal-start-user");
  const vault = uniqueName("portal-start");
  const vaultRoot = path.join(USER_ROOT, userId, "vaults", vault);
  const profileFile = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);

  try {
    await createUserCommand([userId, "--name", "Portal Start User", "--email", `${userId}@polaris.local`]);

    await withFakePath(
      {
        docker: `
if [[ "$1" == "image" && "$2" == "inspect" ]]; then exit 0; fi
if [[ "$1" == "pull" ]]; then exit 0; fi
if [[ "$1" == "volume" && "$2" == "inspect" ]]; then exit 1; fi
if [[ "$1" == "compose" && "$4" == "ps" ]]; then printf 'docker-started-id'; exit 0; fi
if [[ "$1" == "inspect" && "$2" == "docker-started-id" ]]; then printf '[{"State":{"Running":true}}]'; exit 0; fi
if [[ "$1" == "exec" ]]; then
  if [[ "$5" == *"cat /root/.paseo/server-id"* ]]; then
    printf 'srv_portal_start'
    exit 0
  fi
  if [[ "$5" == *"cat /root/.paseo/pairing.json"* ]]; then
    printf '{"url":"https://app.paseo.test/#offer=eyJzZXJ2ZXJJZCI6InNydl9wb3J0YWxfc3RhcnQifQ","serverId":"srv_portal_start"}'
    exit 0
  fi
  exit 0
fi
exit 0
`,
      },
      async ({ readCommandLog }) => {
        await queueProvisionVault(userId, vault, {
          defaultDockerOnly: true,
          startAfterCreate: true,
        });
        const finalStatus = await waitFor(() => {
          const status = readVaultStatus(userId, vault);
          return status?.driver?.status === "running" ? status : null;
        });
        assert.equal(finalStatus.driver?.selected?.backend, "docker");
        assert.ok(["pending", "ready"].includes(finalStatus.paseo.daemon));
        assert.ok(
          readCommandLog().some((entry) => entry.includes("compose") && entry.includes("up") && entry.includes("-d")),
        );
        assert.ok(
          readCommandLog().some((entry) => entry.includes("cat /root/.paseo/server-id")),
        );
        assert.ok(
          readCommandLog().some((entry) => entry.includes("cat /root/.paseo/pairing.json")),
        );
      },
    );
  } finally {
    await cleanupVaultRuntime(userId, vault);
    clearVaultProvisionProgress(userId, vault);
    fs.rmSync(profileFile, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("portal service starts the selected vault driver", async () => {
  const userId = uniqueName("portal-explicit-start-user");
  const vault = uniqueName("portal-explicit-start");
  const userRoot = path.join(USER_ROOT, userId);
  const vaultRoot = path.join(userRoot, "vaults", vault);
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const codexAuth = path.join(userRoot, "credentials", "codex", "auth.json");
  const codexConfig = path.join(userRoot, "credentials", "codex", "config.toml");
  const claudeSettings = path.join(userRoot, "credentials", "claude", "settings.json");
  const privateKey = path.join(userRoot, "credentials", "ssh", "id_ed25519");
  const publicKey = path.join(userRoot, "credentials", "ssh", "id_ed25519.pub");

  try {
    await createUserCommand([userId, "--name", "Portal Explicit Start User", "--email", `${userId}@polaris.local`]);
    await createCommand([vault, "--user", userId]);
    fs.mkdirSync(path.dirname(codexAuth), { recursive: true });
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.mkdirSync(path.dirname(privateKey), { recursive: true });
    fs.writeFileSync(codexAuth, "{}\n", "utf8");
    fs.writeFileSync(codexConfig, "model = 'gpt-5'\n", "utf8");
    fs.writeFileSync(claudeSettings, "{}\n", "utf8");
    fs.writeFileSync(privateKey, "dummy-private-key\n", "utf8");
    fs.writeFileSync(
      publicKey,
      `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey ${userId}@polaris.local\n`,
      "utf8",
    );
    writeVaultDriverSelection(vault, { backend: "docker" }, userId);
    writeVaultStatus({
      project: vault,
      runtime: {
        selectedDriver: { backend: "docker" },
        lifecycle: "stopped",
        reason: "vault is stopped",
      },
      paseo: {
        daemon: "absent",
        web: "unavailable",
        reconnectMode: "unknown",
        liveTarget: null,
        reconnectTarget: null,
      },
      details: {},
    }, userId);

    await withFakePath(
      {
        docker: `
if [[ "$1" == "compose" && "$4" == "up" ]]; then
  exit 0
fi
if [[ "$1" == "compose" && "$4" == "ps" ]]; then
  printf 'portal-start-id'
  exit 0
fi
if [[ "$1" == "inspect" && "$2" == "portal-start-id" ]]; then
  printf '[{"State":{"Running":true}}]'
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  if [[ "$5" == *"cat /root/.paseo/server-id"* ]]; then
    printf 'srv_portal_explicit_start'
    exit 0
  fi
  if [[ "$5" == *"cat /root/.paseo/pairing.json"* ]]; then
    printf '{"url":"https://app.paseo.test/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl9wb3J0YWxfZXhwbGljaXRfc3RhcnQifQ","serverId":"srv_portal_explicit_start"}'
    exit 0
  fi
  exit 0
fi
exit 0
`,
      },
      async ({ readCommandLog }) => {
        const payload = await startPortalVault(userId, vault);
        assert.equal(payload.started, true);
        const commandLog = readCommandLog();
        assert.ok(commandLog.some((entry) => entry.includes("compose") && entry.includes("up") && entry.includes("-d")));
        assert.ok(commandLog.some((entry) => entry.includes("cat /root/.paseo/server-id")));
        assert.ok(commandLog.some((entry) => entry.includes("cat /root/.paseo/pairing.json")));
      },
    );
  } finally {
    await cleanupVaultRuntime(userId, vault);
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
    fs.rmSync(privateKey, { force: true });
    fs.rmSync(publicKey, { force: true });
  }
});

test("portal service binds and unbinds paseo agent credentials on the selected vault driver", async () => {
  const userId = uniqueName("portal-paseo-bind-user");
  const vault = uniqueName("portal-paseo-bind");
  const userRoot = path.join(USER_ROOT, userId);
  const vaultRoot = path.join(userRoot, "vaults", vault);
  const profileFile = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const dockerSpecPath = path.join(vaultRoot, "docker.agent.yaml");
  const credentialId = uniqueName("portal-codex");

  try {
    await createUserCommand([userId, "--name", "Portal Paseo Bind User", "--email", `${userId}@polaris.local`]);

    await withFakePath(
      {
        docker: `
if [[ "$1" == "image" && "$2" == "inspect" ]]; then exit 0; fi
if [[ "$1" == "pull" ]]; then exit 0; fi
if [[ "$1" == "volume" && "$2" == "inspect" ]]; then exit 1; fi
if [[ "$1" == "compose" && "$4" == "ps" ]]; then printf 'docker-bind-id'; exit 0; fi
if [[ "$1" == "inspect" && "$2" == "docker-bind-id" ]]; then printf '[{"State":{"Running":true}}]'; exit 0; fi
if [[ "$1" == "exec" ]]; then
  if [[ "$5" == *"paseo daemon status --json"* ]]; then
    printf '{"serverId":"srv_test","localDaemon":"running","connectedDaemon":"reachable"}'
    exit 0
  fi
  if [[ "$5" == *"paseo daemon pair --json"* ]]; then
    printf '{"url":"https://app.paseo.test/#offer=eyJzZXJ2ZXJJZCI6InNydl90ZXN0In0"}'
    exit 0
  fi
  if [[ "$5" == *"/server-id"* ]]; then
    printf 'srv_test'
    exit 0
  fi
  if [[ "$5" == *"/pairing.json"* ]]; then
    printf '{"url":"https://app.paseo.test/#offer=eyJzZXJ2ZXJJZCI6InNydl90ZXN0In0"}'
    exit 0
  fi
  exit 0
fi
exit 0
`,
      },
      async () => {
        await queueProvisionVault(userId, vault, {
          defaultDockerOnly: true,
          startAfterCreate: true,
        });
        const finalStatus = await waitFor(() => {
          const status = readVaultStatus(userId, vault);
          return status?.driver?.status === "running" ? status : null;
        });
        assert.equal(finalStatus.driver?.status, "running");

        await createPortalCredential({
          userId,
          harness: "codex",
          credentialId,
          label: "Portal Bind Credential",
          providerName: "test-provider",
          baseUrl: "https://example.invalid/codex/v1",
          apiKey: "test-api-key",
        });

        const bindPayload = await bindPortalVaultAgent({
          userId,
          vault,
          driver: { backend: "docker" },
          credentialId,
        });
          assert.equal(bindPayload.enabled, true);
          assert.equal(bindPayload.restarted, true);
          assert.deepEqual(bindPayload.credentialBindings, [
            { purpose: "agent-auth", credentialId, required: true },
            { purpose: "git-auth", credentialId: "github-ssh", required: false },
          ]);

          const boundSpec = (yaml.load(fs.readFileSync(dockerSpecPath, "utf8")) ?? {}) as {
            agent?: { kind?: string; persist_state?: boolean };
            credentials?: { bindings?: Array<{ purpose?: string; credentialId?: string; required?: boolean }> };
          };
          assert.deepEqual(boundSpec.credentials?.bindings, [
            { purpose: "agent-auth", credentialId, required: true },
            { purpose: "git-auth", credentialId: "github-ssh", required: false },
          ]);

        const unbindPayload = await unbindPortalVaultAgent({
          userId,
          vault,
          driver: { backend: "docker" },
        });
          assert.equal(unbindPayload.enabled, false);
          assert.equal(unbindPayload.restarted, true);
          assert.deepEqual(unbindPayload.credentialBindings, [
            { purpose: "git-auth", credentialId: "github-ssh", required: false },
          ]);

          const unboundSpec = (yaml.load(fs.readFileSync(dockerSpecPath, "utf8")) ?? {}) as {
            agent?: { kind?: string; persist_state?: boolean };
            credentials?: { bindings?: Array<{ purpose?: string; credentialId?: string; required?: boolean }> };
          };
          assert.deepEqual(unboundSpec.credentials?.bindings, [
            { purpose: "git-auth", credentialId: "github-ssh", required: false },
          ]);
      },
    );
  } finally {
    await cleanupVaultRuntime(userId, vault);
    clearVaultProvisionProgress(userId, vault);
    fs.rmSync(profileFile, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("portal service switches the live codex credential without mutating vault bindings", async () => {
  const userId = uniqueName("portal-live-switch-user");
  const vault = uniqueName("portal-live-switch");
  const userRoot = path.join(USER_ROOT, userId);
  const vaultRoot = path.join(userRoot, "vaults", vault);
  const profileFile = path.join(
    REPO_ROOT,
    "config",
    "users",
    "profiles",
    `${userId}.yaml`,
  );
  const liveStatePath = path.join(vaultRoot, "state", "live-credentials.json");

  try {
    await createUserCommand([
      userId,
      "--name",
      "Portal Live Switch User",
      "--email",
      `${userId}@polaris.local`,
    ]);

    await withFakePath(
      {
        docker: `
if [[ "$1" == "image" && "$2" == "inspect" ]]; then exit 0; fi
if [[ "$1" == "pull" ]]; then exit 0; fi
if [[ "$1" == "volume" && "$2" == "inspect" ]]; then exit 1; fi
if [[ "$1" == "compose" && "$4" == "ps" ]]; then printf 'docker-live-switch'; exit 0; fi
if [[ "$1" == "inspect" && "$2" == "docker-live-switch" ]]; then printf '[{"State":{"Running":true}}]'; exit 0; fi
if [[ "$1" == "exec" ]]; then
  if [[ "$3" == "sh" && "$4" == "-lc" ]]; then
    printf '%s\n' "$5" >> ${JSON.stringify(path.join(os.tmpdir(), "portal-live-switch-script.log"))}
    if [[ "$5" == *"paseo daemon status --json"* ]]; then
      printf '{"serverId":"srv_test","localDaemon":"running","connectedDaemon":"reachable"}'
      exit 0
    fi
    if [[ "$5" == *"paseo daemon pair --json"* ]]; then
      printf '{"url":"https://app.paseo.test/#offer=eyJzZXJ2ZXJJZCI6InNydl90ZXN0In0"}'
      exit 0
    fi
    if [[ "$5" == *"/server-id"* ]]; then
      printf 'srv_test'
      exit 0
    fi
    if [[ "$5" == *"/pairing.json"* ]]; then
      printf '{"url":"https://app.paseo.test/#offer=eyJzZXJ2ZXJJZCI6InNydl90ZXN0In0","serverId":"srv_test"}'
      exit 0
    fi
    exit 0
  fi
fi
exit 0
`,
      },
      async ({ readCommandLog }) => {
        const scriptLogPath = path.join(os.tmpdir(), "portal-live-switch-script.log");
        fs.rmSync(scriptLogPath, { force: true });

        await queueProvisionVault(userId, vault, {
          defaultDockerOnly: true,
          startAfterCreate: true,
        });
        const finalStatus = await waitFor(() => {
          const status = readVaultStatus(userId, vault);
          return status?.driver?.status === "running" ? status : null;
        });
        assert.equal(finalStatus.driver?.status, "running");

        await createPortalCredential({
          userId,
          harness: "codex",
          credentialId: "codex-live",
          label: "Live Switch",
          providerName: "rightcode",
          baseUrl: "https://right.codes/codex/v1",
          apiKey: "test-api-key",
        });

        await createPortalCredential({
          userId,
          harness: "claude",
          credentialId: "claude-live",
          label: "Claude Live",
          providerName: "anthropic",
          apiKey: "claude-api-key",
        });

        const payload = await switchPortalVaultLiveCredential({
          userId,
          vault,
          harness: "codex",
          credentialId: "codex-live",
        });
          assert.equal(payload.switched, true);
          assert.equal(payload.harness, "codex");
          assert.equal(payload.credential.id, "codex-live");

        const claudePayload = await switchPortalVaultLiveCredential({
          userId,
          vault,
          harness: "claude",
          credentialId: "claude-live",
        });
          assert.equal(claudePayload.switched, true);
          assert.equal(claudePayload.harness, "claude");
          assert.equal(claudePayload.credential.id, "claude-live");

        const liveState = JSON.parse(fs.readFileSync(liveStatePath, "utf8")) as {
          codex?: { credentialId?: string };
          claude?: { credentialId?: string };
        };
        assert.equal(liveState.codex?.credentialId, "codex-live");
        assert.equal(liveState.claude?.credentialId, "claude-live");
        assert.equal(
          fs.readFileSync(path.join(vaultRoot, "docker.agent.yaml"), "utf8").includes("codex-live"),
          false,
        );
        const commandLog = readCommandLog();
        assert.ok(
          commandLog.some((line) => line.includes("exec docker-live-switch sh -lc")),
        );
        assert.match(
          fs.readFileSync(scriptLogPath, "utf8"),
          /\/identity\/codex\/auth\.json/,
        );
        assert.match(
          fs.readFileSync(scriptLogPath, "utf8"),
          /\/identity\/claude\/credential\.json/,
        );
      },
    );
  } finally {
    await cleanupVaultRuntime(userId, vault);
    fs.rmSync(profileFile, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
    clearVaultProvisionProgress(userId, vault);
  }
});

test("portal service switches the same vault name for a different user", async () => {
  const firstUserId = uniqueName("portal-switch-scope-a");
  const secondUserId = uniqueName("portal-switch-scope-b");
  const vault = uniqueName("portal-switch-shared");

  try {
    await createUserCommand([
      firstUserId,
      "--name",
      "Switch Scope A",
      "--email",
      `${firstUserId}@polaris.local`,
    ]);
    await createUserCommand([
      secondUserId,
      "--name",
      "Switch Scope B",
      "--email",
      `${secondUserId}@polaris.local`,
    ]);
    await createCommand([vault, "--user", firstUserId]);
    await createCommand([vault, "--user", secondUserId]);
    writeVaultDriverSelection(vault, { backend: "docker" }, firstUserId);
    writeVaultDriverSelection(vault, { backend: "docker" }, secondUserId);

    await withFakePath(
      {
        docker: `
if [[ "$1" == "compose" && "$4" == "ps" ]]; then exit 0; fi
if [[ "$1" == "exec" ]]; then exit 0; fi
if [[ "$1" == "cp" ]]; then exit 0; fi
if [[ "$1" == "volume" ]]; then exit 0; fi
if [[ "$1" == "run" ]]; then exit 0; fi
if [[ "$1" == "inspect" ]]; then printf '[{"State":{"Running":false}}]'; exit 0; fi
exit 0
`,
        kubectl: `
if [[ "$1" == "apply" ]]; then exit 0; fi
if [[ "$1" == "-n" && "$3" == "get" && "$4" == "deployment" ]]; then printf '{"metadata":{"name":"%s"}}' "$2"; exit 0; fi
if [[ "$1" == "-n" && "$3" == "get" && "$4" == "pod" ]]; then printf '%s-pod' "$2"; exit 0; fi
if [[ "$1" == "-n" && "$3" == "get" && "$4" == "svc" ]]; then printf '%s' "$2"; exit 0; fi
if [[ "$1" == "-n" && "$3" == "exec" ]]; then
  command="\${@:8}"
  if [[ "$command" == *"paseo daemon status --json"* ]]; then
    printf '{"serverId":"srv_test","localDaemon":"running","connectedDaemon":"reachable"}'
    exit 0
  fi
  if [[ "$command" == *"paseo daemon pair --json"* ]]; then
    printf '{"url":"https://app.paseo.test/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl90ZXN0In0"}'
    exit 0
  fi
  if [[ "$command" == *"/server-id"* ]]; then
    printf 'srv_test'
    exit 0
  fi
  if [[ "$command" == *"/pairing.json"* ]]; then
    printf '{"url":"https://app.paseo.test/#offer=eyJ2IjoyLCJzZXJ2ZXJJZCI6InNydl90ZXN0In0","serverId":"srv_test"}'
    exit 0
  fi
  exit 0
fi
if [[ "$1" == "-n" && "$3" == "logs" ]]; then exit 0; fi
if [[ "$1" == "-n" && "$3" == "delete" ]]; then exit 0; fi
if [[ "$1" == "-n" && "$3" == "rollout" ]]; then exit 0; fi
exit 0
`,
      },
      async () => {
        const result = await switchPortalVault(
          secondUserId,
          vault,
          { backend: "pod", profile: "gvisor" },
        );
        assert.equal(result.project, vault);
        assert.equal(result.selectedBackend, "pod");
        assert.equal(result.selectedProfile, "gvisor");
        assert.deepEqual(
          readVaultStatus(secondUserId, vault)?.driver?.selected,
          { backend: "pod", profile: "gvisor" },
        );
        assert.deepEqual(
          readVaultStatus(firstUserId, vault)?.driver?.selected,
          { backend: "docker" },
        );
      },
    );
  } finally {
    fs.rmSync(path.join(USER_ROOT, firstUserId), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(USER_ROOT, secondUserId), {
      recursive: true,
      force: true,
    });
    fs.rmSync(
      path.join(USER_ROOT, "profiles", `${firstUserId}.yaml`),
      { force: true },
    );
    fs.rmSync(
      path.join(USER_ROOT, "profiles", `${secondUserId}.yaml`),
      { force: true },
    );
  }
});

test("portal service deletes a stopped vault and removes it from the active profile index", async () => {
  const userId = DEMO_USER_ID;
  const vault = uniqueName("portal-delete");
  const vaultRoot = path.join(USER_ROOT, userId, "vaults", vault);
  const portalStateRoot = path.join(vaultRoot, ".portal");
  const profileFile = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const originalProfile = fs.readFileSync(profileFile, "utf8");

  fs.mkdirSync(vaultRoot, { recursive: true });
  fs.mkdirSync(portalStateRoot, { recursive: true });
  fs.writeFileSync(
    path.join(portalStateRoot, "provision.json"),
    JSON.stringify({
      userId,
      vault,
      phase: "error",
      step: 6,
      totalSteps: 7,
      percent: 86,
      message: "stale failure",
      updatedAt: new Date().toISOString(),
      done: true,
      error: "stale failure",
    }, null, 2) + "\n",
    "utf8",
  );

  try {
    const payload = await deletePortalVault(userId, vault);
    assert.equal(payload.deleted, true);
    assert.equal(payload.vault, vault);

    assert.equal(fs.existsSync(vaultRoot), false);
    assert.equal(fs.existsSync(portalStateRoot), false);
  } finally {
    fs.rmSync(vaultRoot, { recursive: true, force: true });
    fs.rmSync(portalStateRoot, { recursive: true, force: true });
    fs.writeFileSync(profileFile, originalProfile, "utf8");
  }
});

test("portal service refreshes the real status when delete fails for a running vault", async () => {
  const userId = uniqueName("portal-archive-running-user");
  const vault = uniqueName("portal-archive-running");
  try {
    await withEnv(
      "POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY_SCRIPT",
      "node -e \"console.log(JSON.stringify({ apiKey: 'test-default-rightcode-key' }))\" --",
      async () => {
        await createUserCommand([
          userId,
          "--name",
          "Portal Archive Running User",
          "--email",
          `${userId}@polaris.local`,
        ]);
      },
    );
    await createCommand([vault, "--user", userId]);
    writeVaultDriverSelection(vault, { backend: "docker" }, userId);
    writeVaultStatus({
      project: vault,
      driver: {
        backend: "docker",
        baseImage: "ttl.sh/example:24h",
        runtimeKind: "docker-container",
        runtimeRef: `container/${vaultRuntimeScopeName(userId, vault)}-docker`,
      },
      operation: {
        kind: "delete",
        updatedAt: new Date().toISOString(),
      },
      runtime: {
        selectedDriver: { backend: "docker" },
        lifecycle: "running",
        reason: "stale delete status",
      },
      paseo: {
        daemon: "pending",
        web: "pairing-required",
        reconnectMode: "needs-pairing",
        liveTarget: "https://app.paseo.test/#offer=stale",
        reconnectTarget: "https://app.paseo.test/#offer=stale",
      },
      details: {},
    }, userId);

    await withFakePath(
      {
        docker: `#!/bin/sh
if [ "$1" = "compose" ] && [ "$4" = "ps" ]; then
  printf '%s\n' '{"Name":"${vaultRuntimeScopeName(userId, vault)}-docker","State":"running"}'
  exit 0
fi
if [ "$1" = "inspect" ]; then
  printf '%s\n' '{"State":{"Running":true}}'
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  exit 0
fi
exit 0
`,
        kubectl: "#!/bin/sh\nexit 0\n",
      },
      async () => {
        await assert.rejects(
          deletePortalVault(userId, vault),
          /Stop it before deleting/,
        );
      },
    );

    const nextStatus = readVaultStatus(userId, vault);
    assert.equal(nextStatus?.driver?.status, "running");
    assert.notEqual(nextStatus?.driver?.reason, "stale delete status");
  } finally {
    fs.rmSync(path.join(USER_ROOT, userId), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(USER_ROOT, "profiles", `${userId}.yaml`), {
      force: true,
    });
  }
});

test("portal vault summaries stay isolated for same vault name under different users", async () => {
  const vault = uniqueName("shared-portal-vault");
  const userA = uniqueName("portal-scope-user-a");
  const userB = uniqueName("portal-scope-user-b");
  try {
    await createUserCommand([userA, "--name", "Portal Scope User A", "--email", `${userA}@polaris.local`]);
    await createUserCommand([userB, "--name", "Portal Scope User B", "--email", `${userB}@polaris.local`]);
    await createCommand([vault, "--user", userA]);
    await createCommand([vault, "--user", userB]);
    writeVaultDriverSelection(vault, { backend: "docker" }, userA);
    writeVaultDriverSelection(vault, { backend: "docker" }, userB);
    writeVaultStatus({
      project: vault,
      runtime: {
        selectedDriver: { backend: "docker" },
        lifecycle: "running",
      },
      paseo: {
        daemon: "ready",
        web: "connectable",
        reconnectMode: "reconnectable",
        liveTarget: "https://app.paseo.test/#offer=a",
        reconnectTarget: "https://app.paseo.test/h/srv_a?scope=test",
      },
      details: {
        owner: userA,
      },
    }, userA);
    writeVaultStatus({
      project: vault,
      operation: {
        kind: "stop",
        updatedAt: new Date().toISOString(),
      },
      runtime: {
        selectedDriver: { backend: "docker" },
        lifecycle: "stopped",
        reason: "vault is stopped",
      },
      paseo: {
        daemon: "absent",
        web: "unavailable",
        reconnectMode: "unknown",
        liveTarget: null,
        reconnectTarget: null,
      },
      details: {
        owner: userB,
      },
    }, userB);

    const userASummary = (await listPortalVaults(userA)).find((entry) => entry.name === vault);
    const userBSummary = (await listPortalVaults(userB)).find((entry) => entry.name === vault);

    assert.equal(userASummary?.status?.driver?.status, "running");
    assert.equal(userASummary?.status?.details?.owner, userA);
    assert.equal(userBSummary?.status?.driver?.status, "stopping");
    assert.equal(userBSummary?.status?.details?.owner, userB);
  } finally {
    fs.rmSync(path.join(USER_ROOT, userA), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(USER_ROOT, userB), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(USER_ROOT, "profiles", `${userA}.yaml`), {
      force: true,
    });
    fs.rmSync(path.join(USER_ROOT, "profiles", `${userB}.yaml`), {
      force: true,
    });
  }
});

test("portal vault summaries expose surface capability without runtime ports", async () => {
  const userId = uniqueName("portal-summary-user");
  const vault = uniqueName("portal-summary-vault");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);
  try {
    await createUserCommand([
      userId,
      "--name",
      "Portal Summary User",
      "--email",
      `${userId}@polaris.local`,
    ]);
    scaffoldDockerVault(vault, userId, { line: "vertical" });
    const paseoStateRoot = vaultPaseoStateDir(vault, userId);
    fs.mkdirSync(paseoStateRoot, { recursive: true });
    fs.writeFileSync(path.join(paseoStateRoot, "server-id"), "srv_summary\n", "utf8");
    writeVaultStatus({
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
        liveTarget: null,
        reconnectTarget: null,
      },
      details: {},
    }, userId);

    const summary = (await listPortalVaults(userId)).find((entry) => entry.name === vault);
    assert.equal(summary?.serverId, "srv_summary");
    assert.equal(summary?.wanghaiId, wanghaiGatewayId(userId, vault));
    assert.deepEqual(summary?.surfaces, ["paseo", "wanghai"]);
    assert.equal("assets" in (summary?.status ?? {}), false);
    assert.equal("ports" in (summary ?? {}), false);
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("portal vault summaries keep Paseo-free Wanghai test vaults out of relay identity", async () => {
  const userId = uniqueName("portal-wanghai-only-user");
  const vault = uniqueName("portal-wanghai-only-vault");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);
  try {
    await createUserCommand([
      userId,
      "--name",
      "Portal Wanghai Test User",
      "--email",
      `${userId}@polaris.local`,
    ]);
    scaffoldDockerVault(vault, userId, {
      line: "vertical",
      paseoFreeWanghaiTest: true,
    });
    const paseoStateRoot = vaultPaseoStateDir(vault, userId);
    fs.mkdirSync(paseoStateRoot, { recursive: true });
    fs.writeFileSync(path.join(paseoStateRoot, "server-id"), "stale-paseo-server\n", "utf8");
    writeVaultStatus({
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
        liveTarget: null,
        reconnectTarget: null,
      },
      details: {},
    }, userId);

    const summary = (await listPortalVaults(userId)).find((entry) => entry.name === vault);
    assert.equal(summary?.serverId, null);
    assert.equal(summary?.wanghaiId, wanghaiGatewayId(userId, vault));
    assert.deepEqual(summary?.surfaces, ["wanghai"]);
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("portal API metadata is served from /api without a default user fallback", async () => {
  const server = createPortalServer(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Portal server did not expose a TCP address");
  }
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api`);
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      service: string;
      authMode: string;
      endpoints: string[];
    };
    assert.equal(payload.service, "polaris-portal-api");
    assert.equal(payload.authMode, "authing-browser-session");
    assert.ok(payload.endpoints.includes("/api/users/:userId/vaults"));
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("portal serves shell documents and shell assets from the control plane", async () => {
  const server = createPortalServer(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Portal server did not expose a TCP address");
  }
  try {
    const shellResponse = await fetch(`http://127.0.0.1:${address.port}/hosts`);
    assert.equal(shellResponse.status, 200);
    assert.match(shellResponse.headers.get("content-type") ?? "", /text\/html/);
    const shellHtml = await shellResponse.text();
    assert.match(shellHtml, /<main id="app" aria-live="polite"><\/main>/);
    assert.match(shellHtml, /\/shell\/shell\.css\?v=/);
    assert.match(shellHtml, /\/shell\/shell\.js\?v=/);

    const assetResponse = await fetch(`http://127.0.0.1:${address.port}/shell/shell.js`);
    assert.equal(assetResponse.status, 200);
    assert.match(assetResponse.headers.get("content-type") ?? "", /text\/javascript/);
    assert.ok((await assetResponse.text()).includes('href="/hosts"'));

    const shellHeadResponse = await fetch(`http://127.0.0.1:${address.port}/hosts`, {
      method: "HEAD",
    });
    assert.equal(shellHeadResponse.status, 200);
    assert.match(shellHeadResponse.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await shellHeadResponse.text(), "");

    const assetHeadResponse = await fetch(`http://127.0.0.1:${address.port}/shell/shell.js`, {
      method: "HEAD",
    });
    assert.equal(assetHeadResponse.status, 200);
    assert.match(assetHeadResponse.headers.get("content-type") ?? "", /text\/javascript/);
    assert.equal(await assetHeadResponse.text(), "");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("portal admin access updates can switch a user's subscription line", async () => {
  const originalUserMap = fs.existsSync(USER_MAP_PATH)
    ? fs.readFileSync(USER_MAP_PATH, "utf8")
    : null;
  try {
    await withEnv("POLARIS_AUTH_MODE", "oauth2-proxy", async () => {
      await upsertUserMapEntry("access-admin", {
        polarisUserId: DEMO_USER_ID,
        role: "admin",
        plan: "pro",
        line: "coding",
      });
      await upsertUserMapUserId("access-admin", {
        polarisUserId: DEMO_USER_ID,
        role: "admin",
        plan: "pro",
        line: "coding",
      });
      const server = createPortalServer(0);
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Portal server did not expose a TCP address");
      }
      try {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/api/users/${DEMO_USER_ID}/access`,
          {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              "X-Auth-Request-User": "access-admin",
            },
            body: JSON.stringify({ line: "vertical" }),
          },
        );
        assert.equal(response.status, 200);
        const payload = await response.json() as {
          polarisUserId: string;
          line: string;
        };
        assert.equal(payload.polarisUserId, DEMO_USER_ID);
        assert.equal(payload.line, "vertical");
        assert.equal(readUserAccessSummary(DEMO_USER_ID)?.line, "vertical");
      } finally {
        server.close();
        await once(server, "close");
      }
    });
  } finally {
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("portal access updates reject non-admin sessions", async () => {
  const userId = uniqueName("portal-access-user");
  const authingUsername = uniqueName("access-user");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);
  const originalUserMap = fs.existsSync(USER_MAP_PATH)
    ? fs.readFileSync(USER_MAP_PATH, "utf8")
    : null;
  try {
    await createUserCommand([
      userId,
      "--name",
      "Portal Non Admin",
      "--email",
      `${userId}@polaris.local`,
    ]);
    await withEnv("POLARIS_AUTH_MODE", "oauth2-proxy", async () => {
      await upsertUserMapEntry(authingUsername, {
        polarisUserId: userId,
        role: "user",
        plan: "free",
        line: "coding",
      });
      await upsertUserMapUserId(authingUsername, {
        polarisUserId: userId,
        role: "user",
        plan: "free",
        line: "coding",
      });
      const server = createPortalServer(0);
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Portal server did not expose a TCP address");
      }
      try {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/api/users/${userId}/access`,
          {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              "X-Auth-Request-User": authingUsername,
            },
            body: JSON.stringify({ line: "vertical" }),
          },
        );
        assert.equal(response.status, 403);
        const payload = await response.json() as { error: string };
        assert.match(payload.error, /Admin access is required/);
      } finally {
        server.close();
        await once(server, "close");
      }
    });
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("portal disabled auth mode returns a local development session without credentials", async () => {
  await withEnv("POLARIS_AUTH_MODE", "disabled", async () => {
    const userId = uniqueName("disabled-auth-user");
    await withEnv("POLARIS_AUTH_DEFAULT_USER_ID", userId, async () => {
      const server = createPortalServer(0);
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Portal server did not expose a TCP address");
      }
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/session`);
        assert.equal(response.status, 200);
        const payload = await response.json() as {
          authMode: string;
          authenticated: boolean;
          authingUsername: string | null;
          polarisUserId: string | null;
          role: string | null;
          line: string | null;
        };
        assert.equal(payload.authMode, "disabled");
        assert.equal(payload.authenticated, true);
        assert.equal(payload.authingUsername, userId);
        assert.equal(payload.polarisUserId, userId);
        assert.equal(payload.role, "admin");
        assert.equal(payload.line, null);
      } finally {
        server.close();
        await once(server, "close");
      }
    });
  });
});

test("portal oauth2-proxy auth mode trusts forwarded username headers", async () => {
  await withEnv("POLARIS_AUTH_MODE", "oauth2-proxy", async () => {
    const server = createPortalServer(0);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Portal server did not expose a TCP address");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/session`, {
        headers: {
          "X-Auth-Request-User": "authing-user-a",
        },
      });
      assert.equal(response.status, 200);
      const payload = await response.json() as {
        authMode: string;
        authenticated: boolean;
        authingUsername: string | null;
        authingUserId: string | null;
        polarisUserId: string | null;
        role: string | null;
      };
      assert.equal(payload.authMode, "oauth2-proxy");
      assert.equal(payload.authenticated, true);
      assert.equal(payload.authingUsername, "authing-user-a");
      assert.equal(payload.authingUserId, "authing-user-a");
      assert.equal(payload.polarisUserId, null);
      assert.equal(payload.role, null);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});

test("portal admin list includes mapped users", async () => {
  const userId = uniqueName("portal-admin-user");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;
  try {
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.mkdirSync(userRoot, { recursive: true });
    fs.writeFileSync(
      profilePath,
      yaml.dump({
        id: userId,
        name: "Portal Admin Target",
        email: `${userId}@polaris.local`,
        vaults: [],
      }, { lineWidth: 120, noRefs: true }),
      "utf8",
    );
    fs.writeFileSync(
      USER_MAP_PATH,
      `${JSON.stringify({
        users: {
          [userId]: {
            polarisUserId: userId,
            role: "user",
            plan: "free",
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const listed = listPortalAdminUsers();
    assert.ok(listed.some((entry) => entry.id === userId && entry.role === "user"));
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("portal admin list includes mapping-only users", async () => {
  const userId = uniqueName("portal-mapping-only");
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;
  try {
    fs.writeFileSync(
      USER_MAP_PATH,
      `${JSON.stringify({
        users: {
          [userId]: {
            polarisUserId: userId,
            role: "user",
            plan: "free",
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const listed = listPortalAdminUsers();
    assert.ok(
      listed.some((entry) =>
        entry.id === userId
        && entry.integrityStatus === "mapping-only"
        && entry.mappingPresent === true
        && entry.profilePresent === false),
    );
  } finally {
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("portal user deletion removes Clerk mappings together with the Polaris user", async () => {
  const userId = uniqueName("portal-mapped-delete");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;
  try {
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.mkdirSync(userRoot, { recursive: true });
    const credentialRegistryPath = path.join(userRoot, "credentials", "codex-default.yaml");
    const credentialMaterialPath = path.join(
      userRoot,
      "credentials",
      "codex",
      "codex-default",
      "auth.json",
    );
    fs.writeFileSync(
      profilePath,
      yaml.dump({
        id: userId,
        name: "Mapped Delete Target",
        email: `${userId}@polaris.local`,
        vaults: [],
      }, { lineWidth: 120, noRefs: true }),
      "utf8",
    );
    fs.mkdirSync(path.dirname(credentialMaterialPath), { recursive: true });
    fs.writeFileSync(credentialRegistryPath, "id: codex-default\n", "utf8");
    fs.writeFileSync(credentialMaterialPath, "{\n  \"OPENAI_API_KEY\": \"test\"\n}\n", "utf8");
    fs.writeFileSync(
      USER_MAP_PATH,
      `${JSON.stringify({
        users: {
          [`${userId}-username`]: {
            polarisUserId: userId,
            role: "user",
            plan: "free",
          },
        },
        userIds: {
          [`user_${userId}`]: {
            polarisUserId: userId,
            role: "user",
            plan: "free",
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const payload = await deletePortalUser(userId);
    assert.equal(payload.deleted, true);
    assert.equal(payload.userId, userId);
    assert.equal(fs.existsSync(profilePath), false);
    assert.equal(fs.existsSync(userRoot), false);
    const currentMap = fs.existsSync(USER_MAP_PATH)
      ? JSON.parse(fs.readFileSync(USER_MAP_PATH, "utf8")) as {
        users?: Record<string, { polarisUserId: string }>;
        userIds?: Record<string, { polarisUserId: string }>;
      }
      : { users: {}, userIds: {} };
    assert.equal(currentMap.users?.[`${userId}-username`], undefined);
    assert.equal(currentMap.userIds?.[`user_${userId}`], undefined);
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("portal user deletion restores profile root and mappings when filesystem deletion fails", async () => {
  const userId = uniqueName("portal-delete-rollback");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);
  const credentialPath = path.join(userRoot, "credentials", "codex-default.yaml");
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;
  const originalRmSync = fs.rmSync;
  let injectedFailure = false;
  try {
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
    fs.writeFileSync(
      profilePath,
      yaml.dump({
        id: userId,
        name: "Rollback Target",
        email: `${userId}@polaris.local`,
        vaults: [],
      }, { lineWidth: 120, noRefs: true }),
      "utf8",
    );
    fs.writeFileSync(credentialPath, "id: codex-default\n", "utf8");
    fs.writeFileSync(
      USER_MAP_PATH,
      `${JSON.stringify({
        users: {
          [`${userId}-username`]: {
            polarisUserId: userId,
            role: "user",
            plan: "free",
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    fs.rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
      if (!injectedFailure && target === userRoot) {
        injectedFailure = true;
        throw new Error("simulated user-root deletion failure");
      }
      return originalRmSync(target, options);
    }) as typeof fs.rmSync;

    await assert.rejects(
      () => deletePortalUser(userId),
      /simulated user-root deletion failure/i,
    );

    assert.equal(fs.existsSync(profilePath), true);
    assert.equal(fs.existsSync(userRoot), true);
    assert.equal(fs.existsSync(credentialPath), true);
    const currentMap = JSON.parse(fs.readFileSync(USER_MAP_PATH, "utf8")) as {
      users?: Record<string, { polarisUserId: string }>;
    };
    assert.equal(currentMap.users?.[`${userId}-username`]?.polarisUserId, userId);
  } finally {
    fs.rmSync = originalRmSync;
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("portal user deletion rollback preserves unrelated user-map updates", async () => {
  const userId = uniqueName("portal-delete-preserve");
  const unrelatedUserId = uniqueName("portal-unrelated");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;
  const originalRmSync = fs.rmSync;
  let injectedFailure = false;
  try {
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.mkdirSync(path.join(userRoot, "credentials"), { recursive: true });
    fs.writeFileSync(
      profilePath,
      yaml.dump({
        id: userId,
        name: "Preserve Target",
        email: `${userId}@polaris.local`,
        vaults: [],
      }, { lineWidth: 120, noRefs: true }),
      "utf8",
    );
    fs.writeFileSync(
      USER_MAP_PATH,
      `${JSON.stringify({
        users: {
          [`${userId}-username`]: {
            polarisUserId: userId,
            role: "user",
            plan: "free",
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    fs.rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
      if (!injectedFailure && target === userRoot) {
        injectedFailure = true;
        const current = fs.existsSync(USER_MAP_PATH)
          ? JSON.parse(fs.readFileSync(USER_MAP_PATH, "utf8")) as {
            users?: Record<string, { polarisUserId: string; role: string; plan: string }>;
          }
          : { users: {} };
        current.users ??= {};
        current.users[`${unrelatedUserId}-username`] = {
          polarisUserId: unrelatedUserId,
          role: "user",
          plan: "free",
        };
        fs.writeFileSync(USER_MAP_PATH, `${JSON.stringify(current, null, 2)}\n`, "utf8");
        throw new Error("simulated deletion failure after unrelated mapping update");
      }
      return originalRmSync(target, options);
    }) as typeof fs.rmSync;

    await assert.rejects(
      () => deletePortalUser(userId),
      /simulated deletion failure after unrelated mapping update/i,
    );

    const current = JSON.parse(fs.readFileSync(USER_MAP_PATH, "utf8")) as {
      users?: Record<string, { polarisUserId: string }>;
    };
    assert.equal(current.users?.[`${userId}-username`]?.polarisUserId, userId);
    assert.equal(
      current.users?.[`${unrelatedUserId}-username`]?.polarisUserId,
      unrelatedUserId,
    );
  } finally {
    fs.rmSync = originalRmSync;
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("portal user deletion rejects users with queued vault provisioning", async () => {
  const userId = uniqueName("portal-delete-queued-user");
  const vault = uniqueName("portal-delete-queued-vault");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);

  try {
    await createUserCommand([
      userId,
      "--name",
      "Queued Delete User",
      "--email",
      `${userId}@polaris.local`,
    ]);
    writeVaultProvisionProgress(userId, vault, {
      jobId: uniqueName("queued-job"),
      userId,
      vault,
      status: "queued",
      phase: "queued",
      step: 0,
      totalSteps: 7,
      percent: 0,
      message: "vault provisioning queued",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      done: false,
      cancellable: true,
    });

    await assert.rejects(
      () => deletePortalUser(userId),
      /vault data still exists|queued/i,
    );
    assert.equal(fs.existsSync(profilePath), true);
    assert.equal(fs.existsSync(userRoot), true);
  } finally {
    clearVaultProvisionProgress(userId, vault);
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("portal user deletion rollback restores the lock-consistent user snapshot", async () => {
  const userId = uniqueName("portal-delete-rollback-user");
  const profilePath = path.join(USER_ROOT, "profiles", `${userId}.yaml`);
  const userRoot = path.join(USER_ROOT, userId);
  const userCredentialPath = path.join(
    userRoot,
    "credentials",
    "codex",
    "rollback-check",
    "auth.json",
  );
  const originalRmSync = fs.rmSync;

  try {
    await createUserCommand([
      userId,
      "--name",
      "Rollback Snapshot User",
      "--email",
      `${userId}@polaris.local`,
    ]);
    await createPortalCredential({
      userId,
      harness: "codex",
      credentialId: "rollback-check",
      label: "Rollback Check",
      providerName: "rightcode",
      baseUrl: "https://right.codes/codex/v1",
      apiKey: "rollback-key",
    });

    let injectedFailure = false;
    fs.rmSync = ((targetPath: fs.PathLike, options?: fs.RmOptions) => {
      const normalized = typeof targetPath === "string"
        ? targetPath
        : Buffer.isBuffer(targetPath)
          ? targetPath.toString("utf8")
          : String(targetPath);
      if (!injectedFailure && normalized === userRoot) {
        injectedFailure = true;
        throw new Error("simulated user-root deletion failure");
      }
      return originalRmSync(targetPath, options);
    }) as typeof fs.rmSync;

    await assert.rejects(
      () => deletePortalUser(userId),
      /simulated user-root deletion failure/,
    );
    assert.equal(fs.existsSync(profilePath), true);
    assert.equal(fs.existsSync(userRoot), true);
    assert.equal(fs.existsSync(userCredentialPath), true);
  } finally {
    fs.rmSync = originalRmSync;
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});
