import assert from "node:assert/strict";
import test from "node:test";
import { buildPortalRequestHeaders } from "./request-headers.js";

test("portal requests include the bearer token when one is available", () => {
  const headers = buildPortalRequestHeaders(undefined, "polaris-token");
  assert.equal(headers.get("authorization"), "Bearer polaris-token");
});

test("portal requests preserve an explicit authorization header", () => {
  const headers = buildPortalRequestHeaders({ authorization: "Bearer custom" }, "polaris-token");
  assert.equal(headers.get("authorization"), "Bearer custom");
});
