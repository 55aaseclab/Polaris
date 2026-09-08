import assert from "node:assert/strict";
import test from "node:test";
import { selectBrainWorkflowMode } from "../lib/brain-workflow-mode.js";

test("selectBrainWorkflowMode suppresses home mode before workspaces are ready", () => {
  assert.equal(selectBrainWorkflowMode(null, false), null);
  assert.equal(selectBrainWorkflowMode("research", false), null);
  assert.equal(selectBrainWorkflowMode("ecommerce", false), null);
});

test("selectBrainWorkflowMode resolves research and dtc modes after bootstrap", () => {
  assert.equal(selectBrainWorkflowMode("research", true), "research");
  assert.equal(selectBrainWorkflowMode("ecommerce", true), "dtc");
  assert.equal(selectBrainWorkflowMode("unclassified", true), "dtc");
});
