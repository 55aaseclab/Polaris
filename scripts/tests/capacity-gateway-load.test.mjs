import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import {
  normalizeCapacityFixture,
  percentile,
  runCapacityGatewayLoad,
} from "../release/capacity-gateway-load.mjs";

function json(res, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function fixture(port) {
  return {
    schema_version: 1,
    kind: "polaris-capacity-gateway-fixture",
    environment: "isolated loopback test",
    transport_origin: `http://127.0.0.1:${port}`,
    portal_origin: "http://portal.example.test",
    auth: {
      cookie: "_oauth2_proxy=synthetic-session",
      user_header: "x-auth-request-user",
    },
    stages: {
      "2": [
        {
          authing_user_id: "load-auth-stage-two-a",
          polaris_user_id: "load-user-stage-two-a",
          vault: "load-vault-stage-two-a",
        },
        {
          authing_user_id: "load-auth-stage-two-b",
          polaris_user_id: "load-user-stage-two-b",
          vault: "load-vault-stage-two-b",
        },
      ],
    },
  };
}

test("capacity gateway load runs the complete isolated user flow", async () => {
  const server = createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    const host = String(req.headers.host ?? "");
    const url = new URL(req.url ?? "/", `http://${host}`);
    const authingUserId = String(req.headers["x-auth-request-user"] ?? "");
    const userSuffix = authingUserId.endsWith("-a") ? "a" : "b";
    const vault = `load-vault-stage-two-${userSuffix}`;
    const user = `load-user-stage-two-${userSuffix}`;

    if (host === "portal.example.test") {
      if (url.pathname === "/api/session") {
        json(res, 200, { polarisUserId: user });
        return;
      }
      if (url.pathname === "/api/polaris-hosts") {
        json(res, 200, {
          hosts: [{ name: vault, surfaces: ["wanghai"], wanghaiId: `server-${userSuffix}` }],
        });
        return;
      }
      if (url.pathname === `/api/wanghai/server-${userSuffix}/launch`) {
        assert.equal(req.method, "POST");
        assert.equal(req.headers.origin, "http://portal.example.test");
        json(res, 200, {
          portalUrl: `http://portal.example.test/wanghai/?ticket=synthetic-${userSuffix}`,
        });
        return;
      }
    }

    if (host === "portal.example.test") {
      if (url.searchParams.has("ticket")) {
        res.writeHead(302, {
          location: "/wanghai/",
          "set-cookie": "polaris_wanghai_session=synthetic; Path=/wanghai; HttpOnly",
        });
        res.end();
        return;
      }
      if (url.pathname === "/wanghai/" || url.pathname === "/wanghai") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html></html>");
        return;
      }
      if (url.pathname === "/wanghai/api/prebuilt-workflows") {
        json(res, 200, { workflows: [] });
        return;
      }
      if (url.pathname === "/wanghai/api/workspaces" && req.method === "GET") {
        json(res, 200, { workspaces: [] });
        return;
      }
      if (url.pathname === "/wanghai/api/workspaces" && req.method === "POST") {
        assert.equal(req.headers.origin, "http://portal.example.test");
        assert.match(String(req.headers["idempotency-key"]), /^test-run-s2-u[12]-r1-workspace$/);
        json(res, 201, { workspace_version: 1 });
        return;
      }
      if (url.pathname.endsWith("/version")) {
        json(res, 200, { workspace_version: 1 });
        return;
      }
      if (url.pathname.endsWith("/assets")) {
        json(res, 200, { assets: [] });
        return;
      }
      if (url.pathname.endsWith("/workflows")) {
        json(res, 200, { workflows: [] });
        return;
      }
      if (url.pathname.endsWith("/products") && req.method === "POST") {
        assert.equal(req.headers["x-polaris-expected-version"], "1");
        json(res, 201, { product: { sku: `SKU-5-1-00${userSuffix === "a" ? "1" : "2"}` }, workspace_version: 2 });
        return;
      }
      if (url.pathname.includes("/products/SKU-") && req.method === "POST") {
        assert.equal(req.headers["x-polaris-expected-version"], "2");
        assert.match(String(req.headers["content-type"]), /^multipart\/form-data; boundary=/);
        json(res, 200, { workspace_version: 3 });
        return;
      }
    }
    json(res, 404, { error: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a port");

  try {
    const result = await runCapacityGatewayLoad({
      fixture: fixture(address.port),
      profile: {
        gatewayLaunchSuccessPercent: 99.5,
        max5xxPercent: 1,
        mutationP95Ms: 1_500,
        readP95Ms: 500,
      },
      rounds: 1,
      runId: "test-run",
      stages: [2],
    });

    assert.equal(result.passed, true, JSON.stringify(result.stages["2"].userRunErrors));
    assert.equal(result.stages["2"].errors, 0);
    assert.equal(result.stages["2"].operationSummary["workflow.status"].count, 2);
    assert.equal(result.stages["2"].operationSummary["product.asset-upload"].count, 2);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("capacity fixtures reject identity reuse across load stages", () => {
  const raw = fixture(8787);
  raw.stages["5"] = [raw.stages["2"][0]];
  assert.throws(() => normalizeCapacityFixture(raw), /must not reuse an Authing identity/i);
});

test("capacity fixtures restrict transport to loopback", () => {
  const raw = fixture(8787);
  raw.transport_origin = "http://198.51.100.1:8787";
  assert.throws(() => normalizeCapacityFixture(raw), /must use a loopback host/i);
});

test("capacity percentile uses the nearest-rank value", () => {
  assert.equal(percentile([10, 20, 30, 40, 50], 0.95), 50);
  assert.equal(percentile([10, 20, 30, 40], 0.5), 20);
});
