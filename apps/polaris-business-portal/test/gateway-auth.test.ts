import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  assertWanghaiQuotaMeasurementRequest,
  isWanghaiGatewayReady,
  WANGHAI_STANDALONE_IDENTITY_HEADER,
  WANGHAI_STANDALONE_REQUEST_ID_HEADER,
  WANGHAI_STANDALONE_ISSUER,
  verifyWanghaiGatewayRequest,
  wanghaiGatewayFrameAncestorsDirective,
  WanghaiGatewayAuthError,
} from "../lib/gateway-auth";

const secret = "0123456789abcdef0123456789abcdef";

function gatewayAssertion(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    iss: "polaris",
    aud: "wanghai",
    sub: "synthetic-user-a",
    tenant_id: "synthetic-tenant-a",
    vault_id: "synthetic-vault-a",
    role: "operator",
    request_id: "request-a",
    iat: now - 1,
    exp: now + 60,
    ...overrides,
  }), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
  return `${payload}.${signature}`;
}

async function withGatewayEnv(fn: () => Promise<void>): Promise<void> {
  const previous = {
    mode: process.env.WANGHAI_RUNTIME_MODE,
    dataRoot: process.env.WANGHAI_DATA_ROOT,
    secret: process.env.WANGHAI_GATEWAY_ASSERTION_SECRET,
    tenant: process.env.WANGHAI_GATEWAY_TENANT_ID,
    vault: process.env.WANGHAI_GATEWAY_VAULT_ID,
    frameAncestors: process.env.WANGHAI_GATEWAY_FRAME_ANCESTORS,
  };
  process.env.WANGHAI_RUNTIME_MODE = "polaris";
  process.env.WANGHAI_GATEWAY_ASSERTION_SECRET = secret;
  process.env.WANGHAI_GATEWAY_TENANT_ID = "synthetic-tenant-a";
  process.env.WANGHAI_GATEWAY_VAULT_ID = "synthetic-vault-a";
  process.env.WANGHAI_GATEWAY_FRAME_ANCESTORS = "https://polaris.example.test";
  try {
    await fn();
  } finally {
    if (previous.mode === undefined) delete process.env.WANGHAI_RUNTIME_MODE;
    else process.env.WANGHAI_RUNTIME_MODE = previous.mode;
    if (previous.dataRoot === undefined) delete process.env.WANGHAI_DATA_ROOT;
    else process.env.WANGHAI_DATA_ROOT = previous.dataRoot;
    if (previous.secret === undefined) delete process.env.WANGHAI_GATEWAY_ASSERTION_SECRET;
    else process.env.WANGHAI_GATEWAY_ASSERTION_SECRET = previous.secret;
    if (previous.tenant === undefined) delete process.env.WANGHAI_GATEWAY_TENANT_ID;
    else process.env.WANGHAI_GATEWAY_TENANT_ID = previous.tenant;
    if (previous.vault === undefined) delete process.env.WANGHAI_GATEWAY_VAULT_ID;
    else process.env.WANGHAI_GATEWAY_VAULT_ID = previous.vault;
    if (previous.frameAncestors === undefined) delete process.env.WANGHAI_GATEWAY_FRAME_ANCESTORS;
    else process.env.WANGHAI_GATEWAY_FRAME_ANCESTORS = previous.frameAncestors;
  }
}

const standaloneSecret = "abcdef0123456789abcdef0123456789";

function standaloneIdentity(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    iss: WANGHAI_STANDALONE_ISSUER,
    aud: "wanghai",
    sub: "external-user-a",
    tenant_id: "standalone-tenant",
    vault_id: "standalone-vault",
    role: "operator",
    capabilities: ["wanghai.read", "product.update"],
    request_id: "standalone-request-a",
    request_method: "GET",
    request_target: "/api/workspaces",
    iat: now - 1,
    exp: now + 60,
    ...overrides,
  }), "utf8").toString("base64url");
  const signature = createHmac("sha256", standaloneSecret)
    .update(payload, "utf8")
    .digest("base64url");
  return `${payload}.${signature}`;
}

async function withStandaloneEnv(fn: () => Promise<void>): Promise<void> {
  const previous = {
    mode: process.env.WANGHAI_RUNTIME_MODE,
    dataRoot: process.env.WANGHAI_DATA_ROOT,
    secret: process.env.WANGHAI_STANDALONE_IDENTITY_SECRET,
    tenant: process.env.WANGHAI_STANDALONE_TENANT_ID,
    vault: process.env.WANGHAI_STANDALONE_VAULT_ID,
    frameAncestors: process.env.WANGHAI_STANDALONE_FRAME_ANCESTORS,
  };
  process.env.WANGHAI_RUNTIME_MODE = "standalone";
  process.env.WANGHAI_DATA_ROOT = "/tmp/synthetic-wanghai-data";
  process.env.WANGHAI_STANDALONE_IDENTITY_SECRET = standaloneSecret;
  process.env.WANGHAI_STANDALONE_TENANT_ID = "standalone-tenant";
  process.env.WANGHAI_STANDALONE_VAULT_ID = "standalone-vault";
  delete process.env.WANGHAI_STANDALONE_FRAME_ANCESTORS;
  try {
    await fn();
  } finally {
    if (previous.mode === undefined) delete process.env.WANGHAI_RUNTIME_MODE;
    else process.env.WANGHAI_RUNTIME_MODE = previous.mode;
    if (previous.dataRoot === undefined) delete process.env.WANGHAI_DATA_ROOT;
    else process.env.WANGHAI_DATA_ROOT = previous.dataRoot;
    if (previous.secret === undefined) delete process.env.WANGHAI_STANDALONE_IDENTITY_SECRET;
    else process.env.WANGHAI_STANDALONE_IDENTITY_SECRET = previous.secret;
    if (previous.tenant === undefined) delete process.env.WANGHAI_STANDALONE_TENANT_ID;
    else process.env.WANGHAI_STANDALONE_TENANT_ID = previous.tenant;
    if (previous.vault === undefined) delete process.env.WANGHAI_STANDALONE_VAULT_ID;
    else process.env.WANGHAI_STANDALONE_VAULT_ID = previous.vault;
    if (previous.frameAncestors === undefined) delete process.env.WANGHAI_STANDALONE_FRAME_ANCESTORS;
    else process.env.WANGHAI_STANDALONE_FRAME_ANCESTORS = previous.frameAncestors;
  }
}

test("gateway assertions require an exact tenant and vault match", async () => {
  await withGatewayEnv(async () => {
    const request = new Request("http://wanghai.test/api/workspaces", {
      headers: {
        "x-polaris-request-id": "request-a",
        "x-polaris-wanghai-assertion": gatewayAssertion(),
      },
    });
    const claims = await verifyWanghaiGatewayRequest(request);
    assert.equal(claims.sub, "synthetic-user-a");

    const crossTenant = new Request("http://wanghai.test/api/workspaces", {
      headers: {
        "x-polaris-request-id": "request-a",
        "x-polaris-wanghai-assertion": gatewayAssertion({ tenant_id: "synthetic-tenant-b" }),
      },
    });
    await assert.rejects(
      verifyWanghaiGatewayRequest(crossTenant),
      (error: unknown) => error instanceof WanghaiGatewayAuthError && error.statusCode === 401,
    );
  });
});

test("gateway assertions reject a tampered signature and missing configuration", async () => {
  await withGatewayEnv(async () => {
    const assertion = gatewayAssertion();
    const tampered = new Request("http://wanghai.test/api/workspaces", {
      headers: {
        "x-polaris-request-id": "request-a",
        "x-polaris-wanghai-assertion": `${assertion}x`,
      },
    });
    await assert.rejects(verifyWanghaiGatewayRequest(tampered), WanghaiGatewayAuthError);
  });

  const previous = process.env.WANGHAI_GATEWAY_ASSERTION_SECRET;
  delete process.env.WANGHAI_GATEWAY_ASSERTION_SECRET;
  try {
    await assert.rejects(
      verifyWanghaiGatewayRequest(new Request("http://wanghai.test/api/workspaces")),
      (error: unknown) => error instanceof WanghaiGatewayAuthError && error.statusCode === 503,
    );
  } finally {
    if (previous !== undefined) process.env.WANGHAI_GATEWAY_ASSERTION_SECRET = previous;
  }
});

test("gateway assertions bind the signed request ID to the forwarded request", async () => {
  await withGatewayEnv(async () => {
    const request = new Request("http://wanghai.test/api/workspaces", {
      headers: {
        "x-polaris-request-id": "different-request",
        "x-polaris-wanghai-assertion": gatewayAssertion(),
      },
    });
    await assert.rejects(
      verifyWanghaiGatewayRequest(request),
      (error: unknown) => error instanceof WanghaiGatewayAuthError && error.statusCode === 401,
    );
  });
});

test("gateway assertions validate signed mutation admission context", async () => {
  await withGatewayEnv(async () => {
    const request = new Request("http://wanghai.test/api/workspaces/acme/products/SKU-1", {
      headers: {
        "x-polaris-request-id": "request-a",
        "x-polaris-wanghai-assertion": gatewayAssertion({
          admission: {
            action: "product.update",
            action_version: 1,
            workspace_id: "acme",
            idempotency_key: "mutation-a",
            request_hash: "a".repeat(64),
            expected_version: 2,
            quota_reservation_id: "quota-a",
          },
        }),
      },
    });
    const claims = await verifyWanghaiGatewayRequest(request);
    assert.equal(claims.admission?.action, "product.update");
    assert.equal(claims.admission?.expected_version, 2);

    const invalid = new Request("http://wanghai.test/api/workspaces/acme/products/SKU-1", {
      headers: {
        "x-polaris-request-id": "request-a",
        "x-polaris-wanghai-assertion": gatewayAssertion({
          admission: {
            action: "product.update",
            action_version: 1,
            workspace_id: "../other",
            idempotency_key: "mutation-a",
            request_hash: "a".repeat(64),
          },
        }),
      },
    });
    await assert.rejects(verifyWanghaiGatewayRequest(invalid), WanghaiGatewayAuthError);
  });
});

test("gateway assertions reserve workspace usage measurement for Polaris", async () => {
  await withGatewayEnv(async () => {
    const request = new Request("http://wanghai.test/api/internal/workspace-usage", {
      headers: {
        "x-polaris-request-id": "request-a",
        "x-polaris-wanghai-assertion": gatewayAssertion({
          quota_measurement: "active_workspace",
        }),
      },
    });
    await assert.doesNotReject(assertWanghaiQuotaMeasurementRequest(request));

    const browserAssertion = new Request("http://wanghai.test/api/internal/workspace-usage", {
      headers: {
        "x-polaris-request-id": "request-a",
        "x-polaris-wanghai-assertion": gatewayAssertion(),
      },
    });
    await assert.rejects(
      assertWanghaiQuotaMeasurementRequest(browserAssertion),
      (error: unknown) => error instanceof WanghaiGatewayAuthError && error.statusCode === 403,
    );

    const combinedPurpose = new Request("http://wanghai.test/api/internal/workspace-usage", {
      headers: {
        "x-polaris-request-id": "request-a",
        "x-polaris-wanghai-assertion": gatewayAssertion({
          quota_measurement: "active_workspace",
          admission: {
            action: "product.update",
            action_version: 1,
            workspace_id: "acme",
            idempotency_key: "mutation-a",
            request_hash: "a".repeat(64),
          },
        }),
      },
    });
    await assert.rejects(
      assertWanghaiQuotaMeasurementRequest(combinedPurpose),
      (error: unknown) => error instanceof WanghaiGatewayAuthError && error.statusCode === 401,
    );
  });
});

test("gateway assertions reject oversized identity claims", async () => {
  await withGatewayEnv(async () => {
    const request = new Request("http://wanghai.test/api/workspaces", {
      headers: {
        "x-polaris-request-id": "request-a",
        "x-polaris-wanghai-assertion": gatewayAssertion({ sub: "x".repeat(257) }),
      },
    });
    await assert.rejects(verifyWanghaiGatewayRequest(request), WanghaiGatewayAuthError);
  });
});

test("gateway assertions reject an excessive assertion lifetime", async () => {
  await withGatewayEnv(async () => {
    const now = Math.floor(Date.now() / 1000);
    const request = new Request("http://wanghai.test/api/workspaces", {
      headers: {
        "x-polaris-request-id": "request-a",
        "x-polaris-wanghai-assertion": gatewayAssertion({ iat: now, exp: now + 121 }),
      },
    });
    await assert.rejects(verifyWanghaiGatewayRequest(request), WanghaiGatewayAuthError);
  });
});

test("gateway readiness requires an explicit, valid Polaris frame ancestor", async () => {
  await withGatewayEnv(async () => {
    assert.equal(isWanghaiGatewayReady(), true);
    assert.equal(
      wanghaiGatewayFrameAncestorsDirective(),
      "frame-ancestors 'self' https://polaris.example.test",
    );
    process.env.WANGHAI_GATEWAY_FRAME_ANCESTORS = "https://polaris.example.test/not-an-origin";
    assert.equal(isWanghaiGatewayReady(), false);
    assert.throws(wanghaiGatewayFrameAncestorsDirective, WanghaiGatewayAuthError);
  });
});

test("standalone identity envelopes carry a scoped actor and request binding", async () => {
  await withStandaloneEnv(async () => {
    const request = new Request("http://wanghai.test/api/workspaces", {
      headers: {
        [WANGHAI_STANDALONE_REQUEST_ID_HEADER]: "standalone-request-a",
        [WANGHAI_STANDALONE_IDENTITY_HEADER]: standaloneIdentity(),
      },
    });
    const claims = await verifyWanghaiGatewayRequest(request);
    assert.equal(claims.iss, WANGHAI_STANDALONE_ISSUER);
    assert.equal(claims.sub, "external-user-a");
    assert.deepEqual(claims.capabilities, ["wanghai.read", "product.update"]);

    const replayedOnAnotherPath = new Request("http://wanghai.test/api/workspaces/acme", {
      headers: {
        [WANGHAI_STANDALONE_REQUEST_ID_HEADER]: "standalone-request-a",
        [WANGHAI_STANDALONE_IDENTITY_HEADER]: standaloneIdentity(),
      },
    });
    await assert.rejects(
      verifyWanghaiGatewayRequest(replayedOnAnotherPath),
      (error: unknown) => error instanceof WanghaiGatewayAuthError && error.statusCode === 401,
    );

    const methodMismatch = new Request("http://wanghai.test/api/workspaces", {
      method: "POST",
      headers: {
        [WANGHAI_STANDALONE_REQUEST_ID_HEADER]: "standalone-request-a",
        [WANGHAI_STANDALONE_IDENTITY_HEADER]: standaloneIdentity(),
      },
    });
    await assert.rejects(verifyWanghaiGatewayRequest(methodMismatch), WanghaiGatewayAuthError);
  });
});

test("standalone request bindings normalize the Wanghai base path", async () => {
  await withStandaloneEnv(async () => {
    const request = new Request("http://wanghai.test/wanghai/api/workspaces", {
      headers: {
        [WANGHAI_STANDALONE_REQUEST_ID_HEADER]: "standalone-request-a",
        [WANGHAI_STANDALONE_IDENTITY_HEADER]: standaloneIdentity(),
      },
    });
    await assert.doesNotReject(verifyWanghaiGatewayRequest(request));
  });
});

test("standalone request bindings canonicalize query values", async () => {
  await withStandaloneEnv(async () => {
    const request = new Request("http://wanghai.test/wanghai/api/workspaces/songjin/thumb?path=assets/test.png&v=1&s=2", {
      headers: {
        [WANGHAI_STANDALONE_REQUEST_ID_HEADER]: "standalone-request-a",
        [WANGHAI_STANDALONE_IDENTITY_HEADER]: standaloneIdentity({
          request_target: "/api/workspaces/songjin/thumb?path=assets%2Ftest.png&v=1&s=2",
        }),
      },
    });
    await assert.doesNotReject(verifyWanghaiGatewayRequest(request));
  });
});

test("standalone mode rejects Polaris headers and requires its own readiness configuration", async () => {
  await withStandaloneEnv(async () => {
    const polarisRequest = new Request("http://wanghai.test/api/workspaces", {
      headers: {
        "x-polaris-request-id": "request-a",
        "x-polaris-wanghai-assertion": gatewayAssertion(),
      },
    });
    await assert.rejects(
      verifyWanghaiGatewayRequest(polarisRequest),
      (error: unknown) => error instanceof WanghaiGatewayAuthError && error.statusCode === 401,
    );
    assert.equal(isWanghaiGatewayReady(), true);
    assert.equal(wanghaiGatewayFrameAncestorsDirective(), "frame-ancestors 'self'");
    delete process.env.WANGHAI_STANDALONE_IDENTITY_SECRET;
    assert.equal(isWanghaiGatewayReady(), false);
  });
});

test("standalone identity envelopes reject missing, malformed, expired, and cross-tenant input", async () => {
  await withStandaloneEnv(async () => {
    await assert.rejects(
      verifyWanghaiGatewayRequest(new Request("http://wanghai.test/api/workspaces")),
      (error: unknown) => error instanceof WanghaiGatewayAuthError && error.statusCode === 401,
    );

    const malformed = new Request("http://wanghai.test/api/workspaces", {
      headers: {
        [WANGHAI_STANDALONE_REQUEST_ID_HEADER]: "standalone-request-a",
        [WANGHAI_STANDALONE_IDENTITY_HEADER]: "not-a-signed-envelope",
      },
    });
    await assert.rejects(
      verifyWanghaiGatewayRequest(malformed),
      (error: unknown) => error instanceof WanghaiGatewayAuthError && error.statusCode === 401,
    );

    const now = Math.floor(Date.now() / 1000);
    const expired = new Request("http://wanghai.test/api/workspaces", {
      headers: {
        [WANGHAI_STANDALONE_REQUEST_ID_HEADER]: "standalone-request-a",
        [WANGHAI_STANDALONE_IDENTITY_HEADER]: standaloneIdentity({
          iat: now - 122,
          exp: now - 1,
        }),
      },
    });
    await assert.rejects(verifyWanghaiGatewayRequest(expired), WanghaiGatewayAuthError);

    const crossTenant = new Request("http://wanghai.test/api/workspaces", {
      headers: {
        [WANGHAI_STANDALONE_REQUEST_ID_HEADER]: "standalone-request-a",
        [WANGHAI_STANDALONE_IDENTITY_HEADER]: standaloneIdentity({
          tenant_id: "other-tenant",
        }),
      },
    });
    await assert.rejects(
      verifyWanghaiGatewayRequest(crossTenant),
      (error: unknown) => error instanceof WanghaiGatewayAuthError && error.statusCode === 401,
    );
  });
});

test("Polaris mode rejects a standalone identity envelope", async () => {
  await withGatewayEnv(async () => {
    const request = new Request("http://wanghai.test/api/workspaces", {
      headers: {
        [WANGHAI_STANDALONE_REQUEST_ID_HEADER]: "standalone-request-a",
        [WANGHAI_STANDALONE_IDENTITY_HEADER]: standaloneIdentity(),
      },
    });
    await assert.rejects(
      verifyWanghaiGatewayRequest(request),
      (error: unknown) => error instanceof WanghaiGatewayAuthError && error.statusCode === 401,
    );
  });
});
