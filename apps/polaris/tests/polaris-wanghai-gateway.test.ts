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
import { listPortalVaults } from "../scripts/portal/service.js";
import {
  scaffoldDockerVault,
  scaffoldUserProfileById,
  vaultConfigPath,
} from "../scripts/config/scaffold.js";
import { ensureVaultConfig } from "../scripts/config/provision.js";
import { createManagedSshCredential } from "../scripts/config/credentials.js";
import {
  writeVaultStatus,
} from "../scripts/output/state-store.js";
import { wanghaiGatewayId } from "../scripts/core/portal.js";
import {
  deleteUserMapEntriesForPolarisUserId,
  updateUserAccessEntry,
  upsertUserMapEntry,
} from "../scripts/portal/user-map.js";
import { polarisUsersRoot } from "../scripts/utils/paths.js";
import { verifyWanghaiAssertion } from "../scripts/security/wanghai-assertions.js";
import { deriveWanghaiVaultAssertionSecret } from "../scripts/security/wanghai-assertions.js";
import {
  closePolarisControlStore,
  getPolarisControlStore,
} from "../scripts/portal/control-store.js";

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
  body?: string | Buffer;
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
    if (input.body !== undefined) request.write(input.body);
    request.end();
  });
}

test("Polaris gateway issues a scoped session, proxies assertions, and blocks bypasses", async () => {
  const userA = uniqueName("gateway-user-a");
  const userB = uniqueName("gateway-user-b");
  const vault = uniqueName("gateway-vault");
  const wanghaiId = wanghaiGatewayId(userA, vault);
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
  let quotaMeasurementAssertion = "";
  let quotaMeasurementRequestId = "";
  let upstreamBody = "";
  let upstreamRequests = 0;
  let quotaMeasurementRequests = 0;
  let workspaceUsageBytes = 1_024;
  const upstream = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/wanghai/api/internal/workspace-usage") {
      quotaMeasurementRequests += 1;
      quotaMeasurementAssertion = String(req.headers["x-polaris-wanghai-assertion"] ?? "");
      quotaMeasurementRequestId = String(req.headers["x-polaris-request-id"] ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        schema_version: 1,
        category: "active_workspace",
        usage_bytes: workspaceUsageBytes,
        file_count: 1,
        entry_count: 1,
      }));
      return;
    }
    upstreamRequests += 1;
    assert.match(String(req.url ?? ""), /^\/wanghai\//u);
    assertionHeader = String(req.headers["x-polaris-wanghai-assertion"] ?? "");
    requestIdHeader = String(req.headers["x-polaris-request-id"] ?? "");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      upstreamBody = Buffer.concat(chunks).toString("utf8");
      if (req.method === "POST") workspaceUsageBytes = 2_048;
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "surface-session=must-not-reach-the-gateway-host",
      });
      res.end(JSON.stringify({ upstream: true }));
    });
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
    scaffoldDockerVault(vault, userA, {
      line: "vertical",
      paseoFreeWanghaiTest: true,
    });
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

    const summary = (await listPortalVaults(userA)).find((entry) => entry.name === vault);
    assert.equal(summary?.serverId, null);
    assert.equal(summary?.wanghaiId, wanghaiId);

    portal = createPortalServer(0);
    await once(portal, "listening");
    const portalAddress = portal.address();
    if (!portalAddress || typeof portalAddress === "string") {
      throw new Error("Test portal did not expose a TCP address");
    }
    restores.push(
      setEnv(
        "POLARIS_WANGHAI_GATEWAY_ORIGIN",
        `http://127.0.0.1:${portalAddress.port}`,
      ),
    );

    const launchResponse = await fetch(
      `http://127.0.0.1:${portalAddress.port}/api/g/${wanghaiId}/launch`,
      { method: "POST", headers: { origin: `http://127.0.0.1:${portalAddress.port}` } },
    );
    assert.equal(launchResponse.status, 200);
    const launch = await launchResponse.json() as { portalUrl: string };
    const launchUrl = new URL(launch.portalUrl);
    assert.equal(launchUrl.hostname, "127.0.0.1");
    assert.equal(launchUrl.pathname, "/g/");

    const ticketResponse = await requestPortalHost({
      port: portalAddress.port,
      path: `${launchUrl.pathname}${launchUrl.search}`,
      headers: { host: launchUrl.host },
    });
    assert.equal(ticketResponse.statusCode, 302);
    const sessionCookies = ticketResponse.headers["set-cookie"] as string[] | undefined;
    const cookie = sessionCookies?.[0]?.split(";", 1)[0];
    assert.ok(cookie);
    assert.match(
      String(sessionCookies?.[0] ?? ""),
      /Path=\/g(?:;|$)/u,
    );
    assert.ok(sessionCookies?.some((value) => /Path=\/wanghai(?:;|$)/u.test(value)));
    assert.equal(ticketResponse.headers.location, "/g/");

    const replayedTicket = await requestPortalHost({
      port: portalAddress.port,
      path: `${launchUrl.pathname}${launchUrl.search}`,
      headers: { host: launchUrl.host },
    });
    assert.equal(replayedTicket.statusCode, 401);

    const nextLaunchResponse = await fetch(
      `http://127.0.0.1:${portalAddress.port}/api/g/${wanghaiId}/launch`,
      { method: "POST", headers: { origin: `http://127.0.0.1:${portalAddress.port}` } },
    );
    assert.equal(nextLaunchResponse.status, 200);
    const nextLaunch = await nextLaunchResponse.json() as { portalUrl: string };
    assert.notEqual(nextLaunch.portalUrl, launch.portalUrl);

    const proxied = await requestPortalHost({
      port: portalAddress.port,
      path: "/g/api/workspaces",
      headers: { host: launchUrl.host, cookie: cookie! },
    });
    assert.equal(proxied.statusCode, 200);
    assert.deepEqual(JSON.parse(proxied.body), { upstream: true });
    assert.equal(proxied.headers["set-cookie"], undefined);
    const assertionSecret = deriveWanghaiVaultAssertionSecret(masterSecret, userA, vault);
    const assertion = verifyWanghaiAssertion(assertionHeader, assertionSecret);
    assert.equal(assertion.tenant_id, userA);
    assert.equal(requestIdHeader, assertion.request_id);

    const missingIdempotency = await requestPortalHost({
      port: portalAddress.port,
      path: "/g/api/workspaces",
      method: "POST",
      headers: {
        host: launchUrl.host,
        cookie: cookie!,
        origin: `http://${launchUrl.host}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspace_id: "synthetic-workspace", workspace_type: "research" }),
    });
    assert.equal(missingIdempotency.statusCode, 428);
    assert.equal(upstreamRequests, 1);

    const mutation = await requestPortalHost({
      port: portalAddress.port,
      path: "/g/api/workspaces",
      method: "POST",
      headers: {
        host: launchUrl.host,
        cookie: cookie!,
        origin: `http://${launchUrl.host}`,
        "content-type": "application/json",
        "idempotency-key": "workspace-create-001",
      },
      body: JSON.stringify({ workspace_id: "synthetic-workspace", workspace_type: "research" }),
    });
    assert.equal(mutation.statusCode, 200);
    assert.equal(upstreamBody, JSON.stringify({ workspace_id: "synthetic-workspace", workspace_type: "research" }));
    const mutationRequestId = String(mutation.headers["x-polaris-request-id"] ?? "");
    const mutationAssertion = verifyWanghaiAssertion(assertionHeader, assertionSecret);
    assert.ok(mutationAssertion.admission);
    assert.equal(mutationAssertion.admission.action, "workspace.create");
    assert.equal(mutationAssertion.admission.workspace_id, "synthetic-workspace");
    assert.equal(mutationAssertion.admission.idempotency_key, "workspace-create-001");
    assert.match(mutationAssertion.admission.request_hash, /^[0-9a-f]{64}$/u);
    assert.match(mutationAssertion.admission.quota_reservation_id ?? "", /^[\x21-\x7e]{1,128}$/u);
    const measurementAssertion = verifyWanghaiAssertion(quotaMeasurementAssertion, assertionSecret);
    assert.equal(measurementAssertion.quota_measurement, "active_workspace");
    assert.equal(measurementAssertion.admission, undefined);
    assert.equal(quotaMeasurementRequestId, measurementAssertion.request_id);
    assert.equal(quotaMeasurementRequests, 2);
    assert.equal(
      getPolarisControlStore(import.meta.url)
        .getQuotaReservation(mutationAssertion.admission.quota_reservation_id!)
        ?.actualUsageBytes,
      2_048,
    );
    const mutationAudit = getPolarisControlStore(import.meta.url).listAuditEvents()
      .filter((event) => event.requestId === mutationRequestId)
      .filter((event) => event.action.startsWith("wanghai.surface.action."));
    assert.deepEqual(
      mutationAudit.map((event) => [event.action, event.outcome]).sort(),
      [
        ["wanghai.surface.action.workspace.create.accepted", "success"],
        ["wanghai.surface.action.workspace.create.completed", "success"],
      ],
    );

    const replayedMutation = await requestPortalHost({
      port: portalAddress.port,
      path: "/g/api/workspaces",
      method: "POST",
      headers: {
        host: launchUrl.host,
        cookie: cookie!,
        origin: `http://${launchUrl.host}`,
        "content-type": "application/json",
        "idempotency-key": "workspace-create-001",
      },
      body: JSON.stringify({ workspace_type: "research", workspace_id: "synthetic-workspace" }),
    });
    assert.equal(replayedMutation.statusCode, 200);
    assert.equal(replayedMutation.headers["x-polaris-idempotent-replay"], "1");
    assert.equal(upstreamRequests, 2);
    assert.equal(quotaMeasurementRequests, 2);

    const conflictingMutation = await requestPortalHost({
      port: portalAddress.port,
      path: "/g/api/workspaces",
      method: "POST",
      headers: {
        host: launchUrl.host,
        cookie: cookie!,
        origin: `http://${launchUrl.host}`,
        "content-type": "application/json",
        "idempotency-key": "workspace-create-001",
      },
      body: JSON.stringify({ workspace_id: "other-workspace", workspace_type: "research" }),
    });
    assert.equal(conflictingMutation.statusCode, 409);
    assert.equal(upstreamRequests, 2);

    const internalBrowserAttempt = await requestPortalHost({
      port: portalAddress.port,
      path: "/g/api/internal/workspace-usage",
      headers: { host: launchUrl.host, cookie: cookie! },
    });
    assert.equal(internalBrowserAttempt.statusCode, 404);
    assert.equal(quotaMeasurementRequests, 2);

    workspaceUsageBytes = 256 * 1024 * 1024 - 2 * 1024 * 1024;
    const quotaExhausted = await requestPortalHost({
      port: portalAddress.port,
      path: "/g/api/workspaces",
      method: "POST",
      headers: {
        host: launchUrl.host,
        cookie: cookie!,
        origin: `http://${launchUrl.host}`,
        "content-type": "application/json",
        "idempotency-key": "workspace-quota-exhausted-001",
      },
      body: JSON.stringify({ workspace_id: "quota-exhausted", workspace_type: "research" }),
    });
    assert.equal(quotaExhausted.statusCode, 507);
    assert.equal(upstreamRequests, 2);
    assert.equal(quotaMeasurementRequests, 3);
    assert.ok(
      getPolarisControlStore(import.meta.url).listAuditEvents().some((event) => (
        event.action === "wanghai.surface.quota.reservation.denied"
        && event.outcome === "denied"
      )),
    );

    const unknownMutation = await requestPortalHost({
      port: portalAddress.port,
      path: "/g/api/workspaces/synthetic-workspace/not-admitted",
      method: "POST",
      headers: {
        host: launchUrl.host,
        cookie: cookie!,
        origin: `http://${launchUrl.host}`,
        "content-type": "application/json",
        "idempotency-key": "unknown-route-001",
      },
      body: "{}",
    });
    assert.equal(unknownMutation.statusCode, 403);
    assert.equal(upstreamRequests, 2);

    const absoluteFormAttempt = await requestPortalHost({
      port: portalAddress.port,
      path: `http://127.0.0.1:${upstreamAddress.port}/g/exfiltrate`,
      method: "POST",
      headers: {
        host: launchUrl.host,
        cookie: cookie!,
        origin: `http://${launchUrl.host}`,
      },
    });
    assert.equal(absoluteFormAttempt.statusCode, 400);
    assert.match(absoluteFormAttempt.body, /Invalid Wanghai gateway request path/u);
    assert.equal(upstreamRequests, 2);

    const rateLimited = await requestPortalHost({
      port: portalAddress.port,
      path: "/g/api/workspaces",
      headers: { host: launchUrl.host, cookie: cookie! },
    });
    assert.equal(rateLimited.statusCode, 429);
    assert.equal(rateLimited.headers["ratelimit-limit"], "1");
    assert.equal(rateLimited.headers["ratelimit-remaining"], "0");
    assert.equal(upstreamRequests, 2);

    const csrfAttempt = await requestPortalHost({
      port: portalAddress.port,
      path: "/g/api/workspaces",
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
      `http://127.0.0.1:${portalAddress.port}/api/g/${wanghaiId}/launch`,
      { method: "POST", headers: { origin: `http://127.0.0.1:${portalAddress.port}` } },
    );
    assert.equal(selectedRuntimeLaunch.status, 404);
    assert.equal(upstreamRequests, 2);

    process.env.POLARIS_AUTH_DEFAULT_USER_ID = userB;
    const crossTenantLaunch = await fetch(
      `http://127.0.0.1:${portalAddress.port}/api/g/${wanghaiId}/launch`,
      { method: "POST", headers: { origin: `http://127.0.0.1:${portalAddress.port}` } },
    );
    assert.equal(crossTenantLaunch.status, 404);

    await updateUserAccessEntry(userA, { line: "coding" });
    const revokedSession = await requestPortalHost({
      port: portalAddress.port,
      path: "/g/api/workspaces",
      headers: { host: launchUrl.host, cookie: cookie! },
    });
    assert.equal(revokedSession.statusCode, 403);
    assert.equal(upstreamRequests, 2);
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
