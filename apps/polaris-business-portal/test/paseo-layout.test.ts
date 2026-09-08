import assert from "node:assert/strict";
import test from "node:test";
import { showLeftPaseoOverlay } from "../lib/paseo-layout.js";

test("showLeftPaseoOverlay only enables the left overlay when Paseo is in the left sidebar", () => {
  assert.equal(showLeftPaseoOverlay("paseo", false), true);
  assert.equal(showLeftPaseoOverlay("paseo", true), false);
  assert.equal(showLeftPaseoOverlay("workflows", false), false);
  assert.equal(showLeftPaseoOverlay("assets", false), false);
});
