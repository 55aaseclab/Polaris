import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isJsonObject, type JsonObject, writeJsonFileAtomic } from "../../../packages/polaris-business-core/src/json.js";
import { readAndValidateOrderMeta, validateSubmoduleMeta } from "../../../packages/polaris-business-core/src/operations.js";
import { findProductById } from "../../../packages/polaris-business-core/src/products.js";
import { assertPolarisBusinessCommand } from "../../../packages/polaris-business-core/src/runtime.js";

type DocumentRef = { label: string; path: string; kind: string };

const args = parseArgs(process.argv.slice(2));
assertPolarisBusinessCommand("render");
const orderDir = args.orderDir;
if (!orderDir) {
  console.error("Usage: tsx scripts/render-quote.ts <订单管理/order_no> [--date YYYY-MM-DD] [--no-pdf]");
  process.exit(1);
}

const resolvedOrderDir = path.resolve(orderDir);
const workspaceRoot = path.resolve(resolvedOrderDir, "..", "..");
const orderMetaPath = path.join(resolvedOrderDir, "meta.json");
const quoteMetaPath = path.join(resolvedOrderDir, "报价", "meta.json");
const quoteDir = path.join(resolvedOrderDir, "报价");

const order = readAndValidateOrderMeta(orderMetaPath);
const quote = readQuoteMeta(quoteMetaPath);
const orderNo = stringValue(order.order_no);
const quoteDate = args.date ?? today();
const quoteNo = stringValue(quote.quote_no) || `Q-${orderNo}`;
const currency = stringValue(quote.currency) || stringValue(order.currency) || "CNY";
const customer = objectValue(order.customer);
const dates = objectValue(order.dates);
const totals = objectValue(quote.totals);
const items = arrayValue(quote.items);
const customerName = stringValue(customer.name) || "客户";
const safeCustomerName = safeFilename(customerName);
const htmlName = `${orderNo}-${safeCustomerName}-报价单-${quoteDate.replaceAll("-", "")}.html`;
const pdfName = `${orderNo}-${safeCustomerName}-报价单-${quoteDate.replaceAll("-", "")}.pdf`;
const htmlPath = path.join(quoteDir, htmlName);
const pdfPath = path.join(quoteDir, pdfName);

fs.mkdirSync(quoteDir, { recursive: true });
fs.writeFileSync(htmlPath, renderHtml(), "utf-8");

if (!args.noPdf) {
  renderPdf(htmlPath, pdfPath);
}

const documents: DocumentRef[] = [{ label: htmlName, path: `报价/${htmlName}`, kind: "quote" }];
if (!args.noPdf) documents.push({ label: pdfName, path: `报价/${pdfName}`, kind: "quote" });

quote.quote_no = quoteNo;
quote.quote_date = quoteDate;
quote.documents = documents;
writeJsonFileAtomic(quoteMetaPath, validateSubmoduleMeta("quotes", quote, quoteMetaPath));

order.documents = replaceQuoteDocuments(arrayValue(order.documents), documents);
writeJsonFileAtomic(orderMetaPath, order);

const archiveMetaPath = path.join(resolvedOrderDir, "归档", "meta.json");
if (fs.existsSync(archiveMetaPath)) {
  const archive = readJsonObject(archiveMetaPath);
  archive.documents = replaceQuoteDocuments(arrayValue(archive.documents), documents);
  writeJsonFileAtomic(archiveMetaPath, validateSubmoduleMeta("archives", archive, archiveMetaPath));
}

console.log(args.noPdf ? `报价/${htmlName}` : `报价/${pdfName}`);

function renderHtml(): string {
  const rows = items
    .map((item, index) => {
      const row = objectValue(item);
      const product = productFromLine(row);
      const quantity = numberValue(row.quantity) ?? 0;
      const listPrice = numberValue(row.list_price) ?? product.listPrice ?? numberValue(row.unit_price) ?? 0;
      const discountPrice = numberValue(row.discount_price);
      const unitPrice = discountPrice ?? listPrice;
      const amount = numberValue(row.amount) ?? unitPrice * quantity;
      const notes = Array.isArray(row.notes) ? row.notes.join("；") : stringValue(row.notes);
      return `<tr>
        <td class="center">${index + 1}</td>
        <td>${escapeHtml(product.name)}</td>
        <td class="center">${escapeHtml(quantity)}</td>
        <td class="right">${money(listPrice)}</td>
        <td class="right">${discountPrice === null ? "-" : money(discountPrice)}</td>
        <td class="right">${money(amount)}</td>
        <td>${escapeHtml(notes)}</td>
      </tr>`;
    })
    .join("\n");
  const shippingNote = stringValue(totals.shipping_note);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(orderNo)} 报价单</title>
  <style>
    @page { size: A4; margin: 16mm; }
    :root { --ink:#1c2430; --muted:#66707b; --line:#d8dee8; --soft:#f7f3ec; --accent:#8d5415; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--ink); font-family: "Noto Sans CJK SC", "Source Han Sans SC", sans-serif; font-size: 12px; line-height: 1.55; }
    .header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; border-bottom: 2px solid var(--ink); padding-bottom: 14px; }
    .title { margin: 0; font-size: 28px; letter-spacing: 0.08em; }
    .subtitle { margin-top: 4px; color: var(--muted); }
    .meta { text-align: right; color: var(--muted); line-height: 1.7; }
    .section { margin-top: 18px; padding: 7px 10px; background: var(--soft); color: var(--accent); font-weight: 700; letter-spacing: 0.04em; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border: 1px solid var(--line); padding: 8px 9px; vertical-align: top; }
    th { background: #f5f7fa; text-align: left; font-weight: 700; }
    .label { width: 24mm; color: var(--muted); background: #fbfcfd; }
    .center { text-align: center; }
    .right { text-align: right; }
    .total-row td { font-weight: 700; }
    .note { margin-top: 14px; color: var(--muted); }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1 class="title">报价单</h1>
      <div class="subtitle">请核对商品、数量与金额</div>
    </div>
    <div class="meta">
      报价单号：${escapeHtml(quoteNo)}<br />
      订单号：${escapeHtml(orderNo)}<br />
      报价日期：${escapeHtml(quoteDate)}<br />
      币种：${escapeHtml(currency)}
    </div>
  </div>

  <div class="section">客户信息</div>
  <table>
    <tr><td class="label">客户名称</td><td>${escapeHtml(customer.name || "待确认")}</td><td class="label">收货国家</td><td>${escapeHtml(customer.country || "待确认")}</td></tr>
    <tr><td class="label">下单日期</td><td>${escapeHtml(dates.order_date || "待确认")}</td><td class="label">联系方式</td><td>${escapeHtml(customer.contact || "待确认")}</td></tr>
  </table>

  <div class="section">商品明细</div>
  <table>
    <thead>
      <tr>
        <th style="width:14mm;" class="center">序号</th>
        <th>商品名称</th>
        <th style="width:18mm;" class="center">数量</th>
        <th style="width:28mm;" class="right">单价</th>
        <th style="width:28mm;" class="right">折扣价</th>
        <th style="width:32mm;" class="right">金额</th>
        <th style="width:28mm;">备注</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
      <tr class="total-row"><td colspan="5" class="right">商品小计</td><td class="right">${money(numberValue(totals.items_subtotal) ?? 0)}</td><td></td></tr>
      <tr><td colspan="5" class="right">运费</td><td class="right">${money(numberValue(totals.shipping) ?? 0)}</td><td>${escapeHtml(shippingNote)}</td></tr>
      <tr class="total-row"><td colspan="5" class="right">客户应付总额</td><td class="right">${money(numberValue(totals.customer_payable) ?? 0)}</td><td></td></tr>
    </tbody>
  </table>

  <div class="note">说明：本报价以当前商品清单为准，付款与发货安排以后续确认为准。</div>
</body>
</html>
`;
}

function productFromLine(row: Record<string, unknown>): { name: string; listPrice: number | null } {
  const productId = row.product_id;
  const product = typeof productId === "string" || typeof productId === "number" ? findProductById(workspaceRoot, productId) : null;
  if (!product) {
    throw new Error(`Product not found for product_id=${String(productId)}. Quote items must reference 产品管理 metadata by product_id.`);
  }
  const pricing = objectValue(product.meta.pricing);
  const markets = objectValue(pricing.markets);
  const cn = objectValue(markets.CN);
  return {
    name: stringValue(product.meta.name) || `货号 ${String(productId)}`,
    listPrice: numberValue(cn.list_price),
  };
}

function renderPdf(inputHtmlPath: string, outputPdfPath: string): void {
  const chrome = findChrome();
  if (!chrome) throw new Error("Chrome/Chromium not found; rerun with --no-pdf or install google-chrome/chromium.");
  const result = spawnSync(
    chrome,
    ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-pdf-header-footer", `--print-to-pdf=${outputPdfPath}`, pathToFileURL(inputHtmlPath).href],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").replaceAll(inputHtmlPath, "<input.html>").replaceAll(outputPdfPath, "<output.pdf>");
    throw new Error(`PDF render failed with status ${result.status}${details ? `\n${details}` : ""}`);
  }
}

function findChrome(): string | null {
  for (const command of ["google-chrome", "chromium", "chromium-browser"]) {
    const result = spawnSync("which", [command], { encoding: "utf-8" });
    if (result.status === 0) return result.stdout.trim();
  }
  return null;
}

function readQuoteMeta(filePath: string): JsonObject {
  return validateSubmoduleMeta("quotes", readJsonObject(filePath), filePath);
}

function readJsonObject(filePath: string): JsonObject {
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  if (!isJsonObject(data)) throw new Error(`${filePath}: expected JSON object`);
  return data;
}

function replaceQuoteDocuments(documents: unknown[], quoteDocuments: DocumentRef[]): DocumentRef[] {
  return [
    ...documents.filter((document) => {
      const item = objectValue(document);
      return item.kind !== "quote";
    }).map((document) => objectValue(document) as DocumentRef),
    ...quoteDocuments,
  ];
}

function parseArgs(argv: string[]): { orderDir: string; date?: string; noPdf: boolean } {
  const result = { orderDir: "", date: undefined as string | undefined, noPdf: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--date") result.date = argv[++index];
    else if (arg === "--no-pdf") result.noPdf = true;
    else if (!result.orderDir) result.orderDir = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function money(value: number): string {
  return `${currency} ${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]!);
}

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "客户";
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
