import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultOrderMeta,
  defaultSubmoduleMeta,
  ensureOrderDirs,
  orderDirPath,
  writeOrderMeta,
  writeSubmoduleMeta,
} from "../src/operations.js";
import { createProduct } from "../src/products.js";
import { generateTradeDocument } from "../src/trade-documents.js";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const PAYMENT_PLACEHOLDERS = [
  "ACCOUNT_NAME",
  "ACCOUNT_NAME_NOTE",
  "ACCOUNT_NUMBER",
  "SWIFT_BIC",
  "BANK_NAME",
  "BANK_ADDRESS",
  "BANK_COUNTRY",
  "ACCOUNT_TYPE",
  "BANK_CODE",
  "PAYMENT_METHOD",
  "PAYMENT_NOTES",
];

test("PI and CI templates share the complete payment-information contract", () => {
  for (const template of ["proforma-invoice-template.html", "commercial-invoice-template.html"]) {
    const html = fs.readFileSync(path.join(PACKAGE_ROOT, "assets", template), "utf8");
    for (const placeholder of PAYMENT_PLACEHOLDERS) {
      assert.match(html, new RegExp(`\\{\\{${placeholder}\\}\\}`, "u"));
    }
    assert.doesNotMatch(html, /\{\{(?:BENEFICIARY|ACCOUNT_NO|SWIFT_CODE)\}\}/u);
  }
});

test("PI and CI regeneration follows the order currency over stale submodule currency", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-trade-documents-"));
  const orderNo = "ORDER-SYNTHETIC-001";
  try {
    ensureOrderDirs(root, orderNo);

    const order = defaultOrderMeta(orderNo);
    order.currency = "USD";
    order.totals = { items_subtotal: 0, shipping: 0, customer_payable: 0 };
    writeOrderMeta(root, orderNo, order);

    for (const kind of ["quotes", "invoices"] as const) {
      const record = defaultSubmoduleMeta(kind, orderNo);
      record.currency = "CNY";
      writeSubmoduleMeta(root, orderNo, kind, record);

      const generated = await generateTradeDocument(root, orderNo, kind);
      const htmlPath = generated.relativePath.replace(/\.pdf$/u, ".html");
      const html = fs.readFileSync(path.join(orderDirPath(root, orderNo), htmlPath), "utf8");

      assert.equal(generated.record.currency, "USD");
      assert.match(html, /UNIT PRICE \(USD\/ITEM\)/u);
      assert.match(html, /TOTAL USD:/u);
      assert.doesNotMatch(html, /UNIT PRICE \(CNY\/ITEM\)|TOTAL CNY:/u);
    }
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("PI and CI convert CNY product prices into USD with the order exchange rate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-trade-document-currency-"));
  const orderNo = "ORDER-SYNTHETIC-002";
  try {
    ensureOrderDirs(root, orderNo);
    createProduct(root, {
      id: 7,
      name: "Example Product",
      nameEn: "Example Product",
      pricing: { currency: "CNY", listPrice: 459, market: "CN" },
      sku: "SKU-5-1-001",
      skuSubcategory: "test_products",
    });

    const order = defaultOrderMeta(orderNo);
    order.currency = "USD";
    order.lines = [{ product_id: 7, quantity: 1 }];
    order.payment = { ...(order.payment as Record<string, unknown>), exchange_rate: 6.72 };
    order.totals = { items_subtotal: 68.3, shipping: 0, customer_payable: 68.3 };
    writeOrderMeta(root, orderNo, order);

    for (const kind of ["quotes", "invoices"] as const) {
      const record = defaultSubmoduleMeta(kind, orderNo);
      record.currency = "CNY";
      writeSubmoduleMeta(root, orderNo, kind, record);

      const generated = await generateTradeDocument(root, orderNo, kind);
      const item = (generated.record.items as Array<Record<string, unknown>>)[0];
      const htmlPath = generated.relativePath.replace(/\.pdf$/u, ".html");
      const html = fs.readFileSync(path.join(orderDirPath(root, orderNo), htmlPath), "utf8");

      assert.equal(item?.unit_price_usd_per_kg, 68.3);
      assert.equal(item?.amount_usd, 68.3);
      assert.match(html, />68\.3</u);
      assert.doesNotMatch(html, />459</u);
    }
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
