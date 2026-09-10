import assert from "node:assert/strict";
import test from "node:test";
import { formatRunDateTime } from "./formatters.js";

test("formats run timestamps with date, hour, and minute", () => {
  assert.equal(
    formatRunDateTime("2026-08-11T16:22:37.000Z"),
    "2026-08-11 16:22",
  );
});
