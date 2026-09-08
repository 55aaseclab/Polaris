import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic, type JsonObject, type JsonValue, isJsonObject } from "./json.js";
import { SCHEMAS_DIR } from "./repo.js";
import { type Schema } from "./schema-validation.js";
import { validateJsonObject, SchemaValidationError } from "./schema-validation.js";
import { WorkspacePaths, safeWorkspacePath } from "./workspaces.js";

export type OrderModuleKind = "orders" | "quotes" | "inspections" | "payments" | "shipments" | "invoices" | "reconciliations" | "archives" | "attachments";

export type OrderMeta = JsonObject;
export type OrderSubmoduleMeta = JsonObject;
export type OrderLineItem = {
  product_id: string | number;
  quantity: number;
};

export type OrderListItem = {
  order_no: string;
  customer: string | null;
  status: string;
  process_status: string;
  order_date: string | null;
  amount: number | null;
  currency: string;
  validation_error: string | null;
};

export type CustomerListItem = {
  name: string;
  country: string | null;
  contact_name: string | null;
  contact_email: string | null;
  order_count: number;
  total_amount: number | null;
  currency: string | null;
  latest_order_date: string | null;
};

type FileConfig = {
  schema: string;
  filename: string;
  dirName: string;
};

const CONFIG: Record<OrderModuleKind, FileConfig> = {
  orders: { schema: "wanghai.operations.order", filename: "meta.json", dirName: "" },
  quotes: { schema: "wanghai.operations.quote", filename: "meta.json", dirName: "报价" },
  inspections: { schema: "wanghai.operations.inspection", filename: "meta.json", dirName: "报检" },
  payments: { schema: "wanghai.operations.payment", filename: "meta.json", dirName: "收款" },
  shipments: { schema: "wanghai.operations.shipment", filename: "meta.json", dirName: "发货" },
  invoices: { schema: "wanghai.operations.invoice", filename: "meta.json", dirName: "开票" },
  reconciliations: { schema: "wanghai.operations.reconciliation", filename: "meta.json", dirName: "对账" },
  archives: { schema: "wanghai.operations.archive", filename: "meta.json", dirName: "归档" },
  attachments: { schema: "wanghai.operations.attachments", filename: "meta.json", dirName: "附件" },
};

const SCHEMA_FILES: Record<OrderModuleKind, string> = {
  orders: "wanghai.operations.order.v2.schema.json",
  quotes: "wanghai.operations.quote.v2.schema.json",
  inspections: "wanghai.operations.inspection.v1.schema.json",
  payments: "wanghai.operations.payment.v1.schema.json",
  shipments: "wanghai.operations.shipment.v1.schema.json",
  invoices: "wanghai.operations.invoice.v2.schema.json",
  reconciliations: "wanghai.operations.reconciliation.v1.schema.json",
  archives: "wanghai.operations.archive.v1.schema.json",
  attachments: "wanghai.operations.attachments.v1.schema.json",
};

const schemaCache = new Map<OrderModuleKind, Schema>();
let customerSchemaCache: Schema | null = null;
const ORDER_SUBMODULE_KINDS = ["quotes", "inspections", "payments", "shipments", "invoices", "reconciliations", "archives", "attachments"] as const;
const MAX_ORDER_IDENTIFIER_LENGTH = 128;

function loadSchema(kind: OrderModuleKind): Schema {
  const cached = schemaCache.get(kind);
  if (cached) return cached;
  const filePath = path.join(SCHEMAS_DIR, SCHEMA_FILES[kind]);
  const schema = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Schema;
  schemaCache.set(kind, schema);
  return schema;
}

function loadCustomerSchema(): Schema {
  if (customerSchemaCache) return customerSchemaCache;
  const filePath = path.join(SCHEMAS_DIR, "wanghai.crm.customer.v1.schema.json");
  customerSchemaCache = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Schema;
  return customerSchemaCache;
}

export function orderManagementDir(workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot);
  const candidate = new WorkspacePaths(root).orderManagementDir;
  return safeWorkspacePath(root, path.relative(root, candidate));
}

export function orderDirPath(workspaceRoot: string, orderNo: string): string {
  const identifier = validateOrderIdentifier(orderNo);
  return workspaceDescendantPath(workspaceRoot, path.join(orderManagementDir(workspaceRoot), identifier));
}

export function validateOrderIdentifier(orderNo: string): string {
  const value = String(orderNo ?? "").trim();
  if (
    !value
    || value.length > MAX_ORDER_IDENTIFIER_LENGTH
    || value === "."
    || value === ".."
    || value.includes("\0")
    || value.includes("/")
    || value.includes("\\")
    || /%[0-9a-f]{2}/iu.test(value)
  ) {
    throw new Error("Order identifier must be one opaque path segment");
  }
  return value;
}

export function orderMetaPath(workspaceRoot: string, orderNo: string): string {
  return orderDescendantPath(workspaceRoot, orderNo, "meta.json");
}

export function submoduleDirPath(workspaceRoot: string, orderNo: string, kind: Exclude<OrderModuleKind, "orders">): string {
  return orderDescendantPath(workspaceRoot, orderNo, CONFIG[kind].dirName);
}

export function submoduleMetaPath(workspaceRoot: string, orderNo: string, kind: Exclude<OrderModuleKind, "orders">): string {
  return orderDescendantPath(workspaceRoot, orderNo, CONFIG[kind].dirName, CONFIG[kind].filename);
}

function orderDescendantPath(workspaceRoot: string, orderNo: string, ...segments: string[]): string {
  const relativePath = segments.map(validateOrderRelativePath);
  return workspaceDescendantPath(workspaceRoot, path.join(orderDirPath(workspaceRoot, orderNo), ...relativePath));
}

function workspaceDescendantPath(workspaceRoot: string, targetPath: string): string {
  const root = path.resolve(workspaceRoot);
  return safeWorkspacePath(root, path.relative(root, targetPath));
}

function validateOrderRelativePath(value: string): string {
  const relativePath = String(value ?? "");
  if (
    !relativePath
    || relativePath.includes("\0")
    || path.isAbsolute(relativePath)
    || relativePath.includes("\\")
    || /%[0-9a-f]{2}/iu.test(relativePath)
    || relativePath.split("/").some((segment) => segment === "..")
  ) {
    throw new Error("Order path must remain within its order directory");
  }
  return relativePath;
}

export function listOrderDirectories(workspaceRoot: string): string[] {
  const root = orderManagementDir(workspaceRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isDirectory()) return false;
      try {
        validateOrderIdentifier(entry.name);
        return fs.existsSync(path.join(root, entry.name, "meta.json"));
      } catch {
        return false;
      }
    })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export function readOrderMeta(workspaceRoot: string, orderNo: string): OrderMeta | null {
  const data = readJsonFile<OrderMeta>(orderMetaPath(workspaceRoot, orderNo));
  if (!data || !isJsonObject(data)) return null;
  return data;
}

export function validateOrderMeta(data: JsonObject, metaPath?: string): JsonObject {
  try {
    return validateJsonObject(normalizeOrderMeta(data), loadSchema("orders"), "order meta.json");
  } catch (error) {
    if (error instanceof SchemaValidationError && metaPath) throw new SchemaValidationError(`${metaPath}: ${error.message}`);
    throw error;
  }
}

export function readAndValidateOrderMeta(metaPath: string): JsonObject {
  const data = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as JsonValue;
  if (!isJsonObject(data)) throw new SchemaValidationError(`${metaPath}: meta.json root must be an object`);
  return validateOrderMeta(data, metaPath);
}

export function writeOrderMeta(workspaceRoot: string, orderNo: string, data: JsonObject): JsonObject {
  const identifier = validateOrderIdentifier(orderNo);
  const normalized = validateOrderMeta(
    { ...data, order_no: identifier },
    orderMetaPath(workspaceRoot, identifier),
  );
  writeJsonFileAtomic(orderMetaPath(workspaceRoot, identifier), normalized);
  return normalized;
}

function normalizeOrderMeta(data: JsonObject): JsonObject {
  return {
    ...data,
    schema_version: 2,
    dates: isJsonObject(data.dates) ? data.dates : { created_at: today(), order_date: null },
    customer: normalizeOrderCustomer(data.customer),
    packaging: normalizeOrderPackaging(data.packaging),
    lines: normalizeOrderLines(data.lines),
    totals: isJsonObject(data.totals) ? data.totals : { items_subtotal: null, shipping: null, customer_payable: null },
    source: isJsonObject(data.source) ? data.source : { channel: null, reference: null },
    payment: isJsonObject(data.payment) ? { ...defaultPayment(), ...data.payment } : defaultPayment(),
    fulfillment: isJsonObject(data.fulfillment) ? { ...defaultFulfillment(), ...data.fulfillment } : defaultFulfillment(),
    reconciliation: isJsonObject(data.reconciliation) ? { ...defaultReconciliation(), ...data.reconciliation } : defaultReconciliation(),
    archive: isJsonObject(data.archive) ? { ...defaultArchive(), ...data.archive } : defaultArchive(),
    documents: Array.isArray(data.documents) ? data.documents : [],
    timeline: Array.isArray(data.timeline) ? data.timeline : [],
    notes: Array.isArray(data.notes) ? data.notes : [],
  };
}

export function readSubmoduleMeta(workspaceRoot: string, orderNo: string, kind: Exclude<OrderModuleKind, "orders">): JsonObject | null {
  const data = readJsonFile<JsonObject>(submoduleMetaPath(workspaceRoot, orderNo, kind));
  if (!data || !isJsonObject(data)) return null;
  return validateSubmoduleMeta(kind, data, submoduleMetaPath(workspaceRoot, orderNo, kind));
}

export function validateSubmoduleMeta(kind: Exclude<OrderModuleKind, "orders">, data: JsonObject, metaPath?: string): JsonObject {
  try {
    return validateJsonObject(normalizeSubmoduleMeta(kind, data), loadSchema(kind), `${kind} meta.json`);
  } catch (error) {
    if (error instanceof SchemaValidationError && metaPath) throw new SchemaValidationError(`${metaPath}: ${error.message}`);
    throw error;
  }
}

export function writeSubmoduleMeta(workspaceRoot: string, orderNo: string, kind: Exclude<OrderModuleKind, "orders">, data: JsonObject): JsonObject {
  const normalized = validateSubmoduleMeta(kind, data, submoduleMetaPath(workspaceRoot, orderNo, kind));
  writeJsonFileAtomic(submoduleMetaPath(workspaceRoot, orderNo, kind), normalized);
  return normalized;
}

export function ensureOrderDirs(workspaceRoot: string, orderNo: string): string {
  const identifier = validateOrderIdentifier(orderNo);
  const root = orderManagementDir(workspaceRoot);
  fs.mkdirSync(root, { recursive: true });
  const orderDir = orderDirPath(workspaceRoot, identifier);
  fs.mkdirSync(orderDir, { recursive: true });
  for (const kind of ORDER_SUBMODULE_KINDS) {
    fs.mkdirSync(submoduleDirPath(workspaceRoot, identifier, kind), { recursive: true });
  }
  return orderDir;
}

export function defaultOrderMeta(orderNo: string): JsonObject {
  const identifier = validateOrderIdentifier(orderNo);
  return {
    schema: "wanghai.operations.order",
    schema_version: 2,
    order_no: identifier,
    status: "draft",
    dates: { created_at: today(), order_date: null },
    customer: { name: null, country: null, contact_name: null, contact_email: null },
    currency: "CNY",
    packaging: "normal",
    lines: [],
    totals: { items_subtotal: null, shipping: null, customer_payable: null },
    source: { channel: null, reference: null },
    payment: defaultPayment(),
    fulfillment: defaultFulfillment(),
    reconciliation: defaultReconciliation(),
    archive: defaultArchive(),
    documents: [],
    timeline: [],
    notes: [],
  };
}

export function defaultSubmoduleMeta(kind: Exclude<OrderModuleKind, "orders">, orderNo: string): JsonObject {
  const identifier = validateOrderIdentifier(orderNo);
  if (kind === "quotes") {
    return {
      schema: "wanghai.operations.quote",
      schema_version: 2,
      order_no: identifier,
      status: "draft",
      quote_no: null,
      quote_date: null,
      valid_until: null,
      currency: "USD",
      customer_text: null,
      ports: { loading: null, discharge: null },
      trade_term: { label: null, place: null },
      container: null,
      payment_terms: "ONE-TIME PAYMENT",
      delivery_time: "AFTER DEPOSIT 14 DAYS",
      partial_shipment: "NO ALLOWED",
      quantity_tolerance: "5% MORE OR LESS ALLOWED",
      items: [],
      totals: { quantity_ctns: null, weight_kgs: null, amount_usd: null, amount_words: null },
      documents: [],
      notes: [],
    };
  }
  if (kind === "inspections") {
    return {
      schema: "wanghai.operations.inspection",
      schema_version: 1,
      order_no: identifier,
      status: "pending",
      inspection_no: null,
      inspection_date: null,
      items: [],
      checks: {},
      documents: [],
      notes: [],
    };
  }
  if (kind === "shipments") {
    return {
      schema: "wanghai.operations.shipment",
      schema_version: 1,
      order_no: identifier,
      status: "pending",
      carrier: null,
      channel: null,
      tracking_no: null,
      ship_date: null,
      destination_country: null,
      packages: [],
      costs: {},
      documents: [],
      notes: [],
    };
  }
  if (kind === "invoices") {
    return {
      schema: "wanghai.operations.invoice",
      schema_version: 2,
      order_no: identifier,
      status: "not_requested",
      invoice_type: null,
      invoice_no: null,
      issue_date: null,
      buyer: {},
      currency: "USD",
      customer_text: null,
      ports: { loading: null, discharge: null },
      trade_term: { label: null, place: null },
      container: null,
      items: [],
      totals: { quantity_ctns: null, weight_kgs: null, amount_usd: null, amount_words: null },
      amount: null,
      documents: [],
      notes: [],
    };
  }
  if (kind === "payments") {
    return {
      schema: "wanghai.operations.payment",
      schema_version: 1,
      order_no: identifier,
      status: "pending",
      receivable_amount: null,
      received_amount: null,
      method: null,
      received_at: null,
      exchange_rate: null,
      proof_documents: [],
      documents: [],
      notes: [],
    };
  }
  if (kind === "reconciliations") {
    return {
      schema: "wanghai.operations.reconciliation",
      schema_version: 1,
      order_no: identifier,
      status: "pending",
      checked_at: null,
      sales_amount: null,
      received_amount: null,
      invoice_amount: null,
      logistics_cost: null,
      supplier_payable: null,
      difference: null,
      documents: [],
      notes: [],
    };
  }
  if (kind === "archives") {
    return {
      schema: "wanghai.operations.archive",
      schema_version: 1,
      order_no: identifier,
      status: "pending",
      archived_at: null,
      location: null,
      documents: [],
      notes: [],
    };
  }
  return {
    schema: "wanghai.operations.attachments",
    schema_version: 1,
    order_no: identifier,
    documents: [],
    notes: [],
  };
}

export function readOrderBundle(workspaceRoot: string, orderNo: string): { order: JsonObject; process_status: string; submodules: Record<Exclude<OrderModuleKind, "orders">, JsonObject | null>; files: string[] } {
  const identifier = validateOrderIdentifier(orderNo);
  const metaPath = orderMetaPath(workspaceRoot, identifier);
  const order = readAndValidateOrderMeta(metaPath);
  const submodules = {
    quotes: readSubmoduleMeta(workspaceRoot, identifier, "quotes"),
    inspections: readSubmoduleMeta(workspaceRoot, identifier, "inspections"),
    payments: readSubmoduleMeta(workspaceRoot, identifier, "payments"),
    shipments: readSubmoduleMeta(workspaceRoot, identifier, "shipments"),
    invoices: readSubmoduleMeta(workspaceRoot, identifier, "invoices"),
    reconciliations: readSubmoduleMeta(workspaceRoot, identifier, "reconciliations"),
    archives: readSubmoduleMeta(workspaceRoot, identifier, "archives"),
    attachments: readSubmoduleMeta(workspaceRoot, identifier, "attachments"),
  };
  return {
    order,
    process_status: deriveOrderProcessStatus(order, submodules),
    submodules,
    files: listOrderFiles(workspaceRoot, identifier).map((filePath) => path.relative(workspaceRoot, filePath).split(path.sep).join("/")),
  };
}

export function listOrders(workspaceRoot: string): OrderListItem[] {
  return listOrderDirectories(workspaceRoot).map((orderNo) => {
    try {
      const meta = readAndValidateOrderMeta(orderMetaPath(workspaceRoot, orderNo));
      return orderSummary(workspaceRoot, orderNo, meta, null);
    } catch (error) {
      const fallback = readOrderMeta(workspaceRoot, orderNo);
      return orderSummary(workspaceRoot, orderNo, fallback ?? defaultOrderMeta(orderNo), error instanceof Error ? error.message : String(error));
    }
  });
}

export function listCustomers(workspaceRoot: string): CustomerListItem[] {
  const grouped = new Map<string, CustomerListItem>();
  for (const orderNo of listOrderDirectories(workspaceRoot)) {
    const meta = readOrderMeta(workspaceRoot, orderNo);
    if (!meta) continue;
    const customer = asObject(meta.customer);
    const name = stringOrNull(customer.name);
    if (!name) continue;
    const dates = asObject(meta.dates);
    const totals = asObject(meta.totals);
    const currency = String(meta.currency ?? "CNY");
    const orderDate = stringOrNull(dates.order_date);
    const amount = numberOrNull(totals.customer_payable);
    const current = grouped.get(name) ?? {
      name,
      country: stringOrNull(customer.country),
      contact_name: stringOrNull(customer.contact_name),
      contact_email: stringOrNull(customer.contact_email),
      order_count: 0,
      total_amount: 0,
      currency,
      latest_order_date: null,
    };
    current.order_count += 1;
    current.country = current.country ?? stringOrNull(customer.country);
    current.contact_name = current.contact_name ?? stringOrNull(customer.contact_name);
    current.contact_email = current.contact_email ?? stringOrNull(customer.contact_email);
    if (amount !== null) {
      current.total_amount = (current.total_amount ?? 0) + amount;
    }
    if (!current.currency) current.currency = currency;
    if (orderDate && (!current.latest_order_date || orderDate > current.latest_order_date)) {
      current.latest_order_date = orderDate;
    }
    grouped.set(name, current);
  }
  return [...grouped.values()]
    .map((customer) => validateCustomerSummary(customer))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function validateCustomerSummary(customer: CustomerListItem): CustomerListItem {
  validateJsonObject(customer as unknown as JsonObject, loadCustomerSchema(), "customer summary");
  return customer;
}

function orderSummary(
  workspaceRoot: string,
  orderNo: string,
  meta: JsonObject,
  validationError: string | null,
): OrderListItem {
  const customer = asObject(meta.customer);
  const dates = asObject(meta.dates);
  const totals = asObject(meta.totals);
  return {
    order_no: orderNo,
    customer: stringOrNull(customer.name),
    status: String(meta.status ?? "draft"),
    process_status: orderProcessStatus(workspaceRoot, orderNo, meta),
    order_date: stringOrNull(dates.order_date),
    amount: numberOrNull(totals.customer_payable),
    currency: String(meta.currency ?? "CNY"),
    validation_error: validationError,
  };
}

/**
 * The list view only needs the first incomplete workflow stage. Reading every
 * submodule validated up to eight JSON files per order even when a quote had
 * not yet been prepared. Keep the full read for an order-detail page, while
 * short-circuiting the summary list at the first incomplete stage.
 */
function orderProcessStatus(workspaceRoot: string, orderNo: string, order: JsonObject): string {
  if (String(order.status ?? "draft") === "cancelled") return "已取消";
  if (!isQuoteReady(readSubmoduleMeta(workspaceRoot, orderNo, "quotes"))) return "待报价";
  if (!isInspectionReady(readSubmoduleMeta(workspaceRoot, orderNo, "inspections"))) return "待报检";
  if (!isPaymentReady(readSubmoduleMeta(workspaceRoot, orderNo, "payments"))) return "待收款";
  if (!isShipmentReady(readSubmoduleMeta(workspaceRoot, orderNo, "shipments"))) return "待发货";
  if (!isInvoiceReady(readSubmoduleMeta(workspaceRoot, orderNo, "invoices"))) return "待开票";
  if (!isReconciliationReady(readSubmoduleMeta(workspaceRoot, orderNo, "reconciliations"))) return "待对账";
  if (!isArchiveReady(readSubmoduleMeta(workspaceRoot, orderNo, "archives"))) return "待归档";
  return "已归档";
}

function deriveOrderProcessStatus(
  order: JsonObject,
  submodules: Record<Exclude<OrderModuleKind, "orders">, JsonObject | null>,
): string {
  const rawOrderStatus = String(order.status ?? "draft");
  if (rawOrderStatus === "cancelled") return "已取消";

  if (!isQuoteReady(submodules.quotes)) return "待报价";
  if (!isInspectionReady(submodules.inspections)) return "待报检";
  if (!isPaymentReady(submodules.payments)) return "待收款";
  if (!isShipmentReady(submodules.shipments)) return "待发货";
  if (!isInvoiceReady(submodules.invoices)) return "待开票";
  if (!isReconciliationReady(submodules.reconciliations)) return "待对账";
  if (!isArchiveReady(submodules.archives)) return "待归档";
  return "已归档";
}

function hasGeneratedDocuments(meta: JsonObject | null, kinds: string[]): boolean {
  if (!meta) return false;
  const documents = Array.isArray(meta.documents) ? meta.documents : [];
  return documents.some((document) => {
    if (!isJsonObject(document)) return false;
    const pathValue = typeof document.path === "string" ? document.path.toLowerCase() : "";
    const kindValue = typeof document.kind === "string" ? document.kind : "";
    return Boolean(pathValue.endsWith(".pdf") || pathValue.endsWith(".html")) && (kinds.length === 0 || kinds.includes(kindValue));
  });
}

function isQuoteReady(meta: JsonObject | null): boolean {
  const status = String(meta?.status ?? "");
  return ["sent", "accepted", "expired", "cancelled"].includes(status) || hasGeneratedDocuments(meta, ["quote", "pi"]);
}

function isInspectionReady(meta: JsonObject | null): boolean {
  const status = String(meta?.status ?? "");
  return ["passed", "failed", "recheck"].includes(status) || hasGeneratedDocuments(meta, ["inspection"]);
}

function isPaymentReady(meta: JsonObject | null): boolean {
  const status = String(meta?.status ?? "");
  return ["paid", "refunded"].includes(status);
}

function isShipmentReady(meta: JsonObject | null): boolean {
  const status = String(meta?.status ?? "");
  return ["shipped", "delivered"].includes(status);
}

function isInvoiceReady(meta: JsonObject | null): boolean {
  const status = String(meta?.status ?? "");
  return ["issued", "cancelled"].includes(status) || hasGeneratedDocuments(meta, ["invoice", "ci"]);
}

function isReconciliationReady(meta: JsonObject | null): boolean {
  const status = String(meta?.status ?? "");
  return ["matched", "closed"].includes(status);
}

function isArchiveReady(meta: JsonObject | null): boolean {
  const status = String(meta?.status ?? "");
  return status === "complete";
}

export function listOrderFiles(workspaceRoot: string, orderNo: string): string[] {
  const orderDir = orderDirPath(workspaceRoot, orderNo);
  if (!fs.existsSync(orderDir)) return [];
  const files: string[] = [];
  const stack = [orderDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const itemPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(itemPath);
      else if (entry.isFile()) files.push(itemPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

export function safeOrderPath(workspaceRoot: string, orderNo: string, relativePath: string): string {
  return orderDescendantPath(workspaceRoot, orderNo, relativePath);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultArchive(): JsonObject {
  return {
    status: "pending",
    archived_at: null,
    location: null,
    documents: [],
    notes: [],
  };
}

function defaultPayment(): JsonObject {
  return {
    status: "pending",
    receivable_amount: null,
    received_amount: null,
    method: null,
    received_at: null,
    exchange_rate: null,
    proof_documents: [],
    notes: [],
  };
}

function defaultFulfillment(): JsonObject {
  return {
    status: "pending",
    ship_date: null,
    carrier: null,
    channel: null,
    tracking_no: null,
    destination_country: null,
    package_count: null,
    estimated_weight_kg: null,
    actual_weight_kg: null,
    shipping_cost: null,
    documents: [],
    notes: [],
  };
}

function defaultReconciliation(): JsonObject {
  return {
    status: "pending",
    checked_at: null,
    sales_amount: null,
    received_amount: null,
    invoice_amount: null,
    logistics_cost: null,
    supplier_payable: null,
    difference: null,
    documents: [],
    notes: [],
  };
}

function normalizeSubmoduleMeta(kind: Exclude<OrderModuleKind, "orders">, data: JsonObject): JsonObject {
  if (kind === "quotes") {
    return {
      ...defaultSubmoduleMeta("quotes", String(data.order_no ?? "")),
      ...data,
      schema_version: 2,
      items: normalizeTradeDocumentItems(data.items),
      totals: normalizeTradeDocumentTotals(data.totals),
      ports: isJsonObject(data.ports) ? { loading: stringOrNull(data.ports.loading), discharge: stringOrNull(data.ports.discharge) } : { loading: null, discharge: null },
      trade_term: isJsonObject(data.trade_term) ? { label: stringOrNull(data.trade_term.label), place: stringOrNull(data.trade_term.place) } : { label: null, place: null },
      notes: Array.isArray(data.notes) ? data.notes : [],
      documents: Array.isArray(data.documents) ? data.documents : [],
    };
  }
  if (kind === "invoices") {
    return {
      ...defaultSubmoduleMeta("invoices", String(data.order_no ?? "")),
      ...data,
      schema_version: 2,
      items: normalizeTradeDocumentItems(data.items),
      totals: normalizeTradeDocumentTotals(data.totals),
      ports: isJsonObject(data.ports) ? { loading: stringOrNull(data.ports.loading), discharge: stringOrNull(data.ports.discharge) } : { loading: null, discharge: null },
      trade_term: isJsonObject(data.trade_term) ? { label: stringOrNull(data.trade_term.label), place: stringOrNull(data.trade_term.place) } : { label: null, place: null },
      notes: Array.isArray(data.notes) ? data.notes : [],
      documents: Array.isArray(data.documents) ? data.documents : [],
    };
  }
  return data;
}

function normalizeTradeDocumentItems(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.reduce<JsonObject[]>((items, entry, index) => {
    if (!isJsonObject(entry)) return items;
    items.push({
      line_no: typeof entry.line_no === "number" ? entry.line_no : index + 1,
      product_id: entry.product_id ?? null,
      description: stringOrNull(entry.description),
      package_description: stringOrNull(entry.package_description),
      size: stringOrNull(entry.size),
      quantity_ctns: numberOrNull(entry.quantity_ctns ?? entry.quantity),
      weight_kgs: numberOrNull(entry.weight_kgs),
      unit_price_usd_per_kg: numberOrNull(entry.unit_price_usd_per_kg ?? entry.discount_price),
      amount_usd: numberOrNull(entry.amount_usd ?? entry.amount),
      notes: Array.isArray(entry.notes) ? entry.notes.map((note) => String(note)) : [],
    });
    return items;
  }, []);
}

function normalizeTradeDocumentTotals(value: unknown): JsonObject {
  const totals = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    quantity_ctns: numberOrNull(totals.quantity_ctns),
    weight_kgs: numberOrNull(totals.weight_kgs),
    amount_usd: numberOrNull(totals.amount_usd ?? totals.customer_payable),
    amount_words: stringOrNull(totals.amount_words),
  };
}

function normalizeOrderCustomer(value: unknown): JsonObject {
  const customer = isJsonObject(value as JsonValue) ? (value as JsonObject) : {};
  const legacyContact = stringOrNull(customer.contact);
  const parsed = parseLegacyContact(legacyContact);
  return {
    name: stringOrNull(customer.name),
    country: stringOrNull(customer.country),
    contact_name: stringOrNull(customer.contact_name) ?? parsed.name,
    contact_email: stringOrNull(customer.contact_email) ?? parsed.email,
  };
}

function parseLegacyContact(value: string | null): { name: string | null; email: string | null } {
  if (!value) return { name: null, email: null };
  const angleMatch = value.match(/^(.*?)<([^>]+)>$/);
  if (angleMatch) {
    return {
      name: stringOrNull(angleMatch[1]?.trim()),
      email: stringOrNull(angleMatch[2]?.trim()),
    };
  }
  if (value.includes("@")) {
    return { name: null, email: stringOrNull(value.trim()) };
  }
  return { name: stringOrNull(value.trim()), email: null };
}

function normalizeOrderPackaging(value: unknown): "normal" | "gift" | null {
  if (value === "normal" || value === "gift") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "normal") return "normal";
    if (normalized === "gift") return "gift";
  }
  return null;
}

function normalizeOrderLines(value: unknown): OrderLineItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        const trimmed = entry.trim();
        if (!trimmed) return null;
        const numeric = Number(trimmed);
        return {
          product_id: Number.isInteger(numeric) ? numeric : trimmed,
          quantity: 1,
        };
      }
      if (typeof entry === "number") {
        return Number.isFinite(entry)
          ? {
            product_id: entry,
            quantity: 1,
          }
          : null;
      }
      if (!isJsonObject(entry)) return null;
      const productId = entry.product_id;
      const quantity = numberOrNull(entry.quantity) ?? 1;
      if (quantity < 0) return null;
      if (typeof productId === "string") {
        const trimmed = productId.trim();
        if (!trimmed) return null;
        const numeric = Number(trimmed);
        return {
          product_id: Number.isInteger(numeric) ? numeric : trimmed,
          quantity,
        };
      }
      if (typeof productId === "number") {
        return Number.isFinite(productId)
          ? {
            product_id: productId,
            quantity,
          }
          : null;
      }
      return null;
    })
    .filter((entry): entry is OrderLineItem => entry !== null);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}
