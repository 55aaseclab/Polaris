import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import yaml from "js-yaml";
import { createClerkClient } from "@clerk/backend";
import { createPortalServer } from "../../scripts/portal/server.js";
import { createExecutorServer } from "../../scripts/executor/server.js";
import {
  deleteUserMapEntriesForPolarisUserId,
  upsertUserMapEntry,
  upsertUserMapUserId,
} from "../../scripts/portal/user-map.js";
import {
  listPortalAdminUsers,
  queueProvisionWorkspace,
  reportPortalWorkspaceStatus,
  createPortalCredential,
  deletePortalUser,
} from "../../scripts/portal/service.js";
import { createUserCommand } from "../../scripts/cli/commands/create-user.js";
import {
  readWorkspaceStatus,
  writeWorkspaceProvisionProgress,
  clearWorkspaceProvisionProgress,
} from "../../scripts/core/portal.js";
import { writeWorkspaceStatus } from "../../scripts/output/state-store.js";
import { workspaceRuntimeScopeName } from "../../scripts/core/workspace-name.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..");
const USER_MAP_PATH = path.join(REPO_ROOT, "config", "users", "user-map.json");
const DEMO_USER_ID = "100000000000000001";
const EXECUTOR_TEST_SECRET = "polaris-executor-test-secret";

let executorServer: import("node:http").Server | null = null;
const previousExecutorEnv = new Map<string, string | undefined>();

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

test.before(async () => {
  for (const name of [
    "POLARIS_EXECUTOR_BASE_URL",
    "POLARIS_EXECUTOR_SHARED_SECRET",
  ]) {
    previousExecutorEnv.set(name, process.env[name]);
  }
  process.env.POLARIS_EXECUTOR_SHARED_SECRET = EXECUTOR_TEST_SECRET;
  executorServer = createExecutorServer(0);
  await once(executorServer, "listening");
  const address = executorServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Executor server did not expose a TCP address");
  }
  process.env.POLARIS_EXECUTOR_BASE_URL = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  if (executorServer) {
    executorServer.close();
    await once(executorServer, "close");
    executorServer = null;
  }
  for (const [name, value] of previousExecutorEnv.entries()) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

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
  },
): Promise<void> {
  await upsertUserMapEntry(identity.clerkUsername, {
    polarisUserId: input.polarisUserId,
    role: input.role ?? "user",
    plan: input.plan ?? "free",
  });
  await upsertUserMapUserId(identity.clerkUserId, {
    polarisUserId: input.polarisUserId,
    role: input.role ?? "user",
    plan: input.plan ?? "free",
  });
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

test("live auth portal API accepts runtime status reports and persists cached workspace state", async () => {
  const userId = DEMO_USER_ID;
  const workspace = "demo";
  const previous = readWorkspaceStatus(userId, workspace);
  writeWorkspaceStatus({
    project: workspace,
    driver: {
      backend: "docker",
      baseImage: "ttl.sh/example:24h",
      runtimeKind: "docker-container",
      runtimeRef: `container/${workspaceRuntimeScopeName(userId, workspace)}-docker`,
    },
    runtime: {
      selectedDriver: { backend: "docker" },
      lifecycle: "stopped",
      reason: "test setup",
    },
    paseo: {
      daemon: "absent",
      web: "unavailable",
      reconnectMode: "unknown",
      liveTarget: null,
      reconnectTarget: null,
      reason: "test setup",
    },
    details: {},
  }, userId);
  try {
    await withPortalServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/users/${userId}/workspaces/${workspace}/refresh`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      assert.equal(response.status, 200);
    });
    await withPortalServer(async (baseUrl) => {
      const detailBefore = await fetch(
        `${baseUrl}/api/users/${userId}/workspaces/${workspace}`,
      );
      assert.equal(detailBefore.status, 200);
      const parsedBefore = await detailBefore.json() as {
        status?: { driver?: { status?: string } };
      };
      assert.equal(parsedBefore.status?.driver?.status, "stopped");

      await reportPortalWorkspaceStatus({
        userId,
        workspace,
        status: {
          runtime: {
            selectedDriver: { backend: "docker" },
            lifecycle: "running",
          },
          paseo: {
            daemon: "ready",
            web: "connectable",
            reconnectMode: "reconnectable",
            liveTarget: "https://app.paseo.sh/#offer=test",
            reconnectTarget: "https://example.invalid/h/srv_test?scope=demo",
          },
          details: {
            backendDetail: "reported by test",
          },
        },
      });

      const detailAfter = await fetch(
        `${baseUrl}/api/users/${userId}/workspaces/${workspace}`,
      );
      assert.equal(detailAfter.status, 200);
      const parsedAfter = await detailAfter.json() as {
        status?: {
          driver?: { status?: string };
          paseo?: { daemon?: string; web?: string };
          details?: { backendDetail?: string };
        };
      };
      assert.equal(parsedAfter.status?.driver?.status, "running");
      assert.equal(parsedAfter.status?.paseo?.daemon, "ready");
      assert.equal(parsedAfter.status?.paseo?.web, "connectable");
      assert.equal(parsedAfter.status?.details?.backendDetail, "reported by test");
    });
  } finally {
    if (previous) {
      writeWorkspaceStatus(previous, userId);
    }
  }
});

test("live auth portal API serves route-scoped workspaces and credentials for an authenticated scope", async () => {
  const credentialId = uniqueName("portal-cred");
  const userId = DEMO_USER_ID;

  await withPortalServer(async (baseUrl) => {
    const selfResponse = await fetch(`${baseUrl}/api/users/${userId}/workspaces`, {
    });
    assert.equal(selfResponse.status, 200);
    const selfPayload = await selfResponse.json() as { workspaces: Array<{ name: string }> };
    assert.ok(selfPayload.workspaces.some((workspace) => workspace.name === "demo"));

    const createResponse = await fetch(
      `${baseUrl}/api/users/${userId}/credentials`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          harness: "codex",
          credentialId,
          label: "Portal Test Credential",
          providerName: "rightcode",
          baseUrl: "https://right.codes/codex/v1",
          apiKey: "test-api-key",
        }),
      },
    );
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json() as { id: string };
    assert.equal(created.id, credentialId);

    const credentialsResponse = await fetch(`${baseUrl}/api/users/${userId}/credentials`, {
    });
    assert.equal(credentialsResponse.status, 200);
    const credentialsPayload = await credentialsResponse.json() as { credentials: Array<{ id: string }> };
    assert.ok(credentialsPayload.credentials.some((credential) => credential.id === credentialId));

    const recordResponse = await fetch(
      `${baseUrl}/api/users/${userId}/credentials/${credentialId}`,
    );
    assert.equal(recordResponse.status, 200);
    const recordPayload = await recordResponse.json() as {
      credential: { id: string };
      files: Array<{ key: string; content: string }>;
    };
    assert.equal(recordPayload.credential.id, credentialId);
    assert.ok(recordPayload.files.some((file) => file.key === "codex-auth.json"));

    const writeResponse = await fetch(
      `${baseUrl}/api/users/${userId}/credentials/${credentialId}/files/codex-auth.json`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: JSON.stringify({
            OPENAI_API_KEY: "portal-updated-api-key",
          }, null, 2),
        }),
      },
    );
    assert.equal(writeResponse.status, 200);
    const updatedPayload = await writeResponse.json() as {
      credential: { id: string };
      files: Array<{ key: string; content: string }>;
    };
    assert.equal(updatedPayload.credential.id, credentialId);
    assert.ok(
      updatedPayload.files.some((file) =>
        file.key === "codex-auth.json" && file.content.includes("portal-updated-api-key")
      ),
    );
  });

  fs.rmSync(path.join(REPO_ROOT, "config", "users", userId, "credentials", `${credentialId}.yaml`), {
    force: true,
  });
  fs.rmSync(path.join(REPO_ROOT, "config", "users", userId, "credentials", "codex", credentialId), {
    recursive: true,
    force: true,
  });
});

test("live auth portal API rejects cross-user access for a normal user session", async () => {
  const firstUserId = uniqueName("portal-scope-user-a");
  const secondUserId = uniqueName("portal-scope-user-b");
  const cleanupTargets = [firstUserId, secondUserId].map((userId) => ({
    profilePath: path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`),
    userRoot: path.join(REPO_ROOT, "config", "users", userId),
  }));
  const identity = await createLivePortalIdentity();

  try {
    await createUserCommand([firstUserId, "--name", "Scope User A", "--email", `${firstUserId}@polaris.local`]);
    await createUserCommand([secondUserId, "--name", "Scope User B", "--email", `${secondUserId}@polaris.local`]);
    await mapIdentityToPolarisUser(identity, { polarisUserId: firstUserId, role: "user", plan: "free" });

    await withPortalServerIdentity(identity, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/users/${secondUserId}/workspaces`, {
      });
      assert.equal(response.status, 403);
    });
  } finally {
    await identity.cleanup();
    for (const target of cleanupTargets) {
      fs.rmSync(target.profilePath, { force: true });
      fs.rmSync(target.userRoot, { recursive: true, force: true });
    }
  }
});

test("live auth portal API creates a user profile and Clerk mapping via the CLI-backed flow", async () => {
  const clerkUsername = uniqueName("portal-user");
  const userProfileId = clerkUsername;
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const secretsRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;
  const identity = await createLivePortalIdentity(clerkUsername);

  try {
    await withPortalServerIdentity(identity, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/users`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userProfileId,
          clerkUsername,
          name: "Portal Test User",
          email: `${userProfileId}@polaris.local`,
          role: "user",
          plan: "free",
        }),
      });
      assert.equal(response.status, 201);
      const created = await response.json() as { id: string; name: string; email: string };
      assert.equal(created.id, userProfileId);
      assert.equal(created.name, "Portal Test User");
      assert.equal(created.email, `${userProfileId}@polaris.local`);
    });

    assert.equal(fs.existsSync(profilePath), true);
    assert.equal(fs.existsSync(path.join(secretsRoot, "credentials", "github-ssh.yaml")), true);
    assert.equal(fs.existsSync(path.join(secretsRoot, "credentials", "ssh", "github-ssh", "id_ed25519")), true);
    assert.equal(fs.existsSync(path.join(secretsRoot, "credentials", "ssh", "github-ssh", "id_ed25519.pub")), true);

    const userMap = JSON.parse(fs.readFileSync(USER_MAP_PATH, "utf8")) as {
      users?: Record<string, { polarisUserId: string; role: string; plan: string }>;
    };
    assert.equal(userMap.users?.[clerkUsername]?.polarisUserId, userProfileId);
    assert.equal(userMap.users?.[clerkUsername]?.role, "user");
    assert.equal(userMap.users?.[clerkUsername]?.plan, "free");
  } finally {
    await identity.cleanup();
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(secretsRoot, { recursive: true, force: true });
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("live auth portal API creates a user profile without a Clerk email by using a synthetic fallback email", async () => {
  const clerkUsername = uniqueName("portal-no-email");
  const userProfileId = clerkUsername;
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const secretsRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;
  const identity = await createLivePortalIdentity(clerkUsername);

  try {
    await withPortalServerIdentity(identity, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/users`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userProfileId,
          clerkUsername,
          name: "Portal No Email User",
          role: "user",
          plan: "free",
        }),
      });
      assert.equal(response.status, 201);
      const created = await response.json() as { id: string; email: string };
      assert.equal(created.id, userProfileId);
      assert.equal(created.email, `${userProfileId}@polaris.local`);
    });

    assert.equal(fs.existsSync(profilePath), true);
    assert.equal(fs.existsSync(path.join(secretsRoot, "credentials", "github-ssh.yaml")), true);
    assert.equal(fs.existsSync(path.join(secretsRoot, "credentials", "ssh", "github-ssh", "id_ed25519")), true);
    assert.equal(fs.existsSync(path.join(secretsRoot, "credentials", "ssh", "github-ssh", "id_ed25519.pub")), true);
  } finally {
    await identity.cleanup();
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(secretsRoot, { recursive: true, force: true });
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("live auth portal API creates the default RightCode codex credential when configured", async () => {
  const previous = process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY;
  process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY = "test-default-rightcode-key";
  const clerkUsername = uniqueName("portal-codex-default");
  const userProfileId = clerkUsername;
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const secretsRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;
  const identity = await createLivePortalIdentity(clerkUsername);

  try {
    await withPortalServerIdentity(identity, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/users`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userProfileId,
          clerkUsername,
          name: "Portal Codex Default User",
          email: `${userProfileId}@polaris.local`,
          role: "user",
          plan: "free",
        }),
      });
      assert.equal(response.status, 201);
    });

    assert.equal(fs.existsSync(profilePath), true);
    assert.equal(fs.existsSync(path.join(secretsRoot, "credentials", "github-ssh.yaml")), true);
    assert.equal(fs.existsSync(path.join(secretsRoot, "credentials", "codex-rightcode.yaml")), true);
  } finally {
    if (previous === undefined) {
      delete process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY;
    } else {
      process.env.POLARIS_DEFAULT_CODEX_RIGHTCODE_API_KEY = previous;
    }
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(secretsRoot, { recursive: true, force: true });
    await identity.cleanup();
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("live auth portal API deletes a user profile, user root, and Clerk mapping", async () => {
  const userProfileId = uniqueName("portal-delete-user");
  const clerkUsername = uniqueName("clerk-delete-user");
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;

  try {
    await createUserCommand([
      userProfileId,
      "--name",
      "Portal Delete User",
      "--email",
      `${userProfileId}@polaris.local`,
      "--clerk",
      clerkUsername,
    ]);

    await withPortalServer(async (baseUrl) => {
      const sessionResponse = await fetch(`${baseUrl}/api/session`);
      assert.equal(sessionResponse.status, 200);
      const sessionPayload = await sessionResponse.json() as {
        polarisUserId: string | null;
      };
      assert.equal(sessionPayload.polarisUserId, DEMO_USER_ID);

      deleteUserMapEntriesForPolarisUserId(userProfileId);

      const response = await fetch(
        `${baseUrl}/api/users/${encodeURIComponent(userProfileId)}`,
        { method: "DELETE" },
      );
      assert.equal(response.status, 200);
      const payload = await response.json() as {
        deleted: true;
        userId: string;
      };
      assert.equal(payload.deleted, true);
      assert.equal(payload.userId, userProfileId);
    });

    assert.equal(fs.existsSync(profilePath), false);
    assert.equal(fs.existsSync(userRoot), false);
    const userMap = fs.existsSync(USER_MAP_PATH)
      ? JSON.parse(fs.readFileSync(USER_MAP_PATH, "utf8")) as {
        users?: Record<string, unknown>;
      }
      : {};
    assert.equal(Boolean(userMap.users?.[clerkUsername]), false);
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

test("live auth portal API resolves Clerk username mappings from the live mapping file", async () => {
  const clerkUsername = uniqueName("clerk-map");
  const userProfileId = uniqueName("portal-map-user");
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;
  const identity = await createLivePortalIdentity(clerkUsername);

  try {
    await createUserCommand([
      userProfileId,
      "--name",
      "Portal Mapping User",
      "--email",
      `${userProfileId}@polaris.local`,
      "--clerk",
      clerkUsername,
    ]);

    await withPortalServerIdentity(identity, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/user-mapping?clerkUsername=${encodeURIComponent(clerkUsername)}`,
      );
      assert.equal(response.status, 200);
      const payload = await response.json() as {
        clerkUsername: string;
        mapping: { polarisUserId: string; role: string; plan: string } | null;
      };
      assert.equal(payload.clerkUsername, clerkUsername);
      assert.equal(payload.mapping?.polarisUserId, userProfileId);
      assert.equal(payload.mapping?.role, "user");
      assert.equal(payload.mapping?.plan, "free");
    });
  } finally {
    await identity.cleanup();
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("live auth user-map writes remain consistent under concurrent async updates", async () => {
  const firstIdentity = await createLivePortalIdentity(uniqueName("clerk-concurrent-a"));
  const secondIdentity = await createLivePortalIdentity(uniqueName("clerk-concurrent-b"));
  const firstUserId = uniqueName("portal-concurrent-a");
  const secondUserId = uniqueName("portal-concurrent-b");
  const cleanupTargets = [firstUserId, secondUserId].map((userId) => ({
    profilePath: path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`),
    userRoot: path.join(REPO_ROOT, "config", "users", userId),
  }));
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;

  try {
    await Promise.all([
      createUserCommand([
        firstUserId,
        "--name",
        "Concurrent User A",
        "--email",
        `${firstUserId}@polaris.local`,
        "--clerk",
        firstIdentity.clerkUsername,
        "--clerk-user-id",
        firstIdentity.clerkUserId,
      ]),
      createUserCommand([
        secondUserId,
        "--name",
        "Concurrent User B",
        "--email",
        `${secondUserId}@polaris.local`,
        "--clerk",
        secondIdentity.clerkUsername,
        "--clerk-user-id",
        secondIdentity.clerkUserId,
      ]),
    ]);

    const current = JSON.parse(fs.readFileSync(USER_MAP_PATH, "utf8")) as {
      users?: Record<string, { polarisUserId: string }>;
      userIds?: Record<string, { polarisUserId: string }>;
    };
    assert.equal(current.users?.[firstIdentity.clerkUsername]?.polarisUserId, firstUserId);
    assert.equal(current.userIds?.[firstIdentity.clerkUserId]?.polarisUserId, firstUserId);
    assert.equal(current.users?.[secondIdentity.clerkUsername]?.polarisUserId, secondUserId);
    assert.equal(current.userIds?.[secondIdentity.clerkUserId]?.polarisUserId, secondUserId);
  } finally {
    await firstIdentity.cleanup();
    await secondIdentity.cleanup();
    for (const target of cleanupTargets) {
      fs.rmSync(target.profilePath, { force: true });
      fs.rmSync(target.userRoot, { recursive: true, force: true });
    }
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("live auth portal API rejects conflicting Clerk username registrations", async () => {
  const clerkUsername = uniqueName("clerk-conflict");
  const firstUserId = uniqueName("portal-conflict-a");
  const secondUserId = uniqueName("portal-conflict-b");
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;
  const cleanupTargets = [firstUserId, secondUserId].map((userId) => ({
    profilePath: path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`),
    userRoot: path.join(REPO_ROOT, "config", "users", userId),
  }));

  try {
    await createUserCommand([
      firstUserId,
      "--name",
      "Conflict A",
      "--email",
      `${firstUserId}@polaris.local`,
      "--clerk",
      clerkUsername,
    ]);

    await withPortalServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userProfileId: secondUserId,
          clerkUsername,
          name: "Conflict B",
          email: `${secondUserId}@polaris.local`,
          role: "user",
          plan: "free",
        }),
      });
      assert.equal(response.status, 409);
      const payload = await response.json() as { error?: string };
      assert.match(payload.error ?? "", /already mapped/i);
    });
  } finally {
    for (const target of cleanupTargets) {
      fs.rmSync(target.profilePath, { force: true });
      fs.rmSync(target.userRoot, { recursive: true, force: true });
    }
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("live auth portal user creation promotes bootstrap admins automatically", async () => {
  const userId = "bootstrap-admin";
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userId);
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;
  const identity = await createLivePortalIdentity(userId);
  await withEnv("POLARIS_BOOTSTRAP_ADMIN_USERS", identity.clerkUsername, async () => {
    try {
      await withPortalServerIdentity(identity, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/users`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            userProfileId: userId,
            clerkUsername: userId,
            name: "Bootstrap Admin",
          }),
        });
        assert.equal(response.status, 201);
      });
      const userMap = JSON.parse(fs.readFileSync(USER_MAP_PATH, "utf8")) as {
        users: Record<string, { role: string }>;
      };
      assert.equal(userMap.users[userId]?.role, "admin");
    } finally {
      await identity.cleanup();
      fs.rmSync(profilePath, { force: true });
      fs.rmSync(userRoot, { recursive: true, force: true });
      if (originalUserMap === null) {
        fs.rmSync(USER_MAP_PATH, { force: true });
      } else {
        fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
      }
    }
  });
});
