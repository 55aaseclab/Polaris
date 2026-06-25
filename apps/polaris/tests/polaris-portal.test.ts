import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
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

test("portal root redirects to the first available user workspace", async () => {
  await withPortalServer(async (baseUrl) => {
    const response = await fetch(baseUrl, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/users/100000000000000001/workspaces");
  });
});
