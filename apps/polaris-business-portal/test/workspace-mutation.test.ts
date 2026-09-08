import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceVersionConflictError } from "@polaris/business-core/workspace-version";
import { WanghaiGatewayAuthError } from "../lib/gateway-auth.js";
import { mutateAdmittedWorkspace } from "../lib/workspace-mutation.js";

const secret = "0123456789abcdef0123456789abcdef";

function signedAssertion(input: {
  expectedVersion: number;
  requestId: string;
  workspace?: string;
}): string {
  const now = Math.floor(Date.now() / 1_000);
  const encoded = Buffer.from(JSON.stringify({
    v: 1,
    iss: "polaris",
    aud: "wanghai",
    sub: "synthetic-user",
    tenant_id: "synthetic-tenant",
    vault_id: "synthetic-vault",
    role: "operator",
    request_id: input.requestId,
    iat: now - 1,
    exp: now + 60,
    admission: {
      action: "product.update",
      action_version: 1,
      workspace_id: input.workspace ?? "acme",
      idempotency_key: `mutation-${input.requestId}`,
      request_hash: "a".repeat(64),
      expected_version: input.expectedVersion,
      quota_reservation_id: `quota-${input.requestId}`,
    },
  }), "utf8").toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded, "utf8").digest("base64url")}`;
}

function request(input: {
  expectedVersion: number;
  requestId: string;
  workspace?: string;
}): Request {
  return new Request("http://wanghai.test/api/workspaces/acme/products/SKU-001", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-polaris-request-id": input.requestId,
      "x-polaris-wanghai-assertion": signedAssertion(input),
    },
  });
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

test("Wanghai applies a signed workspace version exactly once", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-admitted-mutation-"));
  try {
    await withGatewayEnv(async () => {
      const first = await mutateAdmittedWorkspace({
        request: request({ expectedVersion: 0, requestId: "request-1" }),
        workspace: "acme",
        workspaceRoot,
        mutate: () => "updated",
      });
      assert.deepEqual(first, { result: "updated", workspaceVersion: 1 });

      await assert.rejects(
        mutateAdmittedWorkspace({
          request: request({ expectedVersion: 0, requestId: "request-2" }),
          workspace: "acme",
          workspaceRoot,
          mutate: () => "must-not-run",
        }),
        (error: unknown) => error instanceof WorkspaceVersionConflictError
          && error.statusCode === 409
          && error.currentVersion === 1,
      );

      await assert.rejects(
        mutateAdmittedWorkspace({
          request: request({
            expectedVersion: 1,
            requestId: "request-3",
            workspace: "other",
          }),
          workspace: "acme",
          workspaceRoot,
          mutate: () => "must-not-run",
        }),
        (error: unknown) => error instanceof WanghaiGatewayAuthError
          && error.statusCode === 403,
      );
    });
  } finally {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
  }
});
