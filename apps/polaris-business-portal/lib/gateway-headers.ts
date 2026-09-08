import {
  WANGHAI_STANDALONE_ISSUER,
  type VerifiedWanghaiGatewayClaims,
} from "@/lib/gateway-auth";

/**
 * Replace browser-supplied derived identity headers after verifying the signed
 * envelope. Keep that envelope itself because mutation handlers verify it again
 * immediately before a filesystem write.
 */
export function verifiedWanghaiGatewayHeaders(
  requestHeaders: Headers,
  claims: VerifiedWanghaiGatewayClaims,
): Headers {
  const headers = new Headers(requestHeaders);
  for (const name of [
    "x-wanghai-gateway-verified",
    "x-wanghai-gateway-user-id",
    "x-wanghai-gateway-tenant-id",
    "x-wanghai-gateway-vault-id",
    "x-wanghai-gateway-role",
    "x-wanghai-gateway-request-id",
    "x-wanghai-gateway-action",
    "x-wanghai-gateway-action-version",
    "x-wanghai-gateway-workspace-id",
    "x-wanghai-gateway-idempotency-key",
    "x-wanghai-gateway-request-hash",
    "x-wanghai-gateway-expected-version",
    "x-wanghai-gateway-quota-reservation-id",
    "x-wanghai-gateway-quota-measurement",
    "x-wanghai-gateway-issuer",
    "x-wanghai-gateway-capabilities",
  ]) {
    headers.delete(name);
  }
  headers.set("x-wanghai-gateway-verified", "1");
  headers.set("x-wanghai-gateway-issuer", claims.iss);
  headers.set("x-wanghai-gateway-user-id", claims.sub);
  headers.set("x-wanghai-gateway-tenant-id", claims.tenant_id);
  headers.set("x-wanghai-gateway-vault-id", claims.vault_id);
  headers.set("x-wanghai-gateway-role", claims.role);
  headers.set("x-wanghai-gateway-request-id", claims.request_id);
  if (claims.iss === WANGHAI_STANDALONE_ISSUER) {
    headers.set("x-wanghai-gateway-capabilities", claims.capabilities.join(","));
  }
  if (claims.admission) {
    headers.set("x-wanghai-gateway-action", claims.admission.action);
    headers.set("x-wanghai-gateway-action-version", String(claims.admission.action_version));
    headers.set("x-wanghai-gateway-workspace-id", claims.admission.workspace_id);
    headers.set("x-wanghai-gateway-idempotency-key", claims.admission.idempotency_key);
    headers.set("x-wanghai-gateway-request-hash", claims.admission.request_hash);
    if (claims.admission.expected_version !== undefined) {
      headers.set("x-wanghai-gateway-expected-version", String(claims.admission.expected_version));
    }
    if (claims.admission.quota_reservation_id !== undefined) {
      headers.set("x-wanghai-gateway-quota-reservation-id", claims.admission.quota_reservation_id);
    }
  }
  return headers;
}
