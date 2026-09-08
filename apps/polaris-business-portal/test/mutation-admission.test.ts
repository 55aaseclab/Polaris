import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  assertWanghaiMutationAdmission,
  assertWanghaiJsonMutationAdmission,
} from "../lib/mutation-admission.js";
import {
  WanghaiGatewayAuthError,
  type VerifiedPolarisGatewayClaims,
  type VerifiedStandaloneGatewayClaims,
} from "../lib/gateway-auth.js";

const secret = "0123456789abcdef0123456789abcdef";

function signedAssertion(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded, "utf8").digest("base64url")}`;
}

async function withGatewayEnv(fn: () => Promise<void>): Promise<void> {
  const previous = {
    mode: process.env.WANGHAI_RUNTIME_MODE,
    secret: process.env.WANGHAI_GATEWAY_ASSERTION_SECRET,
    tenant: process.env.WANGHAI_GATEWAY_TENANT_ID,
    vault: process.env.WANGHAI_GATEWAY_VAULT_ID,
  };
  process.env.WANGHAI_RUNTIME_MODE = "polaris";
  process.env.WANGHAI_GATEWAY_ASSERTION_SECRET = secret;
  process.env.WANGHAI_GATEWAY_TENANT_ID = "synthetic-tenant";
  process.env.WANGHAI_GATEWAY_VAULT_ID = "synthetic-vault";
  try {
    await fn();
  } finally {
    if (previous.mode === undefined) delete process.env.WANGHAI_RUNTIME_MODE;
    else process.env.WANGHAI_RUNTIME_MODE = previous.mode;
    if (previous.secret === undefined) delete process.env.WANGHAI_GATEWAY_ASSERTION_SECRET;
    else process.env.WANGHAI_GATEWAY_ASSERTION_SECRET = previous.secret;
    if (previous.tenant === undefined) delete process.env.WANGHAI_GATEWAY_TENANT_ID;
    else process.env.WANGHAI_GATEWAY_TENANT_ID = previous.tenant;
    if (previous.vault === undefined) delete process.env.WANGHAI_GATEWAY_VAULT_ID;
    else process.env.WANGHAI_GATEWAY_VAULT_ID = previous.vault;
  }
}

function claims(overrides: Partial<VerifiedPolarisGatewayClaims> = {}): VerifiedPolarisGatewayClaims {
  return {
    v: 1,
    iss: "polaris",
    aud: "wanghai",
    sub: "synthetic-user",
    tenant_id: "synthetic-tenant",
    vault_id: "synthetic-vault",
    role: "operator",
    request_id: "request-a",
    iat: 1,
    exp: 2,
    admission: {
      action: "product.update",
      action_version: 1,
      workspace_id: "acme",
      idempotency_key: "mutation-a",
      request_hash: "a".repeat(64),
      expected_version: 0,
      quota_reservation_id: "quota-a",
    },
    ...overrides,
  };
}

function standaloneClaims(
  overrides: Partial<VerifiedStandaloneGatewayClaims> = {},
): VerifiedStandaloneGatewayClaims {
  return {
    v: 1,
    iss: "wanghai-standalone-proxy",
    aud: "wanghai",
    sub: "external-user",
    tenant_id: "standalone-tenant",
    vault_id: "standalone-vault",
    role: "operator",
    capabilities: ["wanghai.read", "product.update"],
    request_id: "standalone-request",
    request_method: "PUT",
    request_target: "/api/workspaces/acme/products/SKU-001",
    iat: 1,
    exp: 2,
    admission: {
      action: "product.update",
      action_version: 1,
      workspace_id: "acme",
      idempotency_key: "mutation-a",
      request_hash: "a".repeat(64),
      expected_version: 0,
      quota_reservation_id: "standalone-admission-a",
    },
    ...overrides,
  };
}

test("Wanghai validates the signed action and workspace against each mutation path", () => {
  const request = new Request("http://wanghai.test/api/workspaces/acme/products/SKU-001", {
    method: "PUT",
    headers: { "content-type": "application/json" },
  });
  assert.equal(assertWanghaiMutationAdmission(request, claims())?.action, "product.update");

  const crossWorkspace = new Request("http://wanghai.test/api/workspaces/other/products/SKU-001", {
    method: "PUT",
    headers: { "content-type": "application/json" },
  });
  assert.throws(
    () => assertWanghaiMutationAdmission(crossWorkspace, claims()),
    (error: unknown) => error instanceof WanghaiGatewayAuthError && error.statusCode === 403,
  );

  const wrongMethod = new Request("http://wanghai.test/api/workspaces/acme/products/SKU-001", {
    method: "DELETE",
  });
  assert.throws(
    () => assertWanghaiMutationAdmission(wrongMethod, claims()),
    WanghaiGatewayAuthError,
  );
});

test("Wanghai rejects mutable requests without a semantic admission", () => {
  const request = new Request("http://wanghai.test/api/workspaces/acme/workflows", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  assert.throws(
    () => assertWanghaiMutationAdmission(request, claims({ admission: undefined })),
    (error: unknown) => error instanceof WanghaiGatewayAuthError && error.statusCode === 403,
  );
});

test("Wanghai requires the signed expected version for versioned actions", () => {
  const request = new Request("http://wanghai.test/api/workspaces/acme/products/SKU-001", {
    method: "PUT",
    headers: { "content-type": "application/json" },
  });
  const { expected_version: _expectedVersion, ...missingExpectedVersion } = claims().admission!;
  assert.throws(
    () => assertWanghaiMutationAdmission(request, claims({ admission: missingExpectedVersion })),
    (error: unknown) => error instanceof WanghaiGatewayAuthError && error.statusCode === 403,
  );

  assert.equal(
    assertWanghaiMutationAdmission(request, claims({
      admission: {
        ...claims().admission!,
        expected_version: 1,
      },
    }))?.expected_version,
    1,
  );
});

test("Wanghai binds a workspace-create JSON body to the signed admission", async () => {
  await withGatewayEnv(async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signedAssertion({
      v: 1,
      iss: "polaris",
      aud: "wanghai",
      sub: "synthetic-user",
      tenant_id: "synthetic-tenant",
      vault_id: "synthetic-vault",
      role: "operator",
      request_id: "request-create",
      iat: now - 1,
      exp: now + 60,
      admission: {
        action: "workspace.create",
        action_version: 1,
        workspace_id: "acme",
        idempotency_key: "create-workspace",
        request_hash: "a".repeat(64),
        quota_reservation_id: "quota-create",
      },
    });
    const request = new Request("http://wanghai.test/api/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-polaris-request-id": "request-create",
        "x-polaris-wanghai-assertion": token,
      },
    });
    await assert.doesNotReject(
      assertWanghaiJsonMutationAdmission(request, { workspace_id: "acme" }),
    );
    await assert.rejects(
      assertWanghaiJsonMutationAdmission(request, { workspace_id: "other" }),
      (error: unknown) => error instanceof WanghaiGatewayAuthError && error.statusCode === 403,
    );
  });
});

test("Wanghai requires a Polaris quota reservation for every mutation", () => {
  const request = new Request("http://wanghai.test/api/workspaces/acme/products/SKU-001", {
    method: "PUT",
    headers: { "content-type": "application/json" },
  });
  const { quota_reservation_id: _reservation, ...missingReservation } = claims().admission!;
  assert.throws(
    () => assertWanghaiMutationAdmission(request, claims({ admission: missingReservation })),
    (error: unknown) => error instanceof WanghaiGatewayAuthError && error.statusCode === 403,
  );
});

test("standalone admissions use signed capabilities without a Polaris claim", () => {
  const request = new Request("http://wanghai.test/api/workspaces/acme/products/SKU-001", {
    method: "PUT",
    headers: { "content-type": "application/json" },
  });
  const claimsWithCapability = standaloneClaims();
  assert.equal(
    assertWanghaiMutationAdmission(request, claimsWithCapability)?.action,
    "product.update",
  );

  assert.throws(
    () => assertWanghaiMutationAdmission(
      request,
      standaloneClaims({ capabilities: ["wanghai.read"] }),
    ),
    (error: unknown) => error instanceof WanghaiGatewayAuthError && error.statusCode === 403,
  );

  const readRequest = new Request("http://wanghai.test/api/workspaces", { method: "GET" });
  assert.doesNotThrow(() => assertWanghaiMutationAdmission(
    readRequest,
    standaloneClaims({
      request_method: "GET",
      request_target: "/api/workspaces",
      admission: undefined,
    }),
  ));
  assert.throws(
    () => assertWanghaiMutationAdmission(
      readRequest,
      standaloneClaims({
        request_method: "GET",
        request_target: "/api/workspaces",
        capabilities: ["product.update"],
        admission: undefined,
      }),
    ),
    (error: unknown) => error instanceof WanghaiGatewayAuthError && error.statusCode === 403,
  );
});
