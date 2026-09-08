import fs from "node:fs";
import path from "node:path";
import {
  formatProductSku,
  listPromoBatches,
  productRoot,
  skuCategoryFromProductCategory,
  skuSubcategoryFromProductCategory,
} from "../src/products.js";
import { type JsonObject, isJsonObject, writeJsonFile } from "../src/json.js";
import { validateProductMeta } from "../src/meta-schema.js";

type LegacyProduct = {
  batch: string;
  meta: Record<string, unknown>;
  path: string;
  slug: string;
};

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  return isJsonObject(value as JsonObject) ? value as Record<string, unknown> : {};
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

function nonNegativeIntegerOrDefault(value: unknown, fallback: number): number {
  const numeric = numberOrNull(value);
  return numeric !== null && Number.isInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

function textOrNull(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : [];
}

function migratedPackaging(value: unknown): JsonObject {
  const packaging = asObject(value);
  const normal = asObject(packaging.normal);
  const gift = asObject(packaging.gift);
  const legacyDimensions = asObject(packaging.dimensions_mm);
  const normalDimensions = asObject(normal.dimensions_mm);
  const giftDimensions = asObject(gift.dimensions_mm);
  const legacyGift = packaging.package_type === "精装"
    || (Array.isArray(packaging.package_types) && packaging.package_types.includes("精装"));
  return {
    normal: {
      dimensions_mm: {
        length: numberOrNull(normalDimensions.length ?? legacyDimensions.length),
        width: numberOrNull(normalDimensions.width ?? legacyDimensions.width),
        height: numberOrNull(normalDimensions.height ?? legacyDimensions.height),
      },
      weight_with_packaging_kg: numberOrNull(normal.weight_with_packaging_kg ?? packaging.weight_with_packaging_kg),
    },
    gift: {
      dimensions_mm: {
        length: numberOrNull(giftDimensions.length),
        width: numberOrNull(giftDimensions.width),
        height: numberOrNull(giftDimensions.height),
      },
      weight_with_packaging_kg: numberOrNull(
        gift.weight_with_packaging_kg
        ?? (legacyGift ? packaging.weight_with_packaging_kg : null),
      ),
    },
  };
}

function migratedPricing(value: unknown): JsonObject {
  const pricing = asObject(value);
  const legacyMarkets = asObject(pricing.markets);
  const names = Object.keys(legacyMarkets);
  const fallbackMarket = typeof pricing.default_market === "string" && pricing.default_market.trim()
    ? pricing.default_market
    : names[0] ?? "CN";
  const marketNames = names.length > 0 ? names : [fallbackMarket];
  const markets: Record<string, JsonObject> = {};
  for (const name of marketNames) {
    const market = asObject(legacyMarkets[name]);
    markets[name] = {
      currency: typeof market.currency === "string" && market.currency.trim()
        ? market.currency
        : "CNY",
      list_price: numberOrNull(market.list_price),
      promo_price: numberOrNull(market.promo_price),
      floor_price: numberOrNull(market.floor_price),
    };
  }
  const legacyCosts = asObject(pricing.costs);
  const defaultCurrency = typeof legacyCosts.currency === "string" && legacyCosts.currency.trim()
    ? legacyCosts.currency
    : String(asObject(markets[fallbackMarket]).currency ?? "CNY");
  return {
    default_market: fallbackMarket,
    costs: {
      currency: defaultCurrency,
      purchase_price: numberOrNull(legacyCosts.purchase_price),
      packaging_price: numberOrNull(legacyCosts.packaging_price),
      labor_price: numberOrNull(legacyCosts.labor_price),
    },
    markets,
  };
}

function migratedCopy(value: unknown): JsonObject {
  const copy = asObject(value);
  return {
    title: textOrNull(copy.title),
    selling_points: textArray(copy.selling_points),
    description: textOrNull(copy.description),
    faq: textArray(copy.faq),
  };
}

function sourceSku(meta: Record<string, unknown>): string {
  if (typeof meta.id !== "number" || !Number.isInteger(meta.id) || meta.id < 0) {
    throw new Error("Legacy product is missing a non-negative numeric id");
  }
  return formatProductSku(skuSubcategoryFromProductCategory(meta.category), meta.id);
}

function relativeAssetReference(
  value: unknown,
  legacyFiguresDir: string,
  fallbackPrefix: string,
): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const prefixes = [legacyFiguresDir.replace(/\/+$/, ""), fallbackPrefix];
  for (const prefix of prefixes) {
    if (normalized === prefix) return "";
    if (normalized.startsWith(`${prefix}/`)) return normalized.slice(prefix.length + 1);
  }
  if (normalized.includes("..")) {
    throw new Error(`Unsafe legacy asset reference: ${value}`);
  }
  return normalized;
}

function migratedMeta(product: LegacyProduct, sku: string): JsonObject {
  const meta = product.meta;
  if (meta.schema !== "wanghai.promo.product-meta" || meta.schema_version !== 2) {
    throw new Error(`${product.batch}/${product.slug} is not product meta schema v2`);
  }
  const legacyAssets = asObject(meta.assets);
  const legacyFiguresDir = typeof legacyAssets.figures_dir === "string"
    ? legacyAssets.figures_dir.replace(/\\/g, "/")
    : "";
  if (!legacyFiguresDir) {
    throw new Error(`${product.batch}/${product.slug} is missing assets.figures_dir`);
  }
  const fallbackPrefix = path.posix.join(
    "产品管理",
    "商品素材",
    "batches",
    product.batch,
    "products",
    product.slug,
  );
  const figuresDir = path.posix.join("产品管理", "产品库", sku);
  const skuCategory = skuCategoryFromProductCategory(meta.category);
  const skuSubcategory = skuSubcategoryFromProductCategory(meta.category);
  const selected = asObject(legacyAssets.selected);
  const reference = (value: unknown) => {
    const relative = relativeAssetReference(value, legacyFiguresDir, fallbackPrefix);
    return relative === null ? null : `${figuresDir}/${relative}`.replace(/\/$/, "");
  };
  const next: JsonObject = {
    schema: "wanghai.promo.product-meta",
    schema_version: 5,
    sku,
    sku_category: skuCategory,
    sku_subcategory: skuSubcategory,
    id: meta.id as number,
    name: textOrNull(meta.name),
    name_en: textOrNull(meta.name_en),
    status: ["draft", "review", "ready"].includes(String(meta.status))
      ? meta.status as string
      : "draft",
    inventory: nonNegativeIntegerOrDefault(meta.inventory, 1),
    include_in_external: meta.include_in_external === true,
    source: {
      legacy_batch: product.batch,
      legacy_slug: product.slug,
    },
    packaging: migratedPackaging(meta.packaging),
    pricing: migratedPricing(meta.pricing),
    copy: migratedCopy(meta.copy),
    assets: {
      figures_dir: figuresDir,
      source_dir: `${figuresDir}/assets`,
      selected: {
        near: reference(selected.near),
        wear: reference(selected.wear),
        detail: reference(selected.detail),
      },
      promo_usage_image: reference(legacyAssets.promo_usage_image),
    },
    notes: textArray(meta.notes),
  };
  return next;
}

function legacyProducts(workspaceRoot: string): LegacyProduct[] {
  const products: LegacyProduct[] = [];
  for (const batch of listPromoBatches(workspaceRoot)) {
    const productsDir = path.join(
      workspaceRoot,
      "产品管理",
      "商品素材",
      "batches",
      batch,
      "products",
    );
    if (!fs.existsSync(productsDir)) continue;
    for (const entry of fs.readdirSync(productsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
      const productPath = path.join(productsDir, entry.name);
      const metaPath = path.join(productPath, "meta.json");
      if (!fs.existsSync(metaPath)) continue;
      const parsed = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (!isJsonObject(parsed)) {
        throw new Error(`${batch}/${entry.name}: meta.json must contain an object`);
      }
      products.push({ batch, meta: parsed, path: productPath, slug: entry.name });
    }
  }
  return products.sort((a, b) => `${a.batch}/${a.slug}`.localeCompare(`${b.batch}/${b.slug}`));
}

function migrate(workspaceRoot: string, dryRun: boolean): number {
  const legacy = legacyProducts(workspaceRoot);
  const destinationRoot = productRoot(workspaceRoot);
  const planned = legacy.map((product) => {
    const sku = sourceSku(product.meta);
    const destination = path.join(destinationRoot, sku);
    const meta = migratedMeta(product, sku);
    validateProductMeta(meta, path.join(destination, "meta.json"));
    return { destination, meta, product, sku };
  });
  const skus = new Set<string>();
  for (const entry of planned) {
    if (skus.has(entry.sku)) throw new Error(`Duplicate SKU generated during migration: ${entry.sku}`);
    skus.add(entry.sku);
    if (fs.existsSync(entry.destination)) {
      throw new Error(`Product library destination already exists: ${entry.sku}`);
    }
  }
  if (dryRun) return planned.length;
  for (const entry of planned) {
    fs.cpSync(entry.product.path, entry.destination, { errorOnExist: true, recursive: true });
    fs.mkdirSync(path.join(entry.destination, "assets"), { recursive: true });
    writeJsonFile(path.join(entry.destination, "meta.json"), entry.meta);
  }
  return planned.length;
}

const workspaceRoot = path.resolve(requiredArgument("--workspace-root"));
const dryRun = process.argv.includes("--dry-run");
const count = migrate(workspaceRoot, dryRun);
console.log(dryRun
  ? `Validated ${count} products for SKU product-library migration.`
  : `Migrated ${count} products into the SKU product library.`);
