import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import yaml from "js-yaml";
import { createPortalServer } from "../scripts/portal/server.js";
import { createCommand } from "../scripts/cli/commands/create.js";
import { createUserCommand } from "../scripts/cli/commands/create-user.js";
import {
  listOwnedWorkspaces,
  readWorkspaceProvisionProgress,
  writeWorkspaceProvisionProgress,
  clearWorkspaceProvisionProgress,
} from "../scripts/core/portal.js";
import { writeWorkspaceDriverSelection } from "../scripts/output/state-store.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const USER_MAP_PATH = path.join(REPO_ROOT, "apps", "polaris-web", "config", "user-map.json");
const DEMO_USER_ID = "100000000000000001";

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

async function withFakePath(commands: Record<string, string>, fn: () => Promise<void> | void): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-portal-"));
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

async function withSyntheticMemberUser(
  fn: (userId: string, workspace: string) => Promise<void>,
): Promise<void> {
  const userId = uniqueName("portal-member");
  const workspace = uniqueName("portal-member-workspace");
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);
  const workspaceRoot = path.join(REPO_ROOT, "config", "users", userId, "projects", workspace);
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(
    profilePath,
    yaml.dump({
      id: userId,
      name: "Portal Member",
      email: `${userId}@polaris.local`,
      workspaces: [workspace],
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
    await fn(userId, workspace);
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(path.join(REPO_ROOT, "config", "users", userId), {
      recursive: true,
      force: true,
    });
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
  const userId = DEMO_USER_ID;
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
  const userId = DEMO_USER_ID;

  await withPortalServer(async (baseUrl) => {
    const selfResponse = await fetch(`${baseUrl}/api/users/${userId}/workspaces`, {
    });
    assert.equal(selfResponse.status, 200);
    const selfPayload = await selfResponse.json() as { workspaces: Array<{ name: string }> };
    assert.ok(selfPayload.workspaces.some((workspace) => workspace.name === "demo"));

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

test("portal API previews credential asset content", async () => {
  const credentialId = uniqueName("portal-preview");
  const userId = DEMO_USER_ID;

  try {
    await withPortalServer(async (baseUrl) => {
      const createResponse = await fetch(
        `${baseUrl}/api/users/${userId}/credentials/create`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            credentialId,
            kind: "api-key",
            label: "Portal Preview Credential",
            purposes: "agent-auth",
            content: "{\"token\":\"preview-test\"}\n",
          }),
        },
      );
      assert.equal(createResponse.status, 200);

      const previewResponse = await fetch(
        `${baseUrl}/api/users/${userId}/credentials/preview?path=${encodeURIComponent(`credentials/generated/${credentialId}/auth.json`)}`,
      );
      assert.equal(previewResponse.status, 200);
      const preview = await previewResponse.json() as { path: string; content: string; truncated: boolean };
      assert.equal(preview.path, `credentials/generated/${credentialId}/auth.json`);
      assert.match(preview.content, /preview-test/);
      assert.equal(preview.truncated, false);
    });
  } finally {
    fs.rmSync(path.join(REPO_ROOT, "config", "users", userId, "credentials", `${credentialId}.yaml`), {
      force: true,
    });
    fs.rmSync(path.join(REPO_ROOT, "config", "users", userId, "credentials", "generated", credentialId), {
      recursive: true,
      force: true,
    });
  }
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

test("portal API returns workspace detail for a user-scoped workspace", async () => {
  await withPortalServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/users/${DEMO_USER_ID}/workspaces/demo`);
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      name: string;
      selectedDriver: { backend: string; profile?: string } | null;
      availableDrivers: Array<{ backend: string; available: boolean }>;
      credentialBindings: Array<{ purpose: string; credentialId: string }>;
    };
    assert.equal(payload.name, "demo");
    assert.ok(Array.isArray(payload.availableDrivers));
    assert.ok(payload.availableDrivers.some((driver) => driver.backend === "docker"));
    assert.ok(Array.isArray(payload.credentialBindings));
  });
});

test("portal API creates a user profile and Clerk mapping via the CLI-backed flow", async () => {
  const userProfileId = uniqueName("portal-user");
  const clerkUsername = uniqueName("clerk-user");
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const secretsRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;

  try {
    await withPortalServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
    assert.equal(fs.existsSync(path.join(secretsRoot, "credentials", "ssh", "id_ed25519")), true);
    assert.equal(fs.existsSync(path.join(secretsRoot, "credentials", "ssh", "id_ed25519.pub")), true);

    const userMap = JSON.parse(fs.readFileSync(USER_MAP_PATH, "utf8")) as {
      users?: Record<string, { polarisUserId: string; role: string; plan: string }>;
    };
    assert.equal(userMap.users?.[clerkUsername]?.polarisUserId, userProfileId);
    assert.equal(userMap.users?.[clerkUsername]?.role, "user");
    assert.equal(userMap.users?.[clerkUsername]?.plan, "free");
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(secretsRoot, { recursive: true, force: true });
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("portal API creates a user profile without a Clerk email by using a synthetic fallback email", async () => {
  const userProfileId = uniqueName("portal-no-email");
  const clerkUsername = uniqueName("clerk-no-email");
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const secretsRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;

  try {
    await withPortalServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
    assert.equal(fs.existsSync(path.join(secretsRoot, "credentials", "ssh", "id_ed25519")), true);
    assert.equal(fs.existsSync(path.join(secretsRoot, "credentials", "ssh", "id_ed25519.pub")), true);
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(secretsRoot, { recursive: true, force: true });
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("portal API deletes a user profile and its Clerk mapping", async () => {
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
      const response = await fetch(`${baseUrl}/api/users/${encodeURIComponent(userProfileId)}`, {
        method: "DELETE",
      });
      assert.equal(response.status, 200);
      const payload = await response.json() as {
        userProfile: { id: string; removed: boolean };
        mappings: { removedClerkUsernames: string[] };
      };
      assert.equal(payload.userProfile.id, userProfileId);
      assert.equal(payload.userProfile.removed, true);
      assert.deepEqual(payload.mappings.removedClerkUsernames, [clerkUsername]);
    });

    assert.equal(fs.existsSync(profilePath), false);
    assert.equal(fs.existsSync(userRoot), false);
    const userMap = fs.existsSync(USER_MAP_PATH)
      ? JSON.parse(fs.readFileSync(USER_MAP_PATH, "utf8")) as {
        users?: Record<string, { polarisUserId: string }>;
      }
      : { users: {} };
    assert.equal(userMap.users?.[clerkUsername], undefined);
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

test("portal API resolves Clerk username mappings from the live mapping file", async () => {
  const clerkUsername = uniqueName("clerk-map");
  const userProfileId = uniqueName("portal-map-user");
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userProfileId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userProfileId);
  const originalUserMap = fs.existsSync(USER_MAP_PATH) ? fs.readFileSync(USER_MAP_PATH, "utf8") : null;

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

    await withPortalServer(async (baseUrl) => {
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
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
    if (originalUserMap === null) {
      fs.rmSync(USER_MAP_PATH, { force: true });
    } else {
      fs.writeFileSync(USER_MAP_PATH, originalUserMap, "utf8");
    }
  }
});

test("portal API rejects conflicting Clerk username registrations", async () => {
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
      const payload = await response.json() as { error: string };
      assert.match(payload.error, /already mapped/i);
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

test("portal API provisions a new workspace through the CLI-backed scaffold flow", async () => {
  const userId = uniqueName("portal-workspace-user");
  const workspace = uniqueName("portal-create");
  const workspaceRoot = path.join(REPO_ROOT, "config", "users", userId, "projects", workspace);
  const profileFile = path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);
  const userRoot = path.join(REPO_ROOT, "config", "users", userId);
  const codexAuth = path.join(userRoot, "credentials", "codex", "auth.json");
  const codexConfig = path.join(userRoot, "credentials", "codex", "config.toml");
  const claudeSettings = path.join(userRoot, "credentials", "claude", "settings.json");
  const privateKey = path.join(userRoot, "credentials", "ssh", "id_ed25519");
  const publicKey = path.join(userRoot, "credentials", "ssh", "id_ed25519.pub");
  try {
    await createUserCommand([userId, "--name", "Portal Workspace User", "--email", `${userId}@polaris.local`]);
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

    await withFakePath(
      {
        docker: "#!/bin/sh\nif [ \"$1\" = \"image\" ] && [ \"$2\" = \"inspect\" ]; then exit 0; fi\nif [ \"$1\" = \"pull\" ]; then exit 0; fi\nexit 0\n",
      },
      async () => {
        await withPortalServer(async (baseUrl) => {
          const response = await fetch(`${baseUrl}/api/users/${userId}/workspaces`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceName: workspace }),
          });
          const bodyText = await response.text();
          assert.equal(response.status, 202, bodyText);
          const payload = JSON.parse(bodyText) as { workspace: string; done: boolean };
          assert.equal(payload.workspace, workspace);
          assert.equal(payload.done, true);
        });
      },
    );

    assert.equal(fs.existsSync(path.join(workspaceRoot, "docker.agent.yaml")), true);
    assert.equal(fs.existsSync(path.join(workspaceRoot, "pod.agent.yaml")), true);
    assert.equal(fs.existsSync(path.join(workspaceRoot, "kubevirt.agent.yaml")), true);

    const profileAfter = (yaml.load(fs.readFileSync(profileFile, "utf8")) ?? {}) as { workspaces?: string[] };
    assert.ok(profileAfter.workspaces?.includes(workspace));
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    clearWorkspaceProvisionProgress(userId, workspace);
    fs.rmSync(codexAuth, { force: true });
    fs.rmSync(codexConfig, { force: true });
    fs.rmSync(claudeSettings, { force: true });
    fs.rmSync(privateKey, { force: true });
    fs.rmSync(publicKey, { force: true });
    fs.rmSync(profileFile, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("portal API stops the selected workspace driver", async () => {
  const userId = uniqueName("portal-stop-user");
  const workspace = uniqueName("portal-stop");
  const userRoot = path.join(REPO_ROOT, "config", "users", userId);
  const workspaceRoot = path.join(userRoot, "projects", workspace);
  const profilePath = path.join(REPO_ROOT, "config", "users", "profiles", `${userId}.yaml`);
  const codexAuth = path.join(userRoot, "credentials", "codex", "auth.json");
  const codexConfig = path.join(userRoot, "credentials", "codex", "config.toml");
  const claudeSettings = path.join(userRoot, "credentials", "claude", "settings.json");
  const privateKey = path.join(userRoot, "credentials", "ssh", "id_ed25519");
  const publicKey = path.join(userRoot, "credentials", "ssh", "id_ed25519.pub");

  try {
    await createUserCommand([userId, "--name", "Portal Stop User", "--email", `${userId}@polaris.local`]);
    await createCommand([workspace, "--user", userId]);
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
    writeWorkspaceDriverSelection(workspace, { backend: "docker" }, userId);

    await withFakePath(
      {
        docker: "#!/bin/sh\nexit 0\n",
      },
      async () => {
        await withPortalServer(async (baseUrl) => {
          const response = await fetch(
            `${baseUrl}/api/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspace)}/stop`,
            { method: "POST" },
          );
          const bodyText = await response.text();
          assert.equal(response.status, 200, bodyText);
          const payload = JSON.parse(bodyText) as { stopped: boolean };
          assert.equal(payload.stopped, true);
        });
      },
    );
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(userRoot, { recursive: true, force: true });
    fs.rmSync(privateKey, { force: true });
    fs.rmSync(publicKey, { force: true });
  }
});

test("portal API deletes a stopped workspace and removes it from the profile index", async () => {
  const userId = DEMO_USER_ID;
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
    await withSyntheticMemberUser(async (userId) => {
      await withPortalServer(async (baseUrl) => {
        const ownResponse = await fetch(`${baseUrl}/api/users/${userId}/workspaces`, {
          headers: {
            "x-polaris-auth-shared-secret": "test-secret",
            "x-polaris-user-id": userId,
            "x-polaris-user-role": "user",
            "x-polaris-user-email": `${userId}@polaris.local`,
            "x-polaris-user-plan": "free",
          },
        });
        assert.equal(ownResponse.status, 200);

        const crossResponse = await fetch(`${baseUrl}/api/users/${DEMO_USER_ID}/workspaces`, {
          headers: {
            "x-polaris-auth-shared-secret": "test-secret",
            "x-polaris-user-id": userId,
            "x-polaris-user-role": "user",
            "x-polaris-user-email": `${userId}@polaris.local`,
            "x-polaris-user-plan": "free",
          },
        });
        assert.equal(crossResponse.status, 403);
      });
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
