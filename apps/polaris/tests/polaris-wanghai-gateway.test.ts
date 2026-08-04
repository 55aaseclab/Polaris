import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import { createPortalServer } from "../scripts/portal/server.js";
import {
  scaffoldDockerVault,
  scaffoldUserProfileById,
  vaultConfigPath,
} from "../scripts/config/scaffold.js";
import { ensureVaultConfig } from "../scripts/config/provision.js";
import { createManagedSshCredential } from "../scripts/config/credentials.js";
import {
  vaultPaseoStateDir,
  writeVaultStatus,
} from "../scripts/output/state-store.js";
import {
  deleteUserMapEntriesForPolarisUserId,
  updateUserAccessEntry,
  upsertUserMapEntry,
} from "../scripts/portal/user-map.js";
import { polarisUsersRoot } from "../scripts/utils/paths.js";
import { verifyWanghaiAssertion } from "../scripts/security/wanghai-assertions.js";
import { deriveWanghaiVaultAssertionSecret } from "../scripts/security/wanghai-assertions.js";
import { closePolarisControlStore } from "../scripts/portal/control-store.js";

const USER_ROOT = polarisUsersRoot(import.meta.url);
const masterSecret = "0123456789abcdef0123456789abcdef";

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

async function closeServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  server.close();
  await once(server, "close");
}

function setEnv(name: string, value: string): () => void {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

async function requestPortalHost(input: {
  port: number;
  path: string;
  method?: string;
  headers: Record<string, string>;
}): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: input.port,
      path: input.path,
      method: input.method ?? "GET",
      headers: input.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

test("Polaris gateway issues a scoped session, proxies assertions, and blocks bypasses", async () => {
  const userA = uniqueName("gateway-user-a");
  const userB = uniqueName("gateway-user-b");
  const vault = uniqueName("gateway-vault");
  const serverId = "srv_gateway_synthetic";
  const controlStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-gateway-store-"));
  const restores = [
    setEnv("POLARIS_AUTH_MODE", "disabled"),
    setEnv("POLARIS_AUTH_DEFAULT_USER_ID", userA),
    setEnv("POLARIS_AUTH_DEFAULT_ROLE", "user"),
    setEnv("POLARIS_AUTH_DEFAULT_PLAN", "pro"),
    setEnv("POLARIS_WANGHAI_GATEWAY_MASTER_SECRET", masterSecret),
    setEnv("POLARIS_WANGHAI_RATE_LIMIT_READS_PER_MINUTE", "1"),
    setEnv("POLARIS_CONTROL_STORE_PATH", path.join(controlStoreRoot, "control.sqlite")),
  ];
  let assertionHeader = "";
  let requestIdHeader = "";
  let upstreamRequests = 0;
  const upstream = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    upstreamRequests += 1;
    assertionHeader = String(req.headers["x-polaris-wanghai-assertion"] ?? "");
    requestIdHeader = String(req.headers["x-polaris-request-id"] ?? "");
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "surface-session=must-not-reach-the-gateway-host",
    });
    res.end(JSON.stringify({ upstream: true }));
  });
  let portal: ReturnType<typeof createPortalServer> | null = null;
  try {
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("Test upstream did not expose a TCP address");
    }

    scaffoldUserProfileById({
      id: userA,
      name: "Gateway User A",
      email: "gateway-a@example.test",
    });
    createManagedSshCredential({
      userProfileId: userA,
      credentialId: "gateway-ssh",
      label: "Gateway SSH",
      activate: true,
    });
    scaffoldDockerVault(vault, userA, { line: "vertical" });
    await upsertUserMapEntry(userA, {
      polarisUserId: userA,
      role: "user",
      plan: "pro",
      line: "vertical",
    });
    await upsertUserMapEntry(userB, {
      polarisUserId: userB,
      role: "user",
      plan: "pro",
      line: "vertical",
    });
    const configPath = vaultConfigPath(vault, "docker", userA);
    const config = (yaml.load(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<string, any>;
    const wanghaiPort = config.service?.ports?.find((port: Record<string, unknown>) => port.name === "wanghai");
    if (!wanghaiPort) throw new Error("Test Wanghai port was not scaffolded");
    wanghaiPort.node_port = String(upstreamAddress.port);
    fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: 120, noRefs: true }), "utf8");
    const paseoState = vaultPaseoStateDir(vault, userA);
    fs.mkdirSync(paseoState, { recursive: true });
    fs.writeFileSync(path.join(paseoState, "server-id"), `${serverId}\n`, "utf8");
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
    }, userA);

    portal = createPortalServer(0);
    await once(portal, "listening");
    const portalAddress = portal.address();
    if (!portalAddress || typeof portalAddress === "string") {
      throw new Error("Test portal did not expose a TCP address");
    }
    restores.push(
      setEnv(
        "POLARIS_WANGHAI_GATEWAY_ORIGIN",
        `http://gateway.localhost:${portalAddress.port}`,
      ),
    );

    const launchResponse = await fetch(
      `http://127.0.0.1:${portalAddress.port}/api/wanghai/${serverId}/launch`,
      { method: "POST", headers: { origin: `http://127.0.0.1:${portalAddress.port}` } },
    );
    assert.equal(launchResponse.status, 200);
    const launch = await launchResponse.json() as { portalUrl: string };
    const launchUrl = new URL(launch.portalUrl);
    assert.match(launchUrl.hostname, /^v-[a-f0-9]{24}\.gateway\.localhost$/u);

    const ticketResponse = await requestPortalHost({
      port: portalAddress.port,
      path: `${launchUrl.pathname}${launchUrl.search}`,
      headers: { host: launchUrl.host },
    });
    assert.equal(ticketResponse.statusCode, 302);
    const cookie = (ticketResponse.headers["set-cookie"] as string[] | undefined)?.[0]?.split(";", 1)[0];
    assert.ok(cookie);

    const replayedTicket = await requestPortalHost({
      port: portalAddress.port,
      path: `${launchUrl.pathname}${launchUrl.search}`,
      headers: { host: launchUrl.host },
    });
    assert.equal(replayedTicket.statusCode, 401);

    const nextLaunchResponse = await fetch(
      `http://127.0.0.1:${portalAddress.port}/api/wanghai/${serverId}/launch`,
      { method: "POST", headers: { origin: `http://127.0.0.1:${portalAddress.port}` } },
    );
    assert.equal(nextLaunchResponse.status, 200);
    const nextLaunch = await nextLaunchResponse.json() as { portalUrl: string };
    assert.notEqual(nextLaunch.portalUrl, launch.portalUrl);

    const proxied = await requestPortalHost({
      port: portalAddress.port,
      path: "/api/workspaces",
      headers: { host: launchUrl.host, cookie: cookie! },
    });
    assert.equal(proxied.statusCode, 200);
    assert.deepEqual(JSON.parse(proxied.body), { upstream: true });
    assert.equal(proxied.headers["set-cookie"], undefined);
    const assertionSecret = deriveWanghaiVaultAssertionSecret(masterSecret, userA, vault);
    const assertion = verifyWanghaiAssertion(assertionHeader, assertionSecret);
    assert.equal(assertion.tenant_id, userA);
    assert.equal(requestIdHeader, assertion.request_id);

    const absoluteFormAttempt = await requestPortalHost({
      port: portalAddress.port,
      path: `http://127.0.0.1:${upstreamAddress.port}/exfiltrate`,
      method: "POST",
      headers: {
        host: launchUrl.host,
        cookie: cookie!,
        origin: `http://${launchUrl.host}`,
      },
    });
    assert.equal(absoluteFormAttempt.statusCode, 400);
    assert.match(absoluteFormAttempt.body, /Invalid Wanghai gateway request path/u);
    assert.equal(upstreamRequests, 1);

    const rateLimited = await requestPortalHost({
      port: portalAddress.port,
      path: "/api/workspaces",
      headers: { host: launchUrl.host, cookie: cookie! },
    });
    assert.equal(rateLimited.statusCode, 429);
    assert.equal(rateLimited.headers["ratelimit-limit"], "1");
    assert.equal(rateLimited.headers["ratelimit-remaining"], "0");
    assert.equal(upstreamRequests, 1);

    const csrfAttempt = await requestPortalHost({
      port: portalAddress.port,
      path: "/api/workspaces",
      method: "POST",
      headers: { host: launchUrl.host, cookie: cookie! },
    });
    assert.equal(csrfAttempt.statusCode, 403);

    // A retained Docker configuration must not keep Wanghai available after
    // Polaris selects a different runtime that does not expose the surface.
    ensureVaultConfig(`${vault}@pod:gvisor`, userA);
    const podConfigPath = vaultConfigPath(vault, "pod", userA);
    const podConfig = (yaml.load(fs.readFileSync(podConfigPath, "utf8")) ?? {}) as Record<string, any>;
    podConfig.service = {
      ...(podConfig.service ?? {}),
      ports: (podConfig.service?.ports ?? []).filter(
        (port: Record<string, unknown>) => port.name !== "wanghai",
      ),
    };
    fs.writeFileSync(podConfigPath, yaml.dump(podConfig, { lineWidth: 120, noRefs: true }), "utf8");
    writeVaultStatus({
      schemaVersion: 1.1,
      project: vault,
      driver: {
        selected: { backend: "pod", profile: "gvisor" },
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
    }, userA);
    const selectedRuntimeLaunch = await fetch(
      `http://127.0.0.1:${portalAddress.port}/api/wanghai/${serverId}/launch`,
      { method: "POST", headers: { origin: `http://127.0.0.1:${portalAddress.port}` } },
    );
    assert.equal(selectedRuntimeLaunch.status, 404);
    assert.equal(upstreamRequests, 1);

    process.env.POLARIS_AUTH_DEFAULT_USER_ID = userB;
    const crossTenantLaunch = await fetch(
      `http://127.0.0.1:${portalAddress.port}/api/wanghai/${serverId}/launch`,
      { method: "POST", headers: { origin: `http://127.0.0.1:${portalAddress.port}` } },
    );
    assert.equal(crossTenantLaunch.status, 404);

    await updateUserAccessEntry(userA, { line: "coding" });
    const revokedSession = await requestPortalHost({
      port: portalAddress.port,
      path: "/api/workspaces",
      headers: { host: launchUrl.host, cookie: cookie! },
    });
    assert.equal(revokedSession.statusCode, 403);
    assert.equal(upstreamRequests, 1);
  } finally {
    if (portal) await closeServer(portal);
    await closeServer(upstream);
    await deleteUserMapEntriesForPolarisUserId(userA);
    await deleteUserMapEntriesForPolarisUserId(userB);
    fs.rmSync(path.join(USER_ROOT, userA), { recursive: true, force: true });
    fs.rmSync(path.join(USER_ROOT, "profiles", `${userA}.yaml`), { force: true });
    closePolarisControlStore();
    fs.rmSync(controlStoreRoot, { recursive: true, force: true });
    for (const restore of restores.reverse()) restore();
  }
});
