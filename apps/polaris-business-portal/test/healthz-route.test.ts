import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../app/healthz/route.js";

test("healthz returns the current release marker", async () => {
  const response = GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "polaris-business-portal",
    release_marker: "2026-09-08-business-portal",
  });
});
