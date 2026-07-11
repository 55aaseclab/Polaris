import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import yaml from "js-yaml";
import { createUserCommand } from "../scripts/cli/commands/create-user.js";
import { scaffoldDockerWorkspace } from "../scripts/config/scaffold.js";
import { loadWorkspaceFromConfigPath } from "../scripts/config/load.js";
import { deletePortalUser, getPortalAiAccess, listUserPortalCredentials, performPortalAiAccessAction } from "../scripts/portal/service.js";
import {
  clearPortalAiAccessStateForTest,
  writePortalAiAccessStateForTest,
} from "../scripts/portal/ai-access.js";

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

async function withEnv(
  updates: Record<string, string | undefined>,
  task: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await task();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function userProfilePath(userId: string): string {
  return path.resolve("..", "..", "config", "users", "profiles", `${userId}.yaml`);
}

test("AI access starts as not provisioned and moves to funding needed after provisioning", async () => {
  const userId = uniqueName("ai-access-provision");
  await createUserCommand([userId, "--name", "AI Access User", "--email", `${userId}@polaris.local`]);
  try {
    const initial = await getPortalAiAccess(userId);
    assert.equal(initial.state, "not_provisioned");
    assert.equal(initial.mainAction.primaryAction.kind, "provision_access");

    const provisioned = await performPortalAiAccessAction({
      userId,
      action: "provision_access",
    });
    assert.equal(provisioned.state, "funding_needed");
    assert.equal(provisioned.mainAction.primaryAction.kind, "top_up");
  } finally {
    clearPortalAiAccessStateForTest(userId);
    await deletePortalUser(userId);
  }
});

test("AI access top-up makes funded users ready and auto-creates runtime credentials", async () => {
  const userId = uniqueName("ai-access-ready");
  await createUserCommand([userId, "--name", "AI Access Ready User", "--email", `${userId}@polaris.local`]);
  try {
    await performPortalAiAccessAction({
      userId,
      action: "provision_access",
    });
    const funded = await performPortalAiAccessAction({
      userId,
      action: "top_up",
    });

    assert.equal(funded.state, "ready");
    assert.equal(funded.advanced.credentialSyncStatus, "ready");
    assert.equal(funded.mainAction.primaryAction.kind, "top_up");

    const credentials = listUserPortalCredentials(userId);
    assert.ok(
      credentials.some((credential) =>
        credential.harness === "codex" && credential.active,
      ),
    );
  } finally {
    clearPortalAiAccessStateForTest(userId);
    await deletePortalUser(userId);
  }
});

test("AI access surfaces automatic setup failures as error state", async () => {
  const userId = uniqueName("ai-access-error");
  await createUserCommand([userId, "--name", "AI Access Error User", "--email", `${userId}@polaris.local`]);
  try {
    await performPortalAiAccessAction({
      userId,
      action: "provision_access",
    });
    writePortalAiAccessStateForTest(userId, {
      simulateSetupFailure: true,
    });

    const errored = await performPortalAiAccessAction({
      userId,
      action: "top_up",
    });
    assert.equal(errored.state, "error");
    assert.equal(errored.mainAction.primaryAction.kind, "retry");
    assert.match(
      errored.advanced.lastErrorMessage ?? "",
      /runtime setup failure/i,
    );
  } finally {
    clearPortalAiAccessStateForTest(userId);
    await deletePortalUser(userId);
  }
});

test("user creation stores the referral code in the profile", async () => {
  const userId = uniqueName("portal-referral-profile");
  await createUserCommand([
    userId,
    "--name",
    "Referral Profile User",
    "--email",
    `${userId}@polaris.local`,
    "--referred-by-code",
    "AFF-CODE-123",
  ]);
  try {
    const profile = yaml.load(fs.readFileSync(userProfilePath(userId), "utf8")) as Record<string, unknown>;
    const referral = profile.referral as Record<string, unknown> | undefined;
    assert.equal(referral?.referred_by_code, "AFF-CODE-123");
    assert.equal(typeof referral?.captured_at, "string");
  } finally {
    await deletePortalUser(userId);
  }
});

test("new-api provisioning registers invited users with the stored affiliate code", async () => {
  const userId = uniqueName("ai-access-referral");
  await createUserCommand([
    userId,
    "--name",
    "AI Access Referral User",
    "--email",
    `${userId}@polaris.local`,
  ]);

  let registerAffCode = "";
  let registeredUsername = "";
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : {};

    if (req.url === "/api/setup" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { status: true } }));
      return;
    }
    if (req.url === "/api/user/register" && req.method === "POST") {
      registerAffCode = String(body.aff_code ?? "");
      registeredUsername = String(body.username ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { ok: true } }));
      return;
    }
    if (req.url === "/api/user/login" && req.method === "POST") {
      const username = String(body.username ?? "");
      const isAdmin = username === "polarisroot";
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": [`session=${isAdmin ? "admin" : "user"}; Path=/; HttpOnly`],
      });
      res.end(JSON.stringify({
        success: true,
        data: {
          id: isAdmin ? 1 : 42,
          username,
        },
      }));
      return;
    }
    if (req.url === "/api/user/token" && req.method === "GET") {
      const userHeader = req.headers["new-api-user"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        data: Number(userHeader) === 1 ? "admin-token" : "user-token",
      }));
      return;
    }
    if (req.url === "/api/user/42" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        data: {
          id: 42,
          username: registeredUsername,
        },
      }));
      return;
    }
    if (req.url === "/api/user/self" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        data: {
          id: 42,
          quota: 0,
          aff_code: "SELF-AFF-42",
          aff_quota: 0,
        },
      }));
      return;
    }
    if (req.url === "/api/user/aff" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        data: "SELF-AFF-42",
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: false, message: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    await withEnv({
      POLARIS_AI_ACCESS_PROVIDER_BACKEND: "new-api",
      POLARIS_AI_ACCESS_NEW_API_BASE_URL: `http://127.0.0.1:${address.port}`,
      POLARIS_AI_ACCESS_NEW_API_ADMIN_USERNAME: "polarisroot",
      POLARIS_AI_ACCESS_NEW_API_ADMIN_PASSWORD: "Polaris123",
      VITE_CLERK_SIGN_UP_URL: "http://register.example/sign-up/",
      POLARIS_PUBLIC_BASE_URL: "http://polaris.example",
    }, async () => {
      const profile = yaml.load(fs.readFileSync(userProfilePath(userId), "utf8")) as Record<string, unknown>;
      const referral = typeof profile.referral === "object" && profile.referral
        ? { ...(profile.referral as Record<string, unknown>) }
        : {};
      referral.referred_by_code = "INVITER-NEWAPI-CODE";
      delete referral.ai_access_applied_at;
      profile.referral = referral;
      fs.writeFileSync(userProfilePath(userId), yaml.dump(profile, { lineWidth: 120, noRefs: true }), "utf8");
      const aiAccessModule = await import(
        new URL(`../scripts/portal/ai-access.ts?referral=${Date.now()}`, import.meta.url).href
      );
      await aiAccessModule.provisionPortalAiAccessDefaultCredential(userId);
      assert.equal(registerAffCode, "INVITER-NEWAPI-CODE");
      const provisioned = await aiAccessModule.getPortalAiAccess(userId);
      assert.equal(provisioned.state, "funding_needed");
      assert.equal(provisioned.referral.inviteCode, "SELF-AFF-42");
      assert.equal(
        provisioned.referral.inviteLink,
        "http://register.example/sign-up/?invite=SELF-AFF-42&redirect_url=http%3A%2F%2Fpolaris.example%2F%3Finvite%3DSELF-AFF-42",
      );

      const updatedProfile = yaml.load(fs.readFileSync(userProfilePath(userId), "utf8")) as Record<string, unknown>;
      const updatedReferral = updatedProfile.referral as Record<string, unknown> | undefined;
      assert.equal(typeof updatedReferral?.ai_access_applied_at, "string");

      const credentials = listUserPortalCredentials(userId);
      const defaultCredential = credentials.find((credential) => credential.id === "codex-new-api");
      assert.ok(defaultCredential);
      assert.equal(defaultCredential?.active, true);
      assert.equal(defaultCredential?.providerName, "openai");

      const workspaceConfigPath = scaffoldDockerWorkspace(
        `ai-access-default-${Date.now()}`,
        userId,
      );
      const workspace = loadWorkspaceFromConfigPath(workspaceConfigPath);
      const agentBinding = workspace.resolvedCredentialBindings.find((binding) => binding.purpose === "agent-auth");
      assert.equal(agentBinding?.credentialId, "codex-new-api");

      aiAccessModule.clearPortalAiAccessStateForTest(userId);
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(path.resolve("..", "..", "config", "users", userId, "workspaces"), {
      recursive: true,
      force: true,
    });
    await deletePortalUser(userId);
  }
});
