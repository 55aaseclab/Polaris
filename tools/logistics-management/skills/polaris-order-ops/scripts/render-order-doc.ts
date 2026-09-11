import fs from "node:fs";
import path from "node:path";
import { readAndValidateOrderMeta } from "../../../packages/polaris-business-core/src/operations.js";
import { assertPolarisBusinessCommand } from "../../../packages/polaris-business-core/src/runtime.js";

const [metaPath, templatePath, outputPath] = process.argv.slice(2);
if (!metaPath || !templatePath || !outputPath) {
  console.error("Usage: tsx scripts/render-order-doc.ts <meta.json> <template.html> <output.html>");
  process.exit(1);
}

assertPolarisBusinessCommand("render");
const meta = readAndValidateOrderMeta(metaPath);
let html = fs.readFileSync(templatePath, "utf-8");
const documents = Array.isArray(meta.documents) ? meta.documents : [];
const replacements: Record<string, string> = {
  "{{订单号}}": String(meta.order_no ?? ""),
  "{{客户名称}}": String((meta.customer as Record<string, unknown>)?.name ?? ""),
  "{{币种}}": String(meta.currency ?? ""),
  "{{建档日期}}": String((meta.dates as Record<string, unknown>)?.created_at ?? ""),
  "{{订单状态}}": String(meta.status ?? ""),
  "{{收货国家}}": String((meta.customer as Record<string, unknown>)?.country ?? ""),
  "{{下单日期}}": String((meta.dates as Record<string, unknown>)?.order_date ?? ""),
  "{{发票需求}}": String((meta.reconciliation as Record<string, unknown>)?.invoice_amount ?? ""),
  "{{付款状态}}": String((meta.payment as Record<string, unknown>)?.status ?? ""),
  "{{销售渠道}}": String((meta.source as Record<string, unknown>)?.channel ?? ""),
  "{{备注}}": Array.isArray(meta.notes) ? meta.notes.join("；") : "",
  "{{订单主记录状态}}": String(meta.status ?? ""),
  "{{订单主记录说明}}": String((meta.archive as Record<string, unknown>)?.location ?? ""),
  "{{报检单状态}}": String(documents.length > 0 ? "已归档" : "待补充"),
  "{{报检单说明}}": "",
  "{{收款凭证状态}}": String((meta.payment as Record<string, unknown>)?.status ?? ""),
  "{{收款凭证说明}}": String((meta.payment as Record<string, unknown>)?.method ?? ""),
  "{{发货记录状态}}": String((meta.fulfillment as Record<string, unknown>)?.status ?? ""),
  "{{发货记录说明}}": String((meta.fulfillment as Record<string, unknown>)?.tracking_no ?? ""),
  "{{开票记录状态}}": String((meta.reconciliation as Record<string, unknown>)?.invoice_amount ?? null ? "已记录" : "待记录"),
  "{{开票记录说明}}": "",
  "{{对账记录状态}}": String((meta.reconciliation as Record<string, unknown>)?.status ?? ""),
  "{{对账记录说明}}": String((meta.reconciliation as Record<string, unknown>)?.difference ?? ""),
};
for (const [token, value] of Object.entries(replacements)) {
  html = html.replaceAll(token, value);
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, html, "utf-8");
console.log(outputPath);
