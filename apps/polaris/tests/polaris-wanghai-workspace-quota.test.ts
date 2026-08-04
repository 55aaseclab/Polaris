import assert from "node:assert/strict";
import test from "node:test";
import { matchWanghaiMutationAction } from "../scripts/portal/wanghai-mutation-catalog.js";
import {
  prepareWanghaiMutationAdmission,
} from "../scripts/portal/wanghai-mutation-admission.js";
import {
  activeWorkspaceQuotaBytes,
  DEFAULT_ACTIVE_WORKSPACE_QUOTA_BYTES,
  estimateWanghaiWorkspaceGrowth,
  WanghaiWorkspaceQuotaError,
} from "../scripts/portal/wanghai-workspace-quota.js";

function admission(method: string, pathname: string) {
  const match = matchWanghaiMutationAction({ method, pathname });
  assert.ok(match);
  const body = match.action.body === "empty"
    ? Buffer.alloc(0)
    : Buffer.from('{"workspace_id":"acme","asset_path":"outputs/manual-review-list.json"}', "utf8");
  return prepareWanghaiMutationAdmission({
    match,
    body,
    contentType: match.action.body === "empty" ? undefined : "application/json",
    idempotencyKey: "quota-test-001",
    expectedVersion: "0",
    tenantId: "tenant-a",
    vaultId: "vault-a",
    userId: "user-a",
  });
}

test("workspace quota uses the reviewed development default and validates release configuration", () => {
  assert.equal(activeWorkspaceQuotaBytes({}), DEFAULT_ACTIVE_WORKSPACE_QUOTA_BYTES);
  assert.equal(activeWorkspaceQuotaBytes({
    POLARIS_ACTIVE_WORKSPACE_QUOTA_BYTES: "1048576",
  }), 1_048_576);
  assert.throws(
    () => activeWorkspaceQuotaBytes({ POLARIS_RELEASE_PROFILE: "0.3.0-single-host" }),
    WanghaiWorkspaceQuotaError,
  );
  assert.throws(
    () => activeWorkspaceQuotaBytes({ POLARIS_ACTIVE_WORKSPACE_QUOTA_BYTES: "invalid" }),
    WanghaiWorkspaceQuotaError,
  );
});

test("workspace quota estimates bounded JSON, export, and delete mutations conservatively", () => {
  const update = admission("PUT", "/api/workspaces/acme/products/SKU-001");
  assert.equal(
    estimateWanghaiWorkspaceGrowth({
      admission: update,
      measuredUsageBytes: 100,
      requestBodyBytes: 200,
    }),
    4 * 1024 * 1024 + 200,
  );

  const exportReview = admission("POST", "/api/workspaces/acme/manual-review");
  assert.equal(
    estimateWanghaiWorkspaceGrowth({
      admission: exportReview,
      measuredUsageBytes: 32 * 1024 * 1024,
      requestBodyBytes: 200,
    }),
    32 * 1024 * 1024,
  );

  const deletion = admission("DELETE", "/api/workspaces/acme/products/SKU-001");
  assert.equal(
    estimateWanghaiWorkspaceGrowth({
      admission: deletion,
      measuredUsageBytes: 100,
      requestBodyBytes: 0,
    }),
    0,
  );
});
