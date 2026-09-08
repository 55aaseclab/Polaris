import assert from "node:assert/strict";
import test from "node:test";
import {
  WANGHAI_STANDALONE_ISSUER,
  type VerifiedStandaloneGatewayClaims,
} from "../lib/gateway-auth.js";
import { verifiedWanghaiGatewayHeaders } from "../lib/gateway-headers.js";

test("verified gateway headers preserve signed source credentials for mutation rechecks", () => {
  const claims: VerifiedStandaloneGatewayClaims = {
    v: 1,
    iss: WANGHAI_STANDALONE_ISSUER,
    aud: "wanghai",
    sub: "synthetic-user",
    tenant_id: "standalone-tenant",
    vault_id: "standalone-vault",
    role: "operator",
    capabilities: ["workspace.create"],
    request_id: "request-a",
    request_method: "POST",
    request_target: "/api/workspaces",
    iat: 1,
    exp: 2,
    admission: {
      action: "workspace.create",
      action_version: 1,
      workspace_id: "demo",
      idempotency_key: "create-demo",
      request_hash: "a".repeat(64),
      quota_reservation_id: "standalone-admission-a",
    },
  };
  const source = new Headers({
    "x-wanghai-gateway-action": "forged.action",
    "x-wanghai-gateway-user-id": "forged-user",
    "x-wanghai-standalone-identity": "signed-envelope",
    "x-wanghai-standalone-request-id": "request-a",
  });

  const headers = verifiedWanghaiGatewayHeaders(source, claims);

  assert.equal(headers.get("x-wanghai-standalone-identity"), "signed-envelope");
  assert.equal(headers.get("x-wanghai-standalone-request-id"), "request-a");
  assert.equal(headers.get("x-wanghai-gateway-user-id"), "synthetic-user");
  assert.equal(headers.get("x-wanghai-gateway-action"), "workspace.create");
  assert.equal(headers.get("x-wanghai-gateway-issuer"), WANGHAI_STANDALONE_ISSUER);
  assert.equal(headers.get("x-wanghai-gateway-capabilities"), "workspace.create");
});
