import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveWanghaiVaultAssertionSecret,
  issueWanghaiAssertion,
  verifyWanghaiAssertion,
  wanghaiGatewayHostLabel,
} from "../scripts/security/wanghai-assertions.js";
import { createWanghaiGatewayLaunch } from "../scripts/portal/wanghai-gateway.js";

const masterSecret = "0123456789abcdef0123456789abcdef";

test("Wanghai assertions are scoped to one tenant and vault", () => {
  const tenantASecret = deriveWanghaiVaultAssertionSecret(masterSecret, "tenant-a", "vault-a");
  const tenantBSecret = deriveWanghaiVaultAssertionSecret(masterSecret, "tenant-b", "vault-a");
  assert.notEqual(tenantASecret, tenantBSecret);

  const token = issueWanghaiAssertion({
    secret: tenantASecret,
    userId: "synthetic-user-a",
    tenantId: "tenant-a",
    vaultId: "vault-a",
    role: "operator",
    requestId: "request-a",
    nowSeconds: 1_000,
  });
  assert.deepEqual(verifyWanghaiAssertion(token, tenantASecret, 1_001), {
    v: 1,
    iss: "polaris",
    aud: "wanghai",
    sub: "synthetic-user-a",
    tenant_id: "tenant-a",
    vault_id: "vault-a",
    role: "operator",
    request_id: "request-a",
    iat: 1_000,
    exp: 1_060,
  });
  assert.throws(() => verifyWanghaiAssertion(token, tenantBSecret, 1_001), /signature/i);
});

test("Wanghai launch URLs use an opaque per-vault gateway host", () => {
  const previousMasterSecret = process.env.POLARIS_WANGHAI_GATEWAY_MASTER_SECRET;
  const previousOrigin = process.env.POLARIS_WANGHAI_GATEWAY_ORIGIN;
  process.env.POLARIS_WANGHAI_GATEWAY_MASTER_SECRET = masterSecret;
  process.env.POLARIS_WANGHAI_GATEWAY_ORIGIN = "https://wanghai.example.test";
  try {
    const launch = createWanghaiGatewayLaunch({
      session: { polarisUserId: "synthetic-user-a", role: "user" },
      serverId: "srv_synthetic",
      vaultId: "vault-a",
    });
    const url = new URL(launch.portalUrl);
    assert.equal(url.hostname, `${wanghaiGatewayHostLabel("srv_synthetic")}.wanghai.example.test`);
    assert.equal(url.pathname, "/");
    assert.ok(url.searchParams.get("ticket"));
    assert.doesNotMatch(launch.portalUrl, /:9090|nodeport/i);
  } finally {
    if (previousMasterSecret === undefined) delete process.env.POLARIS_WANGHAI_GATEWAY_MASTER_SECRET;
    else process.env.POLARIS_WANGHAI_GATEWAY_MASTER_SECRET = previousMasterSecret;
    if (previousOrigin === undefined) delete process.env.POLARIS_WANGHAI_GATEWAY_ORIGIN;
    else process.env.POLARIS_WANGHAI_GATEWAY_ORIGIN = previousOrigin;
  }
});
