import path from "node:path";
import { NextResponse } from "next/server";
import {
  deleteProduct,
  nextProductSku,
  normalizeSkuSubcategory,
  readProduct,
  renameProductSku,
  writeProductMeta,
  writeProductAsset,
  type ProductSummary,
} from "@polaris/business-core/products";
import { type JsonObject, isJsonObject } from "@polaris/business-core/json";
import { productDetail } from "../_product";
import {
  mutateWorkspace,
  readFormData,
  readJsonObject,
  requestError,
  routeParams,
  workspaceMutationJson,
  workspaceFromContext,
  type RouteContext,
} from "../../../../_lib";

const FILE_EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/webp": ".webp",
  "text/plain": ".txt",
};

function asObject(value: unknown): Record<string, unknown> {
  return isJsonObject(value as JsonObject) ? value as Record<string, unknown> : {};
}

function textOrNull(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function integerOrDefault(value: unknown, fallback: number | null): number | null {
  if (value === "" || value === null || value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new Error("Inventory must be a non-negative integer");
  }
  return numeric;
}

function moneyOrFallback(value: unknown, fallback: unknown, label: string): number | null {
  if (value === undefined) {
    return typeof fallback === "number" && Number.isFinite(fallback) ? fallback : null;
  }
  if (value === "" || value === null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return numeric;
}

function lineArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return typeof value === "string"
    ? value.split("\n").map((line) => line.trim()).filter(Boolean)
    : [];
}

function applyPricing(next: Record<string, unknown>, value: unknown): void {
  const input = asObject(value);
  const pricing = asObject(next.pricing);
  const defaultMarket = typeof pricing.default_market === "string" && pricing.default_market
    ? pricing.default_market
    : "CN";
  const costs = asObject(pricing.costs);
  const markets = asObject(pricing.markets);
  const requestedMarket = typeof input.market === "string" ? input.market.trim() : "";
  const marketName = requestedMarket && Object.hasOwn(markets, requestedMarket)
    ? requestedMarket
    : defaultMarket;
  const market = asObject(markets[marketName]);
  next.pricing = {
    ...pricing,
    costs: {
      ...costs,
      purchase_price: moneyOrFallback(input.purchase_price, costs.purchase_price, "Purchase price"),
      packaging_price: moneyOrFallback(input.packaging_price, costs.packaging_price, "Packaging price"),
      labor_price: moneyOrFallback(input.labor_price, costs.labor_price, "Labor price"),
    },
    markets: {
      ...markets,
      [marketName]: {
        ...market,
        list_price: moneyOrFallback(input.list_price, market.list_price, "List price"),
        promo_price: moneyOrFallback(input.promo_price, market.promo_price, "Promotional price"),
        floor_price: moneyOrFallback(input.floor_price, market.floor_price, "Floor price"),
      },
    },
  };
}

function applyProductForm(product: ProductSummary, payload: Record<string, unknown>): JsonObject {
  const next = structuredClone(product.meta) as Record<string, unknown>;
  if ("sku_subcategory" in payload) {
    next.sku_subcategory = normalizeSkuSubcategory(payload.sku_subcategory);
  }
  if ("name" in payload) next.name = textOrNull(payload.name);
  if ("name_en" in payload) next.name_en = textOrNull(payload.name_en);
  if ("inventory" in payload) next.inventory = integerOrDefault(payload.inventory, null);
  if ("status" in payload) {
    const status = String(payload.status ?? "");
    if (!new Set(["draft", "review", "ready"]).has(status)) {
      throw new Error("Unsupported product status");
    }
    next.status = status;
  }
  if ("default_market" in payload) {
    const defaultMarket = textOrNull(payload.default_market);
    if (!defaultMarket) throw new Error("Default market is required");
    const pricing = asObject(next.pricing);
    const markets = asObject(pricing.markets);
    const previousMarket = typeof pricing.default_market === "string" ? pricing.default_market : "CN";
    const sourceMarket = asObject(markets[defaultMarket]).currency
      ? asObject(markets[defaultMarket])
      : asObject(markets[previousMarket]);
    next.pricing = {
      ...pricing,
      default_market: defaultMarket,
      markets: {
        ...markets,
        [defaultMarket]: {
          currency: typeof sourceMarket.currency === "string" ? sourceMarket.currency : "CNY",
          list_price: typeof sourceMarket.list_price === "number" ? sourceMarket.list_price : null,
          promo_price: typeof sourceMarket.promo_price === "number" ? sourceMarket.promo_price : null,
          floor_price: typeof sourceMarket.floor_price === "number" ? sourceMarket.floor_price : null,
        },
      },
    };
  }
  if ("include_in_external" in payload) next.include_in_external = payload.include_in_external === true;
  if ("description" in payload) {
    const copy = asObject(next.copy);
    next.copy = { ...copy, description: textOrNull(payload.description) };
  }
  if ("notes" in payload) next.notes = lineArray(payload.notes);
  if ("pricing" in payload) applyPricing(next, payload.pricing);
  return next as JsonObject;
}

function safeFileStem(value: string): string {
  const ext = path.extname(value);
  const stem = path
    .basename(value, ext)
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return stem || "asset";
}

function timestampLabel(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

async function requestedProduct(
  context: RouteContext<{ workspace: string; sku: string }>,
) {
  const { name, root } = await workspaceFromContext(context);
  const { sku } = await routeParams(context);
  return { name, root, sku: decodeURIComponent(sku) };
}

export async function GET(_request: Request, context: RouteContext<{ workspace: string; sku: string }>) {
  try {
    const { root, sku } = await requestedProduct(context);
    return NextResponse.json({ product: productDetail(readProduct(root, sku)) });
  } catch (error) {
    return requestError(error);
  }
}

export async function PUT(request: Request, context: RouteContext<{ workspace: string; sku: string }>) {
  try {
    const { name, root, sku } = await requestedProduct(context);
    const payload = await readJsonObject(request);
    const current = readProduct(root, sku);
    const skuSubcategory = "sku_subcategory" in payload
      ? normalizeSkuSubcategory(payload.sku_subcategory)
      : normalizeSkuSubcategory(current.meta.sku_subcategory);
    const mutation = await mutateWorkspace({
      request,
      workspace: name,
      workspaceRoot: root,
      mutate: () => {
        const renamed = skuSubcategory === current.meta.sku_subcategory
          ? current
          : renameProductSku(root, sku, nextProductSku(root, skuSubcategory), skuSubcategory);
        const meta = applyProductForm(renamed, payload);
        writeProductMeta(renamed.metaPath, meta);
        return productDetail(readProduct(root, renamed.sku));
      },
    });
    return workspaceMutationJson({ product: mutation.result }, mutation.workspaceVersion);
  } catch (error) {
    return requestError(error);
  }
}

export async function POST(request: Request, context: RouteContext<{ workspace: string; sku: string }>) {
  try {
    const { name, root, sku } = await requestedProduct(context);
    const product = readProduct(root, sku);
    const formData = await readFormData(request);
    const file = formData.get("file");
    if (!(file instanceof File)) throw new Error("Missing product asset");
    if (file.size === 0) throw new Error("Product asset is empty");
    const extension = FILE_EXTENSIONS[file.type];
    if (!extension) throw new Error("Unsupported product asset type");
    const fileName = `${timestampLabel()}-${safeFileStem(file.name)}${extension}`;
    const contents = Buffer.from(await file.arrayBuffer());
    const mutation = await mutateWorkspace({
      request,
      workspace: name,
      workspaceRoot: root,
      mutate: () => {
        writeProductAsset(product, fileName, contents);
        return productDetail(readProduct(root, product.sku));
      },
    });
    return workspaceMutationJson({ product: mutation.result }, mutation.workspaceVersion);
  } catch (error) {
    return requestError(error);
  }
}

export async function DELETE(request: Request, context: RouteContext<{ workspace: string; sku: string }>) {
  try {
    const { name, root, sku } = await requestedProduct(context);
    const mutation = await mutateWorkspace({
      request,
      workspace: name,
      workspaceRoot: root,
      mutate: () => deleteProduct(root, sku),
    });
    return workspaceMutationJson({ ok: true }, mutation.workspaceVersion);
  } catch (error) {
    return requestError(error);
  }
}
