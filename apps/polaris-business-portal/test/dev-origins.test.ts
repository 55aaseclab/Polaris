import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAllowedDevOrigins } from "../lib/dev-origins.js";

test("normalizeAllowedDevOrigins keeps hostnames for Next dev checks", () => {
  assert.deepEqual(
    normalizeAllowedDevOrigins("http://128.178.122.228:9090 https://example.test:9443 local.test"),
    ["128.178.122.228", "example.test", "local.test"],
  );
});

test("normalizeAllowedDevOrigins ignores empty whitespace", () => {
  assert.deepEqual(normalizeAllowedDevOrigins("  \n\t  "), []);
});
