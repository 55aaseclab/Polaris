import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PolarisControlStore } from "../scripts/portal/control-store.js";
import {
  checkWanghaiGatewayPolicy,
  classifyWanghaiGatewayRequest,
  WanghaiGatewayPolicyError,
} from "../scripts/portal/wanghai-gateway-policy.js";

function temporaryStore(): { root: string; store: PolarisControlStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-wanghai-policy-"));
  return {
    root,
    store: PolarisControlStore.open(path.join(root, "control.sqlite")),
  };
}

function policyInput(store: PolarisControlStore, overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "synthetic-tenant",
    vaultId: "synthetic-vault",
    userId: "synthetic-user",
    role: "operator" as const,
    method: "GET",
    pathname: "/api/workspaces",
    store,
    ...overrides,
  };
}

test("gateway policy classifies uploads and keeps role decisions in Polaris", () => {
  const fixture = temporaryStore();
  try {
    assert.equal(classifyWanghaiGatewayRequest({
      method: "GET",
      pathname: "/api/workspaces",
    }), "read");
    assert.equal(classifyWanghaiGatewayRequest({
      method: "POST",
      pathname: "/api/workspaces/demo/products/SKU-001",
      contentType: "multipart/form-data; boundary=synthetic",
    }), "upload");
    assert.equal(checkWanghaiGatewayPolicy(policyInput(fixture.store, {
      role: "viewer",
      method: "POST",
    })).statusCode, 403);
    assert.equal(checkWanghaiGatewayPolicy(policyInput(fixture.store, {
      pathname: "/api/workspaces/demo/outreach",
      method: "POST",
    })).statusCode, 403);
    assert.equal(checkWanghaiGatewayPolicy(policyInput(fixture.store, {
      role: "admin",
      pathname: "/api/workspaces/demo/outreach",
      method: "POST",
    })).allowed, true);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("gateway policy returns a rate decision from the durable store", () => {
  const fixture = temporaryStore();
  try {
    const env = {
      POLARIS_WANGHAI_RATE_LIMIT_READS_PER_MINUTE: "1",
    } as NodeJS.ProcessEnv;
    const first = checkWanghaiGatewayPolicy(policyInput(fixture.store, { env }));
    assert.equal(first.allowed, true);
    assert.equal(first.rateLimit?.remaining, 0);
    const second = checkWanghaiGatewayPolicy(policyInput(fixture.store, { env }));
    assert.equal(second.allowed, false);
    assert.equal(second.statusCode, 429);
    assert.equal(second.rateLimit?.limit, 1);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("gateway policy fails closed for invalid rate configuration", () => {
  const fixture = temporaryStore();
  try {
    assert.throws(
      () => checkWanghaiGatewayPolicy(policyInput(fixture.store, {
        env: { POLARIS_WANGHAI_RATE_LIMIT_READS_PER_MINUTE: "zero" },
      })),
      (error: unknown) => error instanceof WanghaiGatewayPolicyError
        && error.statusCode === 503,
    );
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
