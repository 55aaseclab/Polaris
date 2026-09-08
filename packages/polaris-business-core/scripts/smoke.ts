import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultOrderMeta, ensureOrderDirs, listCustomers, listOrders, readAndValidateProductMeta, safeWorkspacePath, writeJsonFile, writeOrderMeta, writeSubmoduleMeta, defaultSubmoduleMeta } from "../src/index.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-core-smoke-"));
try {
  assert(safeWorkspacePath(tmp, "产品管理/test.txt").startsWith(tmp), "safeWorkspacePath should resolve inside root");
  let rejected = false;
  try {
    safeWorkspacePath(tmp, "../outside.txt");
  } catch {
    rejected = true;
  }
  assert(rejected, "safeWorkspacePath should reject traversal");

  const metaPath = path.join(tmp, "meta.json");
  writeJsonFile(metaPath, {
    schema: "wanghai.promo.product-meta",
    schema_version: 5,
    sku: "SKU-1-1-001",
    sku_category: "wear",
    sku_subcategory: "earrings",
    id: 1,
    name: "测试产品",
    name_en: null,
    status: "draft",
    inventory: 1,
    include_in_external: true,
    packaging: {
      normal: { dimensions_mm: { length: null, width: null, height: null }, weight_with_packaging_kg: null },
      gift: { dimensions_mm: { length: null, width: null, height: null }, weight_with_packaging_kg: null },
    },
    pricing: {
      default_market: "CN",
      costs: { currency: "CNY", purchase_price: null, packaging_price: null, labor_price: null },
      markets: { CN: { currency: "CNY", list_price: null, promo_price: null, floor_price: null } },
    },
    copy: { title: null, selling_points: [], description: null, faq: [] },
    source: null,
    assets: {
      figures_dir: "产品管理/产品库/SKU-1-1-001",
      source_dir: "产品管理/产品库/SKU-1-1-001/assets",
      selected: { near: null, wear: null, detail: null },
      promo_usage_image: null,
    },
    notes: [],
  });
  assert(readAndValidateProductMeta(metaPath).schema_version === 5, "product meta should validate");

  fs.mkdirSync(path.join(tmp, "订单管理"), { recursive: true });
  const order = defaultOrderMeta("JXY-20260101-001");
  order.customer = { name: "客户", country: null, contact_name: null, contact_email: null };
  ensureOrderDirs(tmp, "JXY-20260101-001");
  writeOrderMeta(tmp, "JXY-20260101-001", order);
  for (const kind of ["quotes", "inspections", "payments", "shipments", "invoices", "reconciliations", "archives", "attachments"] as const) {
    writeSubmoduleMeta(tmp, "JXY-20260101-001", kind, defaultSubmoduleMeta(kind, "JXY-20260101-001"));
  }
  assert(listOrders(tmp).length === 1, "order folder should be listed");
  const customers = listCustomers(tmp);
  assert(customers.length === 1 && customers[0].name === "客户" && customers[0].order_count === 1, "customer summary should be derived from order metadata");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("wanghai-core smoke checks passed");
