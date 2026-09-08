import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceVersionConflictError } from "@polaris/business-core/workspace-version";
import { requestError } from "../app/api/_lib";
import { assetResponseHeaders } from "../lib/asset-response";
import { WanghaiGatewayAuthError } from "../lib/gateway-auth";
import {
  RequestPolicyError,
  readFormData,
  readJsonBody,
  readJsonObject,
} from "../lib/request-policy";

test("bounded JSON reads reject declared and streamed oversized bodies", async () => {
  const declared = new Request("http://wanghai.test/api/workspaces", {
    body: "{}",
    headers: { "content-length": "32" },
    method: "POST",
  });
  await assert.rejects(
    readJsonBody(declared, 16),
    (error: unknown) => error instanceof RequestPolicyError && error.statusCode === 413,
  );

  const streamed = new Request("http://wanghai.test/api/workspaces", {
    body: JSON.stringify({ value: "x".repeat(128) }),
    method: "POST",
  });
  await assert.rejects(
    readJsonBody(streamed, 16),
    (error: unknown) => error instanceof RequestPolicyError && error.statusCode === 413,
  );
});

test("bounded JSON reads require a JSON object for mutation routes", async () => {
  const request = new Request("http://wanghai.test/api/workspaces", {
    body: "[]",
    method: "POST",
  });
  await assert.rejects(
    readJsonObject(request),
    (error: unknown) => error instanceof RequestPolicyError && error.statusCode === 400,
  );
});

test("multipart reads are capped before form parsing", async () => {
  const form = new FormData();
  form.set("file", new Blob(["synthetic asset"]), "asset.txt");
  const request = new Request("http://wanghai.test/api/workspaces/demo/products/SKU-001", {
    body: form,
    method: "POST",
  });
  await assert.rejects(
    readFormData(request, 8),
    (error: unknown) => error instanceof RequestPolicyError && error.statusCode === 413,
  );
});

test("asset headers keep tenant data private and do not execute tenant HTML", () => {
  const html = assetResponseHeaders({
    contentType: "text/html; charset=utf-8",
    etag: "\"synthetic\"",
    fileName: "tenant report.html",
    frameAncestorsDirective: "frame-ancestors 'self' https://polaris.example.test",
  });
  assert.equal(html["cache-control"], "private, no-store");
  assert.match(html["content-disposition"] ?? "", /^attachment;/u);
  assert.match(html["content-security-policy"] ?? "", /^sandbox;/u);
  assert.equal(html["x-content-type-options"], "nosniff");

  const svg = assetResponseHeaders({
    contentType: "image/svg+xml",
    fileName: "tenant-asset.svg",
    frameAncestorsDirective: "frame-ancestors 'self' https://polaris.example.test",
  });
  assert.equal(svg["cache-control"], "private, no-store");
  assert.match(svg["content-security-policy"] ?? "", /^sandbox;/u);

  const pdf = assetResponseHeaders({
    contentType: "application/pdf",
    fileName: "tenant-report.pdf",
    frameAncestorsDirective: "frame-ancestors 'self' https://polaris.example.test",
  });
  assert.match(pdf["content-security-policy"] ?? "", /^sandbox;/u);
});

test("gateway authorization errors retain their server-side status", async () => {
  const response = requestError(
    new WanghaiGatewayAuthError("Admin role required", 403),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Admin role required" });
});

test("workspace version conflicts retain their current version", async () => {
  const response = requestError(
    new WorkspaceVersionConflictError("Workspace version is stale", 7),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Workspace version is stale",
    workspace_version: 7,
  });
});
