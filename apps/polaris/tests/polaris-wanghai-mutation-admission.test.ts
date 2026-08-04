import assert from "node:assert/strict";
import test from "node:test";
import { matchWanghaiMutationAction } from "../scripts/portal/wanghai-mutation-catalog.js";
import {
  maxWanghaiMutationBodyBytes,
  prepareWanghaiMutationAdmission,
  wanghaiAssertionAdmission,
  WanghaiMutationAdmissionError,
} from "../scripts/portal/wanghai-mutation-admission.js";

function match(method: string, pathname: string) {
  const result = matchWanghaiMutationAction({ method, pathname });
  assert.ok(result);
  return result;
}

function admissionInput(overrides: Record<string, unknown> = {}) {
  return {
    match: match("PUT", "/api/workspaces/acme/products/SKU-001"),
    body: Buffer.from('{"name":"Sample","inventory":2}', "utf8"),
    contentType: "application/json; charset=utf-8",
    idempotencyKey: "mutation-001",
    query: [],
    tenantId: "tenant-a",
    vaultId: "vault-a",
    userId: "user-a",
    ...overrides,
  };
}

test("Wanghai mutation admission fingerprints normalized JSON and query pairs", () => {
  const first = prepareWanghaiMutationAdmission(admissionInput({
    body: Buffer.from('{"inventory":2,"name":"Sample"}', "utf8"),
    query: [["path", "assets/a"], ["v", "1"]],
  }));
  const reordered = prepareWanghaiMutationAdmission(admissionInput({
    body: Buffer.from('{"name":"Sample","inventory":2}', "utf8"),
    query: [["v", "1"], ["path", "assets/a"]],
  }));
  const changed = prepareWanghaiMutationAdmission(admissionInput({
    body: Buffer.from('{"name":"Changed","inventory":2}', "utf8"),
    query: [["v", "1"], ["path", "assets/a"]],
  }));

  assert.equal(first.requestHash, reordered.requestHash);
  assert.notEqual(first.requestHash, changed.requestHash);
  assert.notEqual(first.idempotencyScope, prepareWanghaiMutationAdmission(admissionInput({
    tenantId: "tenant-b",
  })).idempotencyScope);
  assert.deepEqual(wanghaiAssertionAdmission(first), {
    action: "product.update",
    actionVersion: 1,
    workspaceId: "acme",
    idempotencyKey: "mutation-001",
    requestHash: first.requestHash,
  });
});

test("Wanghai mutation admission derives a created workspace from bounded JSON", () => {
  const created = prepareWanghaiMutationAdmission({
    match: match("POST", "/api/workspaces"),
    body: Buffer.from('{"workspace_type":"research","workspace_id":"new-workspace"}', "utf8"),
    contentType: "application/json",
    idempotencyKey: "create-workspace-001",
    expectedVersion: "0",
    tenantId: "tenant-a",
    vaultId: "vault-a",
    userId: "user-a",
  });
  assert.equal(created.workspaceId, "new-workspace");
  assert.equal(created.expectedVersion, 0);
});

test("Wanghai mutation admission rejects missing keys, wrong body types, and malformed limits", () => {
  assert.throws(
    () => prepareWanghaiMutationAdmission(admissionInput({ idempotencyKey: "" })),
    (error: unknown) => error instanceof WanghaiMutationAdmissionError
      && error.statusCode === 428,
  );
  assert.throws(
    () => prepareWanghaiMutationAdmission(admissionInput({ contentType: "text/plain" })),
    (error: unknown) => error instanceof WanghaiMutationAdmissionError
      && error.statusCode === 415,
  );
  assert.throws(
    () => prepareWanghaiMutationAdmission(admissionInput({ expectedVersion: "next" })),
    /expected version/u,
  );
  assert.throws(
    () => maxWanghaiMutationBodyBytes(match("POST", "/api/workspaces/acme/products/SKU-001").action, {
      POLARIS_WANGHAI_MAX_UPLOAD_BYTES: "too-large",
    }),
    /positive byte count/u,
  );
});

test("Wanghai mutation admission fingerprints multipart payloads without parsing files", () => {
  const upload = match("POST", "/api/workspaces/acme/products/SKU-001");
  const first = prepareWanghaiMutationAdmission({
    match: upload,
    body: Buffer.from("synthetic-multipart-body", "utf8"),
    contentType: "multipart/form-data; boundary=synthetic",
    idempotencyKey: "upload-001",
    tenantId: "tenant-a",
    vaultId: "vault-a",
    userId: "user-a",
  });
  const changed = prepareWanghaiMutationAdmission({
    match: upload,
    body: Buffer.from("changed-multipart-body", "utf8"),
    contentType: "multipart/form-data; boundary=synthetic",
    idempotencyKey: "upload-001",
    tenantId: "tenant-a",
    vaultId: "vault-a",
    userId: "user-a",
  });
  assert.notEqual(first.requestHash, changed.requestHash);
  assert.equal(maxWanghaiMutationBodyBytes(upload.action), 25 * 1024 * 1024);
});
