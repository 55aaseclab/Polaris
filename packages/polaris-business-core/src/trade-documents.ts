import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PACKAGE_ROOT } from "./repo.js";
import { isJsonObject, type JsonObject } from "./json.js";
import { renderHtmlToPdf } from "./pdf.js";
import { defaultSubmoduleMeta, orderDirPath, readAndValidateOrderMeta, readSubmoduleMeta, writeSubmoduleMeta, type OrderMeta } from "./operations.js";
import { findProductById, type ProductSummary } from "./products.js";

export type TradeDocumentKind = "quotes" | "invoices";

const SELLER = Object.freeze({
  companyNameCn: "深圳简小弈科技有限公司",
  companyNameEn: "SHENZHEN JIANXIAOYI TECHNOLOGY CO., LTD.",
  email: "contact@jianxiaoyitech.com",
  headerAddress: "ROOM 2F134, 2/F, WENZHENGXIN BUILDING, BUILDING 3, AREA 30, NO. 2 KEFA ROAD, KEJIYUAN COMMUNITY, YUEHAI SUBDISTRICT, NANSHAN DISTRICT, SHENZHEN, CHINA",
  swift: "ICBKCNBJSZN",
  bankName: "INDUSTRIAL AND COMMERCIAL BANK OF CHINA SHENZHEN BRANCH",
  bankAddress: "1255 HAIDE 3RD ROAD, NANSHAN DISTRICT, SHENZHEN, CHINA 518052",
  beneficiary: "SHENZHEN JIANXIAOYI TECHNOLOGY CO., LTD.",
  beneficiaryAddress: "ROOM 2F134, 2/F, WENZHENGXIN BUILDING, BUILDING 3, AREA 30, NO. 2 KEFA ROAD, KEJIYUAN COMMUNITY, YUEHAI SUBDISTRICT, NANSHAN DISTRICT, SHENZHEN, CHINA",
  accountNo: "4000119009100075388",
});

const TEMPLATE_FILES: Record<TradeDocumentKind, string> = {
  quotes: path.join(PACKAGE_ROOT, "assets", "proforma-invoice-template.html"),
  invoices: path.join(PACKAGE_ROOT, "assets", "commercial-invoice-template.html"),
};

const DOCUMENT_FONT_PATH = path.join(PACKAGE_ROOT, "assets", "fonts", "NotoSansCJKsc-Regular.otf");

type TradeDocumentItem = {
  line_no: number;
  product_id: string | number | null;
  description: string | null;
  package_description: string | null;
  size: string | null;
  quantity_ctns: number | null;
  weight_kgs: number | null;
  unit_price_usd_per_kg: number | null;
  amount_usd: number | null;
  notes: string[];
};

type TradeDocumentRecord = JsonObject & {
  order_no: string;
  documents?: unknown[];
  items?: unknown[];
  totals?: unknown;
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function amountWords(amount: number | null): string {
  if (amount === null) return "";
  const ones = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"];
  const tens = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"];
  function spell(value: number): string {
    if (value < 20) return ones[value];
    if (value < 100) return `${tens[Math.floor(value / 10)]}${value % 10 ? ` ${ones[value % 10]}` : ""}`;
    if (value < 1000) return `${ones[Math.floor(value / 100)]} HUNDRED${value % 100 ? ` AND ${spell(value % 100)}` : ""}`;
    if (value < 1_000_000) return `${spell(Math.floor(value / 1000))} THOUSAND${value % 1000 ? ` ${spell(value % 1000)}` : ""}`;
    return `${spell(Math.floor(value / 1_000_000))} MILLION${value % 1_000_000 ? ` ${spell(value % 1_000_000)}` : ""}`;
  }
  return `${spell(Math.round(amount))} ONLY`;
}

function unitPriceHeader(currency: string): string {
  const normalized = text(currency).toUpperCase() || "USD";
  return `UNIT PRICE (${normalized}/ITEM)`;
}

function totalWordsLabel(currency: string): string {
  const normalized = text(currency).toUpperCase() || "USD";
  return `TOTAL ${normalized}`;
}

function orderMoney(value: unknown): number | null {
  return numberValue(value);
}

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "document";
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]!);
}

function templatePath(kind: TradeDocumentKind): string {
  return TEMPLATE_FILES[kind];
}

function documentFontFaceCss(): string {
  const fontUrl = pathToFileURL(DOCUMENT_FONT_PATH).href;
  return `@font-face {
    font-family: "WanghaiDocSans";
    src: url("${fontUrl}") format("opentype");
    font-weight: 400;
    font-style: normal;
  }`;
}

function orderCustomerText(order: JsonObject, record: TradeDocumentRecord): string {
  const manual = text(record.customer_text);
  if (manual) return manual;
  const customer = asObject(order.customer);
  return [customer.name, customer.country, customer.contact_name, customer.contact_email].map(text).filter(Boolean).join(", ");
}

function shippingLabel(order: OrderMeta, record: TradeDocumentRecord): string {
  return "FREIGHT";
}

function packagingLabel(packaging: "normal" | "gift"): { zh: string; en: string } {
  return packaging === "gift"
    ? { zh: "精包装", en: "Gift Packaging" }
    : { zh: "普通包装", en: "Standard Packaging" };
}

function defaultDescription(product: ProductSummary | null, packaging: "normal" | "gift"): string {
  if (!product) return "";
  const meta = product.meta as Record<string, any>;
  const nameCn = text(meta.name);
  const nameEn = text(meta.name_en);
  const labels = packagingLabel(packaging);
  const left = nameCn ? `${nameCn}${labels.zh}` : "";
  const right = nameEn ? `${nameEn} ${labels.en}` : "";
  if (left && right) return `${left} / ${right}`;
  return left || right || product.sku;
}

function meaningfulSize(value: unknown): string {
  const current = text(value);
  if (!current) return "";
  return /^0(?:\.0+)?\*0(?:\.0+)?\*0(?:\.0+)?$/u.test(current) ? "" : current;
}

function pickWeight(currentValue: unknown, derivedValue: number | null): number | null {
  const current = numberValue(currentValue);
  if (current === null) return derivedValue;
  if (current === 0) return derivedValue;
  return current;
}

function orderPackagingKey(order: OrderMeta): "normal" | "gift" {
  return order.packaging === "gift" ? "gift" : "normal";
}

function productPackaging(product: ProductSummary | null, packaging: "normal" | "gift"): Record<string, any> {
  if (!product) return {};
  const meta = asObject(product.meta);
  const packagingRoot = asObject(meta.packaging);
  return asObject(packagingRoot[packaging]);
}

function formatSize(value: unknown): string {
  const dimensions = asObject(value);
  const length = numberValue(dimensions.length);
  const width = numberValue(dimensions.width);
  const height = numberValue(dimensions.height);
  const parts = [length, width, height];
  if (parts.every((part) => part === null)) return "";
  return parts.map((part) => (part === null ? "" : String(part))).join("*");
}

function productUnitWeight(product: ProductSummary | null, packaging: "normal" | "gift"): number | null {
  return numberValue(productPackaging(product, packaging).weight_with_packaging_kg);
}

function marketPriceForCurrency(product: ProductSummary | null, currency: string): number | null {
  if (!product) return null;
  const pricing = asObject(asObject(product.meta).pricing);
  const markets = asObject(pricing.markets);
  const normalizedCurrency = text(currency).toUpperCase();
  for (const market of Object.values(markets)) {
    const entry = asObject(market);
    if (text(entry.currency).toUpperCase() === normalizedCurrency) {
      return numberValue(entry.list_price ?? entry.promo_price ?? entry.floor_price);
    }
  }
  const defaultMarket = text(pricing.default_market);
  if (!defaultMarket) return null;
  const fallback = asObject(markets[defaultMarket]);
  return numberValue(fallback.list_price ?? fallback.promo_price ?? fallback.floor_price);
}

function alignItems(workspaceRoot: string, order: OrderMeta, existingItems: unknown, fallbackItems: unknown): TradeDocumentItem[] {
  const currentItems = Array.isArray(existingItems) && existingItems.length > 0
    ? existingItems
    : Array.isArray(fallbackItems)
      ? fallbackItems
      : [];
  const currentByProductId = new Map<string, Record<string, any>>();
  currentItems.forEach((item) => {
    if (item && typeof item === "object" && "product_id" in item) {
      const id = text((item as Record<string, any>).product_id);
      if (id) currentByProductId.set(id, item as Record<string, any>);
    }
  });
  const lines = Array.isArray(order.lines) ? order.lines : [];
  const packaging = orderPackagingKey(order);
  const pricingCurrency = text(order.currency) || "USD";
  return lines.map((line, index) => {
    const productId = typeof line === "string" || typeof line === "number"
      ? line
      : line && typeof line === "object" && "product_id" in (line as Record<string, any>)
        ? ((line as Record<string, any>).product_id as string | number | null)
        : null;
    const quantity = typeof line === "object" && line !== null && "quantity" in (line as Record<string, any>)
      ? numberValue((line as Record<string, any>).quantity) ?? 1
      : 1;
    const current = currentByProductId.get(text(productId)) ?? {};
    const product = productId === null || productId === undefined ? null : findProductById(workspaceRoot, productId);
    const unitWeight = productUnitWeight(product, packaging);
    const derivedWeight = unitWeight === null ? null : Number((unitWeight * quantity).toFixed(3));
    const derivedPrice = marketPriceForCurrency(product, pricingCurrency);
    const derivedSize = formatSize(productPackaging(product, packaging).dimensions_mm);
    const derivedAmount = derivedPrice === null ? null : Number((derivedPrice * quantity).toFixed(2));
    return {
      line_no: index + 1,
      product_id: productId,
      description: defaultDescription(product, packaging) || text(current.description),
      package_description: text(current.package_description),
      size: meaningfulSize(current.size) || derivedSize,
      quantity_ctns: numberValue(current.quantity_ctns ?? current.quantity) ?? quantity,
      weight_kgs: pickWeight(current.weight_kgs, derivedWeight),
      unit_price_usd_per_kg: derivedPrice ?? numberValue(current.unit_price_usd_per_kg ?? current.discount_price ?? current.unit_price),
      amount_usd: derivedAmount ?? numberValue(current.amount_usd ?? current.amount),
      notes: Array.isArray(current.notes) ? current.notes.map((note) => String(note)) : [],
    };
  });
}

function computeItemAmount(item: TradeDocumentItem): number | null {
  if (item.amount_usd !== null) return item.amount_usd;
  if (item.weight_kgs === null || item.unit_price_usd_per_kg === null) return null;
  return Number((item.weight_kgs * item.unit_price_usd_per_kg).toFixed(2));
}

function summarize(items: TradeDocumentItem[]) {
  const quantity = items.reduce<number | null>((sum, item) => item.quantity_ctns === null ? sum : (sum ?? 0) + item.quantity_ctns, null);
  const weight = items.reduce<number | null>((sum, item) => item.weight_kgs === null ? sum : (sum ?? 0) + item.weight_kgs, null);
  const amount = items.reduce<number | null>((sum, item) => {
    const current = computeItemAmount(item);
    return current === null ? sum : (sum ?? 0) + current;
  }, null);
  return {
    quantity_ctns: quantity === null ? "" : String(Number(quantity.toFixed(2))),
    weight_kgs: weight === null ? "" : String(Number(weight.toFixed(2))),
    amount_usd: amount === null ? "" : String(Number(amount.toFixed(2))),
    amount_words: amountWords(amount),
  };
}

function itemRowsHtml(kind: TradeDocumentKind, items: TradeDocumentItem[]): string {
  if (items.length === 0) {
    return `${Array.from({ length: 1 }, () => `
    <tr class="blank-item-row">
      <td class="center"></td><td></td><td></td><td></td><td></td><td></td><td></td>
    </tr>`).join("\n")}`;
  }
  return items.map((item) => `
    <tr class="item-row">
      <td class="center">${item.line_no}</td>
      <td>${escapeHtml([item.description, item.package_description].filter(Boolean).join(" "))}</td>
      <td class="center">${escapeHtml(item.size)}</td>
      <td class="center">${item.quantity_ctns ?? ""}</td>
      <td class="center">${item.weight_kgs ?? ""}</td>
      <td class="center">${item.unit_price_usd_per_kg ?? ""}</td>
      <td class="center">${computeItemAmount(item) ?? ""}</td>
    </tr>`).join("\n");
}

function shippingRowHtml(shippingAmount: number | null, label: string): string {
  return `
    <tr>
      <td></td>
      <td></td>
      <td class="right label">${escapeHtml(label)}</td>
      <td class="center"></td>
      <td class="center"></td>
      <td></td>
      <td class="center">${shippingAmount === null ? "" : String(Number(shippingAmount.toFixed(2)))}</td>
    </tr>`;
}

function summaryRowsHtml(
  quantity: string,
  weight: string,
  subtotalAmount: number | null,
  shippingAmount: number | null,
  totalAmount: number | null,
  shippingLabelText: string,
): string {
  const subtotal = subtotalAmount ?? 0;
  const shipping = shippingAmount ?? 0;
  const total = totalAmount ?? subtotalAmount;
  const discount = total === null ? null : Number((subtotal + shipping - total).toFixed(2));
  const rows = [
    `
    <tr>
      <td></td>
      <td></td>
      <td class="right label">SUBTOTAL:</td>
      <td class="center">${quantity}</td>
      <td class="center">${weight}</td>
      <td></td>
      <td class="center">${subtotalAmount === null ? "" : String(Number(subtotalAmount.toFixed(2)))}</td>
    </tr>`,
  ];
  if (discount !== null && discount > 0) {
    rows.push(`
    <tr>
      <td></td>
      <td></td>
      <td class="right label">LESS: DISCOUNT</td>
      <td></td>
      <td></td>
      <td></td>
      <td class="center">-${String(Number(discount.toFixed(2)))}</td>
    </tr>`);
  }
  rows.push(shippingRowHtml(shippingAmount, shippingLabelText));
  rows.push(`
    <tr>
      <td></td>
      <td></td>
      <td class="right label">TOTAL:</td>
      <td class="center">${quantity}</td>
      <td class="center">${weight}</td>
      <td></td>
      <td class="center">${totalAmount === null ? "" : String(Number(totalAmount.toFixed(2)))}</td>
    </tr>`);
  return rows.join("\n");
}

function shippingNoteRowHtml(shippingAmount: number | null): string {
  if (shippingAmount !== 0) return "";
  return `<tr class="note-row"><td colspan="7">FREIGHT CHARGES ARE FOR SELLER'S ACCOUNT</td></tr>`;
}

function replacements(workspaceRoot: string, kind: TradeDocumentKind, order: OrderMeta, record: TradeDocumentRecord, fallbackItems: unknown): Record<string, string> {
  const items = alignItems(workspaceRoot, order, record.items, fallbackItems);
  const summary = summarize(items);
  const orderTotals = asObject(order.totals);
  const shippingAmount = orderMoney(orderTotals.shipping);
  const payableAmount = orderMoney(orderTotals.customer_payable);
  const totalAmount = payableAmount ?? numberValue(summary.amount_usd);
  const ports = asObject(record.ports);
  const tradeTerm = asObject(record.trade_term);
  const docNo = kind === "quotes" ? text(record.quote_no) || `PI-${text(order.order_no)}` : text(record.invoice_no) || `CI-${text(order.order_no)}`;
  const docDate = kind === "quotes" ? text(record.quote_date) || today() : text(record.issue_date) || today();
  return {
    "{{DOC_FONT_FACE}}": documentFontFaceCss(),
    "{{SELLER_HEADER}}": `${SELLER.companyNameCn}\n${SELLER.companyNameEn}\n${SELLER.headerAddress}\nEMAIL: ${SELLER.email}`,
    "{{CUSTOMER}}": orderCustomerText(order, record),
    "{{DOC_NO}}": docNo,
    "{{DOC_DATE}}": docDate,
    "{{PORT_LOADING}}": text(ports.loading) || "SHENZHEN, CHINA",
    "{{PORT_DISCHARGE}}": text(ports.discharge),
    "{{TRADE_TERM_LABEL}}": text(tradeTerm.label),
    "{{TRADE_TERM_PLACE}}": text(tradeTerm.place),
    "{{UNIT_PRICE_HEADER}}": unitPriceHeader(text(record.currency) || text(order.currency) || "USD"),
    "{{TOTAL_WORDS_LABEL}}": totalWordsLabel(text(record.currency) || text(order.currency) || "USD"),
    "{{ITEM_ROWS}}": itemRowsHtml(kind, items),
    "{{SUMMARY_ROWS}}": summaryRowsHtml(
      summary.quantity_ctns,
      summary.weight_kgs,
      numberValue(summary.amount_usd),
      shippingAmount,
      totalAmount,
      shippingLabel(order, record),
    ),
    "{{SHIPPING_NOTE_ROW}}": shippingNoteRowHtml(shippingAmount),
    "{{TOTAL_QUANTITY}}": summary.quantity_ctns,
    "{{TOTAL_WEIGHT}}": summary.weight_kgs,
    "{{TOTAL_AMOUNT}}": totalAmount === null ? "" : String(Number(totalAmount.toFixed(2))),
    "{{TOTAL_WORDS}}": amountWords(totalAmount),
    "{{QUANTITY_TOLERANCE}}": text(record.quantity_tolerance) || "5% MORE OR LESS ALLOWED",
    "{{PAYMENT_TERMS}}": kind === "quotes" ? "ONE-TIME PAYMENT" : text(record.payment_terms) || "ONE-TIME PAYMENT",
    "{{DELIVERY_TIME}}": text(record.delivery_time) || "AFTER DEPOSIT 14 DAYS",
    "{{PARTIAL_SHIPMENT}}": text(record.partial_shipment) || "NO ALLOWED",
    "{{BENEFICIARY}}": SELLER.beneficiary,
    "{{BENEFICIARY_ADDRESS}}": SELLER.beneficiaryAddress,
    "{{ACCOUNT_NO}}": SELLER.accountNo,
    "{{BANK_NAME}}": SELLER.bankName,
    "{{BANK_ADDRESS}}": SELLER.bankAddress,
    "{{SWIFT_CODE}}": SELLER.swift,
  };
}

function replaceTokens(template: string, values: Record<string, string>): string {
  let html = template;
  for (const [token, value] of Object.entries(values)) {
    html = html.replaceAll(token, value);
  }
  return html;
}

function updateDocuments(record: TradeDocumentRecord, relativePath: string, label: string) {
  const documents = Array.isArray(record.documents) ? [...record.documents] : [];
  return [
    ...documents.filter((document) => {
      const item = asObject(document);
      return item.kind !== label;
    }),
    { label: path.basename(relativePath), path: relativePath, kind: label },
  ];
}

export async function generateTradeDocument(
  workspaceRoot: string,
  orderNo: string,
  kind: TradeDocumentKind,
  draftRecord?: JsonObject,
): Promise<{ record: JsonObject; relativePath: string }> {
  const generatedAt = today();
  const orderPath = path.join(orderDirPath(workspaceRoot, orderNo), "meta.json");
  const order = readAndValidateOrderMeta(orderPath);
  const record = {
    ...(readSubmoduleMeta(workspaceRoot, orderNo, kind) ?? defaultSubmoduleMeta(kind, orderNo)),
    ...(draftRecord ?? {}),
    order_no: orderNo,
  } as TradeDocumentRecord;
  if (kind === "invoices") {
    record.issue_date = generatedAt;
  }
  const fallbackItems = kind === "invoices"
    ? (readSubmoduleMeta(workspaceRoot, orderNo, "quotes") as Record<string, any> | null)?.items
    : undefined;
  const items = alignItems(workspaceRoot, order, record.items, fallbackItems);
  const totals = summarize(items);
  record.items = items;
  record.totals = totals;
  if (kind === "invoices") {
    record.amount = numberValue(totals.amount_usd);
  }
  const template = fs.readFileSync(templatePath(kind), "utf-8");
  const html = replaceTokens(template, replacements(workspaceRoot, kind, order, record, fallbackItems));
  const customerName = safeFilename(text(asObject(order.customer).name) || "customer");
  const date = safeFilename(kind === "quotes" ? text(record.quote_date) || generatedAt : generatedAt);
  const pdfName = `${orderNo}-${customerName}-${kind === "quotes" ? "PI" : "CI"}-${date}.pdf`;
  const htmlName = `${orderNo}-${customerName}-${kind === "quotes" ? "PI" : "CI"}-${date}.html`;
  const relativeDir = kind === "quotes" ? "报价" : "开票";
  const relativePdfPath = path.posix.join(relativeDir, pdfName);
  const absoluteDir = path.join(orderDirPath(workspaceRoot, orderNo), relativeDir);
  const absoluteHtmlPath = path.join(absoluteDir, htmlName);
  const absolutePdfPath = path.join(absoluteDir, pdfName);
  fs.mkdirSync(absoluteDir, { recursive: true });
  fs.writeFileSync(absoluteHtmlPath, html, "utf-8");
  renderHtmlToPdf(absoluteHtmlPath, absolutePdfPath);

  record.documents = updateDocuments(record, relativePdfPath, kind === "quotes" ? "pi" : "ci");
  const normalized = writeSubmoduleMeta(workspaceRoot, orderNo, kind, record);
  return { record: normalized, relativePath: relativePdfPath };
}
