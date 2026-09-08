import assert from "node:assert/strict";
import test from "node:test";
import {
  coerceAdminPortalLocale,
  getAdminPortalText,
  translateAdminPortalInline,
  translateAdminPortalInlineText,
} from "../lib/i18n.js";

test("coerceAdminPortalLocale only accepts supported locales", () => {
  assert.equal(coerceAdminPortalLocale("en-US"), "en-US");
  assert.equal(coerceAdminPortalLocale("zh-CN"), "zh-CN");
  assert.equal(coerceAdminPortalLocale("fr-FR"), "zh-CN");
  assert.equal(coerceAdminPortalLocale(null), "zh-CN");
});

test("keyed messages resolve through the centralized catalog", () => {
  assert.equal(
    getAdminPortalText("en-US", "workspaceShell.header.home"),
    "Home",
  );
  assert.equal(
    getAdminPortalText("zh-CN", "workspaceShell.header.home"),
    "主页",
  );
});

test("inline translations format template values", () => {
  assert.equal(
    translateAdminPortalInline("en-US", "已上传 {count} 个素材", { count: 3 }),
    "Uploaded 3 assets",
  );
  assert.equal(
    translateAdminPortalInlineText("en-US", "已创建 review-20260731"),
    "Created review-20260731",
  );
});

test("inline translations cover fragment strings used around dynamic UI values", () => {
  assert.equal(
    translateAdminPortalInlineText("en-US", "状态刷新 "),
    "Status refreshed ",
  );
  assert.equal(
    translateAdminPortalInlineText("en-US", " · 原始素材预览"),
    " · source asset preview",
  );
  assert.equal(
    translateAdminPortalInlineText("zh-CN", "状态刷新 "),
    "状态刷新 ",
  );
});
