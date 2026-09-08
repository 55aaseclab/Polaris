import fs from "node:fs";
import path from "node:path";
import {
  formatProductSku,
  normalizeSkuSubcategory,
  productRoot,
  PRODUCT_SKU_SUBCATEGORIES,
  skuSubcategoryFromProductCategory,
  type ProductSkuSubcategory,
} from "../src/products.js";
import { type JsonObject, isJsonObject, writeJsonFile } from "../src/json.js";
import { validateProductMeta } from "../src/meta-schema.js";

type LegacyLibraryProduct = {
  subcategory: ProductSkuSubcategory;
  meta: Record<string, unknown>;
  oldSku: string;
  path: string;
};

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value || value.startsWith("--")) throw new Error(`Missing required argument: ${name}`);
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  return isJsonObject(value as JsonObject) ? value as Record<string, unknown> : {};
}

function productId(product: LegacyLibraryProduct): number {
  const id = product.meta.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 0) {
    throw new Error(`${product.oldSku} is missing a non-negative numeric id`);
  }
  return id;
}

function rewriteAssetReference(
  reference: unknown,
  oldFiguresDir: string,
  newFiguresDir: string,
): string | null {
  if (typeof reference !== "string" || !reference.trim()) return null;
  const normalized = reference.trim().replace(/\\/g, "/");
  if (normalized === oldFiguresDir) return newFiguresDir;
  if (normalized.startsWith(`${oldFiguresDir}/`)) {
    return `${newFiguresDir}${normalized.slice(oldFiguresDir.length)}`;
  }
  if (normalized.includes("..")) throw new Error(`Unsafe asset reference: ${reference}`);
  return `${newFiguresDir}/${normalized.replace(/^\/+/, "")}`;
}

function updatedMeta(product: LegacyLibraryProduct, sku: string): JsonObject {
  const next = structuredClone(product.meta) as Record<string, unknown>;
  const assets = asObject(next.assets);
  const selected = asObject(assets.selected);
  const oldFiguresDir = typeof assets.figures_dir === "string" ? assets.figures_dir : "";
  if (!oldFiguresDir) throw new Error(`${product.oldSku} is missing assets.figures_dir`);
  const newFiguresDir = path.posix.join("产品管理", "产品库", sku);
  next.schema_version = 5;
  next.sku = sku;
  next.sku_category = PRODUCT_SKU_SUBCATEGORIES[product.subcategory].category;
  next.sku_subcategory = product.subcategory;
  delete next.category;
  next.assets = {
    ...assets,
    figures_dir: newFiguresDir,
    source_dir: `${newFiguresDir}/assets`,
    selected: {
      near: rewriteAssetReference(selected.near, oldFiguresDir, newFiguresDir),
      wear: rewriteAssetReference(selected.wear, oldFiguresDir, newFiguresDir),
      detail: rewriteAssetReference(selected.detail, oldFiguresDir, newFiguresDir),
    },
    promo_usage_image: rewriteAssetReference(
      assets.promo_usage_image,
      oldFiguresDir,
      newFiguresDir,
    ),
  };
  return next as JsonObject;
}

function subcategoryFromMeta(meta: Record<string, unknown>): ProductSkuSubcategory {
  if (typeof meta.sku_subcategory === "string") {
    return normalizeSkuSubcategory(meta.sku_subcategory);
  }
  return skuSubcategoryFromProductCategory(meta.category);
}

function legacyLibraryProducts(workspaceRoot: string): LegacyLibraryProduct[] {
  const root = productRoot(workspaceRoot);
  if (!fs.existsSync(root)) throw new Error("Product library does not exist");
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => {
      const productPath = path.join(root, entry.name);
      const metaPath = path.join(productPath, "meta.json");
      if (!fs.existsSync(metaPath)) throw new Error(`${entry.name} is missing meta.json`);
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (!isJsonObject(meta)) throw new Error(`${entry.name}: meta.json must contain an object`);
      if (
        meta.schema !== "wanghai.promo.product-meta"
        || (meta.schema_version !== 4 && meta.schema_version !== 5)
      ) {
        throw new Error(`${entry.name} is not product meta schema v4 or v5`);
      }
      if (meta.sku !== entry.name) throw new Error(`${entry.name}: sku does not match its directory`);
      return {
        subcategory: subcategoryFromMeta(meta),
        meta,
        oldSku: entry.name,
        path: productPath,
      };
    });
}

function migrate(workspaceRoot: string, dryRun: boolean): Record<ProductSkuSubcategory, number> {
  const groups = Object.fromEntries(
    Object.keys(PRODUCT_SKU_SUBCATEGORIES).map((subcategory) => [subcategory, []]),
  ) as Record<ProductSkuSubcategory, LegacyLibraryProduct[]>;
  for (const product of legacyLibraryProducts(workspaceRoot)) groups[product.subcategory].push(product);
  const planned = (Object.entries(groups) as [ProductSkuSubcategory, LegacyLibraryProduct[]][])
    .flatMap(([subcategory, products]) => products
      .sort((left, right) => productId(left) - productId(right) || left.oldSku.localeCompare(right.oldSku))
      .map((product, index) => {
        const sku = formatProductSku(subcategory, index + 1);
        const meta = updatedMeta(product, sku);
        validateProductMeta(meta, path.join(product.path, "meta.json"));
        return { meta, product, sku };
      }));
  const root = productRoot(workspaceRoot);
  const plannedSkus = new Set<string>();
  for (const entry of planned) {
    if (plannedSkus.has(entry.sku)) throw new Error(`Duplicate planned SKU: ${entry.sku}`);
    plannedSkus.add(entry.sku);
    const target = path.join(root, entry.sku);
    if (fs.existsSync(target) && target !== entry.product.path) {
      throw new Error(`Product library destination already exists: ${entry.sku}`);
    }
  }
  if (!dryRun) {
    const staged = planned.map((entry, index) => ({
      ...entry,
      stagedPath: path.join(root, `.__sku-taxonomy-${process.pid}-${index}`),
    }));
    for (const entry of staged) {
      if (fs.existsSync(entry.stagedPath)) throw new Error(`Migration staging path already exists: ${entry.stagedPath}`);
      fs.renameSync(entry.product.path, entry.stagedPath);
    }
    for (const entry of staged) {
      writeJsonFile(path.join(entry.stagedPath, "meta.json"), entry.meta);
      fs.renameSync(entry.stagedPath, path.join(root, entry.sku));
    }
  }
  return {
    earrings: groups.earrings.length,
    necklaces: groups.necklaces.length,
    hair_clips: groups.hair_clips.length,
    hairpins: groups.hairpins.length,
    hair_ties: groups.hair_ties.length,
    ornaments: groups.ornaments.length,
    gourds: groups.gourds.length,
    pendants: groups.pendants.length,
    health_hammers: groups.health_hammers.length,
    test_products: groups.test_products.length,
  };
}

const workspaceRoot = path.resolve(requiredArgument("--workspace-root"));
const dryRun = process.argv.includes("--dry-run");
const counts = migrate(workspaceRoot, dryRun);
const summary = Object.entries(counts).map(([category, count]) => `${category}=${count}`).join(", ");
console.log(dryRun
  ? `Validated SKU taxonomy migration: ${summary}.`
  : `Migrated SKU taxonomy: ${summary}.`);
