import assert from "node:assert/strict";
import test from "node:test";
import { shouldSyncAssetSidebarToAssets } from "../lib/asset-management-sidebar.js";

test("syncs the sidebar only when the active asset-management view changes", () => {
  assert.equal(shouldSyncAssetSidebarToAssets(null, "product-library"), true);
  assert.equal(shouldSyncAssetSidebarToAssets("product-library", "product-library"), false);
  assert.equal(shouldSyncAssetSidebarToAssets("product-library", "product-gallery"), true);
  assert.equal(shouldSyncAssetSidebarToAssets("product-library", null), false);
});
