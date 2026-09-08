import assert from "node:assert/strict";
import test from "node:test";
import {
  assetManagementHeader,
  assetManagementTitle,
  isAssetManagementView,
  resolveAssetManagementNavigation,
} from "../lib/asset-management-navigation.js";

test("ecommerce asset library exposes product, order, and research entry points", () => {
  const navigation = resolveAssetManagementNavigation("ecommerce");

  assert.equal(navigation.sectionLabel, null);
  assert.deepEqual(navigation.sectionItems, []);
  assert.deepEqual(
    navigation.extraItems,
    [
      { label: "产品管理", view: "product-library" },
      { label: "订单管理", view: "order-management" },
      { label: "市场调研", view: null },
    ],
  );
  assert.equal(navigation.searchEnabled, false);
});

test("research asset library exposes literature review and submission management", () => {
  const navigation = resolveAssetManagementNavigation("research");

  assert.equal(navigation.sectionLabel, null);
  assert.deepEqual(navigation.sectionItems, []);
  assert.deepEqual(navigation.extraItems, [
    { label: "文献综述", view: "literature-review" },
    { label: "投稿管理", view: "submission-management" },
  ]);
  assert.equal(navigation.searchEnabled, false);
  assert.equal(assetManagementTitle("literature-review"), "文献综述");
  assert.deepEqual(assetManagementHeader("literature-review"), {
    label: "文献综述",
    title: "文献综述",
  });
  assert.equal(assetManagementTitle("submission-management"), "投稿管理");
  assert.deepEqual(assetManagementHeader("submission-management"), {
    label: "投稿管理",
    title: "投稿管理",
  });
});

test("asset management view parser accepts submission management", () => {
  assert.equal(isAssetManagementView("submission-management"), true);
  assert.equal(isAssetManagementView("literature-review"), true);
  assert.equal(isAssetManagementView("seo-ops"), true);
  assert.equal(isAssetManagementView(null), false);
});
