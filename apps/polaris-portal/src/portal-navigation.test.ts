import assert from "node:assert/strict";
import test from "node:test";
import { canPopTo, historyFrom, normalizeHistoryPath } from "./portal-navigation.js";

test("reads the previous path from history state", () => {
  assert.equal(historyFrom(undefined), "");
  assert.equal(historyFrom({}), "");
  assert.equal(historyFrom({ from: "/work" }), "/work");
});

test("treats work desk paths as the same history target", () => {
  assert.equal(normalizeHistoryPath("/work/"), "/work");
  assert.equal(normalizeHistoryPath("/work?pack=literature"), "/work");
  assert.equal(normalizeHistoryPath("/work/runs/run-1"), "/work/runs/run-1");
});

test("pops back only when the previous entry is the fallback", () => {
  assert.equal(canPopTo({ from: "/work" }, "/work"), true);
  assert.equal(canPopTo({ from: "/work/" }, "/work"), true);
  assert.equal(canPopTo({ from: "/settings/workflows" }, "/work"), false);
  assert.equal(canPopTo({ from: "/work/runs/run-1" }, "/work"), false);
  assert.equal(canPopTo({ from: "/work/runs/run-1" }, "/work/runs/run-1"), true);
  assert.equal(canPopTo(null, "/work"), false);
});
