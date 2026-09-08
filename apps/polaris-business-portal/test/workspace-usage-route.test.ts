import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resetRepoRootCachesForTests } from "@polaris/business-core/repo";
import { measureWorkspaceUsage } from "@polaris/business-core/workspace-usage";
import { handleWorkspaceUsageRequest } from "../app/api/internal/workspace-usage/handler.js";

const secret = "0123456789abcdef0123456789abcdef";

function signedAssertion(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1_000);
  const encoded = Buffer.from(JSON.stringify({
    v: 1,
    iss: "polaris",
    aud: "wanghai",
    sub: "synthetic-user",
    tenant_id: "synthetic-tenant",
    vault_id: "synthetic-vault",
    role: "operator",
    request_id: "quota-measurement-request",
    iat: now - 1,
    exp: now + 60,
    quota_measurement: "active_workspace",
    ...overrides,
  }), "utf8").toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded, "utf8").digest("base64url")}`;
}

test("workspace usage route measures only a Polaris-signed vault workspace root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-workspace-usage-route-"));
  const previous = {
    dataRoot: process.env.WANGHAI_DATA_ROOT,
    mode: process.env.WANGHAI_RUNTIME_MODE,
    secret: process.env.WANGHAI_GATEWAY_ASSERTION_SECRET,
    tenant: process.env.WANGHAI_GATEWAY_TENANT_ID,
    vault: process.env.WANGHAI_GATEWAY_VAULT_ID,
  };
  try {
    fs.mkdirSync(path.join(root, "workspaces", "acme"), { recursive: true });
    fs.writeFileSync(path.join(root, "workspaces", "acme", "asset.txt"), "workspace", "utf8");
    process.env.WANGHAI_RUNTIME_MODE = "polaris";
    process.env.WANGHAI_DATA_ROOT = root;
    process.env.WANGHAI_GATEWAY_ASSERTION_SECRET = secret;
    process.env.WANGHAI_GATEWAY_TENANT_ID = "synthetic-tenant";
    process.env.WANGHAI_GATEWAY_VAULT_ID = "synthetic-vault";
    resetRepoRootCachesForTests();

    const response = await handleWorkspaceUsageRequest(new Request("http://wanghai.test/api/internal/workspace-usage", {
      headers: {
        "x-polaris-request-id": "quota-measurement-request",
        "x-polaris-wanghai-assertion": signedAssertion(),
      },
    }), () => measureWorkspaceUsage({ rootDir: path.join(root, "workspaces") }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      schema_version: 1,
      category: "active_workspace",
      usage_bytes: 9,
      file_count: 1,
      entry_count: 2,
    });

    const denied = await handleWorkspaceUsageRequest(new Request("http://wanghai.test/api/internal/workspace-usage", {
      headers: {
        "x-polaris-request-id": "quota-measurement-request",
        "x-polaris-wanghai-assertion": signedAssertion({ quota_measurement: undefined }),
      },
    }), () => measureWorkspaceUsage({ rootDir: path.join(root, "workspaces") }));
    assert.equal(denied.status, 403);
  } finally {
    if (previous.dataRoot === undefined) delete process.env.WANGHAI_DATA_ROOT;
    else process.env.WANGHAI_DATA_ROOT = previous.dataRoot;
    if (previous.mode === undefined) delete process.env.WANGHAI_RUNTIME_MODE;
    else process.env.WANGHAI_RUNTIME_MODE = previous.mode;
    if (previous.secret === undefined) delete process.env.WANGHAI_GATEWAY_ASSERTION_SECRET;
    else process.env.WANGHAI_GATEWAY_ASSERTION_SECRET = previous.secret;
    if (previous.tenant === undefined) delete process.env.WANGHAI_GATEWAY_TENANT_ID;
    else process.env.WANGHAI_GATEWAY_TENANT_ID = previous.tenant;
    if (previous.vault === undefined) delete process.env.WANGHAI_GATEWAY_VAULT_ID;
    else process.env.WANGHAI_GATEWAY_VAULT_ID = previous.vault;
    resetRepoRootCachesForTests();
    fs.rmSync(root, { force: true, recursive: true });
  }
});
