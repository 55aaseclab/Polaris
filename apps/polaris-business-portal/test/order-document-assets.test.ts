import assert from "node:assert/strict";
import test from "node:test";
import { orderDocumentAssetUrl } from "../lib/order-document-assets.js";

test("order document URLs include the workspace assets root", () => {
  assert.equal(
    orderDocumentAssetUrl(
      "songjin",
      "JXY-20260610-001",
      "开票/JXY-20260610-001-X-Logistic-Sàrl-CI-2026-08-06.pdf",
    ),
    "/wanghai/api/workspaces/songjin/assets?path=assets/%E8%AE%A2%E5%8D%95%E7%AE%A1%E7%90%86/JXY-20260610-001/%E5%BC%80%E7%A5%A8/JXY-20260610-001-X-Logistic-S%C3%A0rl-CI-2026-08-06.pdf",
  );
});

test("order document URLs encode a PI PDF under the quote directory", () => {
  assert.equal(
    orderDocumentAssetUrl(
      "songjin",
      "JXY-20260610-001",
      "报价/JXY-20260610-001-X-Logistic-Sàrl-PI-2026-06-14.pdf",
    ),
    "/wanghai/api/workspaces/songjin/assets?path=assets/%E8%AE%A2%E5%8D%95%E7%AE%A1%E7%90%86/JXY-20260610-001/%E6%8A%A5%E4%BB%B7/JXY-20260610-001-X-Logistic-S%C3%A0rl-PI-2026-06-14.pdf",
  );
});
