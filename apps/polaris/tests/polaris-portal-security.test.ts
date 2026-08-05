import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createPortalServer } from "../scripts/portal/server.js";
import { scaffoldUserProfileById } from "../scripts/config/scaffold.js";
import {
  deleteUserMapEntriesForPolarisUserId,
  upsertUserMapEntry,
} from "../scripts/portal/user-map.js";
import { polarisUsersRoot } from "../scripts/utils/paths.js";

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

function setEnv(name: string, value: string): () => void {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

test("portal exposes unauthenticated Polaris liveness and readiness probes", async () => {
  const portal = createPortalServer(0);
  await once(portal, "listening");
  const address = portal.address();
  if (!address || typeof address === "string") {
    throw new Error("Portal server did not expose a TCP address");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(`${origin}/healthz`, {
      headers: { cookie: "synthetic-session=ignored" },
    });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      service: "polaris-portal",
      status: "ok",
    });

    const readiness = await fetch(`${origin}/readyz`);
    assert.equal(readiness.status, 200);
    assert.deepEqual(await readiness.json(), {
      service: "polaris-portal",
      status: "ready",
    });

    const head = await fetch(`${origin}/healthz`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  } finally {
    portal.close();
    await once(portal, "close");
  }
});

test("portal restricts CORS and rejects cookie-backed cross-origin mutations", async () => {
  const userId = uniqueName("portal-csrf-user");
  const userRoot = polarisUsersRoot(import.meta.url);
  const restores = [
    setEnv("POLARIS_AUTH_MODE", "oauth2-proxy"),
    setEnv("POLARIS_PORTAL_ALLOWED_ORIGINS", ""),
    setEnv("POLARIS_PORTAL_ORIGIN", ""),
  ];
  let portal: ReturnType<typeof createPortalServer> | null = null;
  try {
    scaffoldUserProfileById({
      id: userId,
      name: "Portal CSRF User",
      email: "portal-csrf@example.test",
    });
    await upsertUserMapEntry(userId, {
      polarisUserId: userId,
      role: "user",
      plan: "pro",
      line: "vertical",
    });

    portal = createPortalServer(0);
    await once(portal, "listening");
    const address = portal.address();
    if (!address || typeof address === "string") {
      throw new Error("Portal did not expose a TCP address");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const cookie = "_oauth2_proxy=synthetic-session";
    const authHeaders = {
      cookie,
      "x-auth-request-user": userId,
    };

    const allowedPreflight = await fetch(`${origin}/api/session`, {
      method: "OPTIONS",
      headers: { origin },
    });
    assert.equal(allowedPreflight.status, 204);
    assert.equal(allowedPreflight.headers.get("access-control-allow-origin"), origin);

    const rejectedPreflight = await fetch(`${origin}/api/session`, {
      method: "OPTIONS",
      headers: { origin: "https://attacker.example.test" },
    });
    assert.equal(rejectedPreflight.status, 403);
    assert.equal(rejectedPreflight.headers.get("access-control-allow-origin"), null);

    const rejectedMutation = await fetch(`${origin}/api/wanghai/missing/launch`, {
      method: "POST",
      headers: {
        ...authHeaders,
        origin: "https://attacker.example.test",
      },
    });
    assert.equal(rejectedMutation.status, 403);
    assert.match(await rejectedMutation.text(), /CSRF/i);

    const sameOriginMutation = await fetch(`${origin}/api/wanghai/missing/launch`, {
      method: "POST",
      headers: {
        ...authHeaders,
        origin,
      },
    });
    assert.equal(sameOriginMutation.status, 404);

    const oversizedBody = await fetch(`${origin}/api/auth/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "x".repeat(1_048_576) }),
    });
    assert.equal(oversizedBody.status, 413);
  } finally {
    if (portal) {
      portal.close();
      await once(portal, "close");
    }
    await deleteUserMapEntriesForPolarisUserId(userId);
    fs.rmSync(path.join(userRoot, userId), { recursive: true, force: true });
    fs.rmSync(path.join(userRoot, "profiles", `${userId}.yaml`), { force: true });
    for (const restore of restores.reverse()) restore();
  }
});

test("portal detects Authing cookies after another cookie during CSRF checks", async () => {
  const userId = uniqueName("portal-authing-csrf-user");
  const userRoot = polarisUsersRoot(import.meta.url);
  const restores = [
    setEnv("POLARIS_AUTH_MODE", "authing"),
    setEnv("POLARIS_PORTAL_ALLOWED_ORIGINS", "https://polaris.example.test"),
    setEnv("POLARIS_PORTAL_ORIGIN", ""),
  ];
  let portal: ReturnType<typeof createPortalServer> | null = null;
  try {
    scaffoldUserProfileById({
      id: userId,
      name: "Portal Authing CSRF User",
      email: "portal-authing-csrf@example.test",
    });
    await upsertUserMapEntry(userId, {
      polarisUserId: userId,
      role: "user",
      plan: "pro",
      line: "vertical",
    });

    portal = createPortalServer(0);
    await once(portal, "listening");
    const address = portal.address();
    if (!address || typeof address === "string") {
      throw new Error("Portal did not expose a TCP address");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${origin}/api/wanghai/missing/launch`, {
      method: "POST",
      headers: {
        cookie: `unrelated=1; polaris_authing_session=synthetic-session`,
        origin: "https://attacker.example.test",
      },
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /CSRF/u);
  } finally {
    if (portal) {
      portal.close();
      await once(portal, "close");
    }
    await deleteUserMapEntriesForPolarisUserId(userId);
    fs.rmSync(path.join(userRoot, userId), { recursive: true, force: true });
    fs.rmSync(path.join(userRoot, "profiles", `${userId}.yaml`), { force: true });
    for (const restore of restores.reverse()) restore();
  }
});
