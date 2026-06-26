import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import yaml from "js-yaml";
import { createPortalServer } from "../scripts/portal/server.js";
import {
  listOwnedWorkspaces,
  readWorkspaceProvisionProgress,
  writeWorkspaceProvisionProgress,
  clearWorkspaceProvisionProgress,
} from "../scripts/core/portal.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

async function withPortalServer(
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createPortalServer(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Portal server did not expose a TCP address");
  }
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function withPortalAuthEnv(
  secret: string,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = process.env.POLARIS_AUTH_SHARED_SECRET;
  process.env.POLARIS_AUTH_SHARED_SECRET = secret;
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.POLARIS_AUTH_SHARED_SECRET;
    } else {
      process.env.POLARIS_AUTH_SHARED_SECRET = previous;
    }
  }
}

test("workspace ownership is derived from the project directory", () => {
  const userId = "100000000000000001";
  const workspace = uniqueName("portal-owned");
  const root = path.join(REPO_ROOT, "config", "users", userId, "projects", workspace);
  fs.mkdirSync(root, { recursive: true });
  try {
    assert.ok(listOwnedWorkspaces(userId).includes(workspace));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("portal provisioning progress persists across reads", () => {
  const userId = "100000000000000002";
  const workspace = uniqueName("portal-progress");
  const progress = {
    userId,
    workspace,
    phase: "images",
    step: 2,
    totalSteps: 6,
    percent: 33,
    message: "building images",
    updatedAt: new Date().toISOString(),
    done: false,
  };
  try {
    writeWorkspaceProvisionProgress(userId, workspace, progress);
    assert.deepEqual(readWorkspaceProvisionProgress(userId, workspace), progress);
  } finally {
    clearWorkspaceProvisionProgress(userId, workspace);
  }
});

test("portal API serves route-scoped workspaces and credentials without auth", async () => {
  const credentialId = uniqueName("portal-cred");
  const userId = "100000000000000002";

  await withPortalServer(async (baseUrl) => {
    const selfResponse = await fetch(`${baseUrl}/api/users/${userId}/workspaces`, {
    });
    assert.equal(selfResponse.status, 200);
    const selfPayload = await selfResponse.json() as { workspaces: Array<{ name: string }> };
    assert.ok(selfPayload.workspaces.some((workspace) => workspace.name === "morpheus"));

    const crossUserResponse = await fetch(`${baseUrl}/api/users/100000000000000001/workspaces`);
    assert.equal(crossUserResponse.status, 200);
    const crossUserPayload = await crossUserResponse.json() as { workspaces: Array<{ name: string }> };
    assert.ok(crossUserPayload.workspaces.some((workspace) => workspace.name === "demo"));

    const createResponse = await fetch(
      `${baseUrl}/api/users/${userId}/credentials/create`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          credentialId,
          kind: "api-key",
          label: "Portal Test Credential",
          purposes: "agent-auth",
          content: "{\"token\":\"test\"}\n",
        }),
      },
    );
    assert.equal(createResponse.status, 200);
    const created = await createResponse.json() as { id: string };
    assert.equal(created.id, credentialId);

    const credentialsResponse = await fetch(`${baseUrl}/api/users/${userId}/credentials`, {
    });
    assert.equal(credentialsResponse.status, 200);
    const credentialsPayload = await credentialsResponse.json() as { credentials: Array<{ id: string }> };
    assert.ok(credentialsPayload.credentials.some((credential) => credential.id === credentialId));
  });

  fs.rmSync(path.join(REPO_ROOT, "config", "users", userId, "credentials", `${credentialId}.yaml`), {
    force: true,
  });
  fs.rmSync(path.join(REPO_ROOT, "config", "users", userId, "credentials", "generated", credentialId), {
    recursive: true,
    force: true,
  });
});

test("portal API reads and updates user profiles", async () => {
  const userId = "100000000000000001";
  const original = fs.readFileSync(path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`), "utf8");

  await withPortalServer(async (baseUrl) => {
    const getResponse = await fetch(`${baseUrl}/api/users/${userId}/profile`);
    assert.equal(getResponse.status, 200);
    const profile = await getResponse.json() as { name: string; email: string };
    assert.equal(profile.name, "Demo User");

    const postResponse = await fetch(`${baseUrl}/api/users/${userId}/profile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Demo User Updated",
        email: "demo@example.com",
        githubAccount: "demo-account",
        sshComment: "demo@example.com",
      }),
    });
    assert.equal(postResponse.status, 200);
    const updated = await postResponse.json() as { name: string; githubAccount?: string };
    assert.equal(updated.name, "Demo User Updated");
    assert.equal(updated.githubAccount, "demo-account");
  });

  fs.writeFileSync(
    path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`),
    original,
    "utf8",
  );
});

test("portal API deletes a stopped workspace and removes it from the profile index", async () => {
  const userId = "100000000000000002";
  const workspace = uniqueName("portal-delete");
  const workspaceRoot = path.join(REPO_ROOT, "config", "users", userId, "projects", workspace);
  const profileFile = path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);
  const originalProfile = fs.readFileSync(profileFile, "utf8");
  const profileData = (yaml.load(originalProfile) ?? {}) as Record<string, unknown>;
  const workspaces = Array.isArray(profileData.workspaces)
    ? profileData.workspaces.map((value) => String(value)).filter(Boolean)
    : [];

  fs.mkdirSync(workspaceRoot, { recursive: true });
  profileData.workspaces = [...workspaces, workspace].sort();
  fs.writeFileSync(profileFile, yaml.dump(profileData, { lineWidth: 120, noRefs: true }), "utf8");

  try {
    await withPortalServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/users/${userId}/workspaces/${workspace}`,
        { method: "DELETE" },
      );
      assert.equal(response.status, 200);
      const payload = await response.json() as { removed: boolean };
      assert.equal(payload.removed, true);
    });

    assert.equal(fs.existsSync(workspaceRoot), false);
    const profileAfter = (yaml.load(fs.readFileSync(profileFile, "utf8")) ?? {}) as Record<string, unknown>;
    const remaining = Array.isArray(profileAfter.workspaces)
      ? profileAfter.workspaces.map((value) => String(value))
      : [];
    assert.equal(remaining.includes(workspace), false);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.writeFileSync(profileFile, originalProfile, "utf8");
  }
});

test("portal root advertises the API surface and default user", async () => {
  await withPortalServer(async (baseUrl) => {
    const response = await fetch(baseUrl);
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      service: string;
      defaultUserId: string | null;
      endpoints: string[];
    };
    assert.equal(payload.service, "polaris-portal-api");
    assert.equal(payload.defaultUserId, "100000000000000001");
    assert.ok(payload.endpoints.includes("/api/users/:userId/workspaces"));
  });
});

test("portal API restricts normal users to their own scope when trusted auth headers are enabled", async () => {
  await withPortalAuthEnv("test-secret", async () => {
    await withPortalServer(async (baseUrl) => {
      const ownResponse = await fetch(`${baseUrl}/api/users/100000000000000002/workspaces`, {
        headers: {
          "x-polaris-auth-shared-secret": "test-secret",
          "x-polaris-user-id": "100000000000000002",
          "x-polaris-user-role": "user",
          "x-polaris-user-email": "member@example.com",
          "x-polaris-user-plan": "free",
        },
      });
      assert.equal(ownResponse.status, 200);

      const crossResponse = await fetch(`${baseUrl}/api/users/100000000000000001/workspaces`, {
        headers: {
          "x-polaris-auth-shared-secret": "test-secret",
          "x-polaris-user-id": "100000000000000002",
          "x-polaris-user-role": "user",
          "x-polaris-user-email": "member@example.com",
          "x-polaris-user-plan": "free",
        },
      });
      assert.equal(crossResponse.status, 403);
    });
  });
});

test("portal API allows admin users to access cross-user scopes when trusted auth headers are enabled", async () => {
  await withPortalAuthEnv("test-secret", async () => {
    await withPortalServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/users/100000000000000001/workspaces`, {
        headers: {
          "x-polaris-auth-shared-secret": "test-secret",
          "x-polaris-user-id": "100000000000000001",
          "x-polaris-user-role": "admin",
          "x-polaris-user-email": "admin@example.com",
        },
      });
      assert.equal(response.status, 200);
      const payload = await response.json() as { workspaces: Array<{ name: string }> };
      assert.ok(payload.workspaces.some((workspace) => workspace.name === "demo"));
    });
  });
});
