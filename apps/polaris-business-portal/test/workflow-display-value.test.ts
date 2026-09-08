import assert from "node:assert/strict";
import test from "node:test";
import { compactWorkspaceDisplayValue } from "../lib/workflow-display-value.js";

test("compactWorkspaceDisplayValue collapses workflow absolute paths", () => {
  assert.equal(
    compactWorkspaceDisplayValue(
      "/synthetic/polaris-data/workspaces/literature-review/workflows/rust-for-linux/report-writing",
      "/synthetic/polaris-data/workspaces/literature-review",
    ),
    "<workflows>/rust-for-linux/report-writing",
  );
});

test("compactWorkspaceDisplayValue collapses workspace root paths", () => {
  assert.equal(
    compactWorkspaceDisplayValue(
      "/synthetic/polaris-data/workspaces/literature-review/assets/products/demo.json",
      "/synthetic/polaris-data/workspaces/literature-review",
    ),
    "<workspace>/assets/products/demo.json",
  );
});

test("compactWorkspaceDisplayValue also rewrites embedded paths", () => {
  assert.equal(
    compactWorkspaceDisplayValue(
      "{\"path\":\"/synthetic/polaris-data/workspaces/literature-review/workflows/demo/outputs/report.pdf\"}",
      "/synthetic/polaris-data/workspaces/literature-review",
    ),
    "{\"path\":\"<workflows>/demo/outputs/report.pdf\"}",
  );
});
