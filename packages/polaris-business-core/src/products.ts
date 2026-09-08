import fs from "node:fs";
import path from "node:path";
import { readAndValidateProductMeta, validateProductMeta } from "./meta-schema.js";
import { isJsonObject, writeJsonFile, writeJsonFileAtomic, type JsonObject } from "./json.js";
import { WorkspacePaths, safeWorkspacePath } from "./workspaces.js";

export type ProductSummary = {
  sku: string;
  workspaceRoot: string;
  path: string;
  metaPath: string;
  meta: JsonObject;
};

export type ProductOrigin = {
  batch: string;
  slug: string;
} | null;

export type ProductAsset = {
  kind: "file" | "image";
  modified_at: string;
  name: string;
  path: string;
  relative_path: string;
  size: number;
};

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"]);
const PRODUCT_IMAGE_DIRECTORIES = ["01_单品近景", "02_佩戴使用", "03_工艺细节", "ai"];

function safeProductWorkspacePath(workspaceRoot: string, targetPath: string): string {
  const root = path.resolve(workspaceRoot);
  const relativePath = path.relative(root, path.resolve(targetPath));
  if (!relativePath || relativePath === "." || relativePath === ".." || relativePath.startsWith(`..${path.sep}`)) {
    throw new Error("Product path resolves outside workspace");
  }
  const resolved = safeWorkspacePath(root, relativePath);
  assertNoSymlinkComponents(root, resolved);
  return resolved;
}

function assertNoSymlinkComponents(rootDir: string, targetPath: string): void {
  const root = path.resolve(rootDir);
  const relativePath = path.relative(root, path.resolve(targetPath));
  let current = root;

  for (const segment of relativePath.split(path.sep)) {
    if (!segment || segment === ".") continue;
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error("Product paths must not contain symlinks");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function productPathForSku(workspaceRoot: string, sku: string, ...segments: string[]): string {
  return safeProductWorkspacePath(
    workspaceRoot,
    path.join(productRoot(workspaceRoot), normalizeSku(sku), ...segments),
  );
}

function productPathForSummary(product: ProductSummary, ...segments: string[]): string {
  return productPathForSku(product.workspaceRoot, product.sku, ...segments);
}

export const PRODUCT_SKU_CATEGORIES = {
  wear: { code: "1", label: "戴的" },
  display: { code: "2", label: "摆的" },
  hang: { code: "3", label: "挂的" },
  use: { code: "4", label: "用的" },
  test: { code: "5", label: "测试产品" },
} as const;

export type ProductSkuCategory = keyof typeof PRODUCT_SKU_CATEGORIES;

export const PRODUCT_SKU_SUBCATEGORIES = {
  earrings: { category: "wear", code: "1", label: "耳环" },
  necklaces: { category: "wear", code: "2", label: "项链" },
  hair_clips: { category: "wear", code: "3", label: "发夹" },
  hairpins: { category: "wear", code: "4", label: "发簪" },
  hair_ties: { category: "wear", code: "5", label: "头绳" },
  ornaments: { category: "display", code: "1", label: "摆件" },
  gourds: { category: "hang", code: "1", label: "葫芦" },
  pendants: { category: "hang", code: "2", label: "挂坠" },
  health_hammers: { category: "use", code: "1", label: "养生锤" },
  test_products: { category: "test", code: "1", label: "测试产品" },
} as const;

export type ProductSkuSubcategory = keyof typeof PRODUCT_SKU_SUBCATEGORIES;

const SKU_PATTERN = /^SKU-([1-5])-([1-9])-(\d{3})$/;
const SKU_CATEGORY_BY_CODE = Object.fromEntries(
  Object.entries(PRODUCT_SKU_CATEGORIES).map(([category, details]) => [details.code, category]),
) as Record<string, ProductSkuCategory>;
const SKU_SUBCATEGORY_BY_CODES = Object.fromEntries(
  Object.entries(PRODUCT_SKU_SUBCATEGORIES).map(([subcategory, details]) => [
    `${PRODUCT_SKU_CATEGORIES[details.category].code}:${details.code}`,
    subcategory,
  ]),
) as Record<string, ProductSkuSubcategory>;
const SKU_SUBCATEGORY_BY_PRODUCT_CATEGORY: Record<string, ProductSkuSubcategory> = {
  "耳环": "earrings",
  "项链": "necklaces",
  "发夹": "hair_clips",
  "发簪": "hairpins",
  "头绳": "hair_ties",
  "摆件": "ornaments",
  "葫芦": "gourds",
  "挂坠": "pendants",
  "养生锤": "health_hammers",
  "测试产品": "test_products",
};

export type ProductImageSlots = {
  near: string | null;
  wear: string | null;
  detail: string | null;
  promo_usage_image: string | null;
};

export type CreateBatchOptions = {
  setLatest?: boolean;
};

export type ProductPricingInput = {
  costCurrency?: string | null;
  currency?: string | null;
  floorPrice?: number | null;
  laborPrice?: number | null;
  listPrice?: number | null;
  market?: string | null;
  packagingPrice?: number | null;
  promoPrice?: number | null;
  purchasePrice?: number | null;
};

export type CreateProductInput = {
  sku: string;
  skuSubcategory: ProductSkuSubcategory;
  defaultMarket?: string | null;
  description?: string | null;
  id?: number | null;
  name?: string | null;
  nameEn?: string | null;
  inventory?: number | null;
  includeInExternal?: boolean;
  pricing?: ProductPricingInput;
};

function asObject(value: unknown): Record<string, unknown> {
  return isJsonObject(value as JsonObject) ? value as Record<string, unknown> : {};
}

function firstImageInDir(product: ProductSummary, dirName: string): string | null {
  const dirPath = productPathForSummary(product, dirName);
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return null;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink())) {
    throw new Error("Product paths must not contain symlinks");
  }
  const entry = entries
    .filter((item) => item.isFile() && IMAGE_EXTENSIONS.has(path.extname(item.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }))
    .at(0);
  return entry ? productPathForSummary(product, dirName, entry.name) : null;
}

function productFiguresDir(product: ProductSummary): string {
  const assets = asObject(product.meta.assets);
  const figuresDir = typeof assets.figures_dir === "string" ? assets.figures_dir.trim() : "";
  if (!figuresDir) throw new Error(`Product ${product.sku} is missing assets.figures_dir`);
  return figuresDir.replace(/\\/g, "/").replace(/\/+$/, "");
}

function actualProductFiguresDir(product: ProductSummary): string {
  return path.relative(product.workspaceRoot, productPathForSummary(product)).split(path.sep).join("/");
}

function workspaceRelativeProductPath(product: ProductSummary, filePath: string): string {
  const productPath = productPathForSummary(product);
  const relative = path.relative(productPath, path.resolve(filePath));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Product asset resolves outside product directory");
  }
  productPathForSummary(product, relative);
  return `${actualProductFiguresDir(product)}/${relative}`;
}

function normalizeSelectedPath(product: ProductSummary, value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const figuresDir = productFiguresDir(product);
  const actualFiguresDir = actualProductFiguresDir(product);
  let selectedPath: string;
  if (normalized === actualFiguresDir || normalized.startsWith(`${actualFiguresDir}/`)) {
    selectedPath = normalized;
  } else if (normalized === figuresDir) {
    selectedPath = actualFiguresDir;
  } else if (normalized.startsWith(`${figuresDir}/`)) {
    selectedPath = `${actualFiguresDir}${normalized.slice(figuresDir.length)}`;
  } else {
    if (normalized.includes("..")) return null;
    selectedPath = `${actualFiguresDir}/${normalized}`;
  }
  if (selectedPath.includes("..")) return null;
  const productRelativePath = selectedPath === actualFiguresDir
    ? ""
    : selectedPath.slice(actualFiguresDir.length + 1);
  productPathForSummary(product, productRelativePath);
  return selectedPath;
}

function selectedImageOrFallback(product: ProductSummary, selectedValue: unknown, dirName: string): string | null {
  const selected = normalizeSelectedPath(product, selectedValue);
  if (selected) return selected;
  const imagePath = firstImageInDir(product, dirName);
  return imagePath ? workspaceRelativeProductPath(product, imagePath) : null;
}

export function productImageSlots(product: ProductSummary): ProductImageSlots {
  const assets = asObject(product.meta.assets);
  const selected = asObject(assets.selected);
  return {
    near: selectedImageOrFallback(product, selected.near, "01_单品近景"),
    wear: selectedImageOrFallback(product, selected.wear, "02_佩戴使用"),
    detail: selectedImageOrFallback(product, selected.detail, "03_工艺细节"),
    promo_usage_image: normalizeSelectedPath(product, assets.promo_usage_image),
  };
}

export function normalizeSku(value: string): string {
  const sku = value.trim().normalize("NFKC").toUpperCase();
  if (!SKU_PATTERN.test(sku)) {
    throw new Error("SKU must use the SKU-1-1-001 format");
  }
  return sku;
}

export function normalizeSkuCategory(value: unknown): ProductSkuCategory {
  if (typeof value === "string" && value in PRODUCT_SKU_CATEGORIES) {
    return value as ProductSkuCategory;
  }
  throw new Error("SKU category must be wear, display, hang, use, or test");
}

export function skuCategoryFromSku(value: string): ProductSkuCategory {
  const match = SKU_PATTERN.exec(normalizeSku(value));
  const category = match?.[1] ? SKU_CATEGORY_BY_CODE[match[1]] : null;
  if (!category) throw new Error(`SKU does not use a supported category code: ${value}`);
  return category;
}

export function normalizeSkuSubcategory(value: unknown): ProductSkuSubcategory {
  if (typeof value === "string" && value in PRODUCT_SKU_SUBCATEGORIES) {
    return value as ProductSkuSubcategory;
  }
  throw new Error("SKU subcategory is not supported");
}

export function skuSubcategoryLabel(value: ProductSkuSubcategory): string {
  const subcategory = normalizeSkuSubcategory(value);
  return PRODUCT_SKU_SUBCATEGORIES[subcategory].label;
}

export function skuSubcategoryFromSku(value: string): ProductSkuSubcategory {
  const match = SKU_PATTERN.exec(normalizeSku(value));
  const categoryCode = match?.[1];
  const subcategoryCode = match?.[2];
  const subcategory = categoryCode && subcategoryCode
    ? SKU_SUBCATEGORY_BY_CODES[`${categoryCode}:${subcategoryCode}`]
    : null;
  if (!subcategory) throw new Error(`SKU does not use a supported subcategory code: ${value}`);
  return subcategory;
}

export function skuCategoryFromProductCategory(value: unknown): ProductSkuCategory {
  return PRODUCT_SKU_SUBCATEGORIES[skuSubcategoryFromProductCategory(value)].category;
}

export function skuSubcategoryFromProductCategory(value: unknown): ProductSkuSubcategory {
  const category = typeof value === "string" ? value.trim() : "";
  const result = SKU_SUBCATEGORY_BY_PRODUCT_CATEGORY[category];
  if (!result) throw new Error(`No SKU subcategory mapping exists for product category: ${category || "(empty)"}`);
  return result;
}

export function formatProductSku(subcategoryValue: ProductSkuSubcategory, serial: number): string {
  if (!Number.isInteger(serial) || serial < 1 || serial > 999) {
    throw new Error("SKU serial must be an integer from 1 through 999");
  }
  const subcategory = normalizeSkuSubcategory(subcategoryValue);
  const details = PRODUCT_SKU_SUBCATEGORIES[subcategory];
  return `SKU-${PRODUCT_SKU_CATEGORIES[details.category].code}-${details.code}-${String(serial).padStart(3, "0")}`;
}

export function latestPromoBatchName(wsp: WorkspacePaths): string | null {
  if (fs.existsSync(wsp.promoLatestFile)) {
    const name = fs.readFileSync(wsp.promoLatestFile, "utf-8").trim();
    if (name) return name;
  }
  if (!fs.existsSync(wsp.promoBatchesDir)) return null;
  const batches = fs
    .readdirSync(wsp.promoBatchesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return batches.at(-1) ?? null;
}

/**
 * Legacy batch discovery remains available solely for the one-time product
 * library migration. New product code must use the SKU library.
 */
export function listPromoBatches(workspaceRoot: string): string[] {
  const wsp = new WorkspacePaths(workspaceRoot);
  if (!fs.existsSync(wsp.promoBatchesDir)) return [];
  return fs
    .readdirSync(wsp.promoBatchesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** @deprecated Legacy batches are not used by the product library. */
export function createPromoBatch(workspaceRoot: string, batch: string, options: CreateBatchOptions = {}): string {
  const wsp = new WorkspacePaths(workspaceRoot);
  const batchDir = path.join(wsp.promoBatchesDir, batch);
  if (fs.existsSync(batchDir)) {
    throw new Error(`Batch already exists: ${batch}`);
  }
  fs.mkdirSync(path.join(batchDir, "products", "_shared"), { recursive: true });
  fs.mkdirSync(path.join(batchDir, "feedback", "notes"), { recursive: true });
  fs.mkdirSync(path.join(batchDir, "feedback", "themes"), { recursive: true });
  writeJsonFile(path.join(batchDir, "batch.json"), {
    schema: "wanghai.promo.batch",
    schema_version: 1,
    name: batch,
    created_at: new Date().toISOString().slice(0, 10),
    workspace: path.basename(workspaceRoot),
  });
  if (options.setLatest ?? true) {
    fs.mkdirSync(path.dirname(wsp.promoLatestFile), { recursive: true });
    fs.writeFileSync(wsp.promoLatestFile, `${batch}\n`, "utf-8");
  }
  return batchDir;
}

export function productRoot(workspaceRoot: string): string {
  return safeProductWorkspacePath(workspaceRoot, new WorkspacePaths(workspaceRoot).productLibraryDir);
}

function productFiguresDirForSku(workspaceRoot: string, sku: string): string {
  const relativeRoot = path.relative(
    workspaceRoot,
    productRoot(workspaceRoot),
  ).split(path.sep).join("/");
  return path.posix.join(relativeRoot, sku);
}

function defaultProductMeta(
  workspaceRoot: string,
  input: Required<Pick<CreateProductInput, "sku" | "skuSubcategory">> & CreateProductInput,
  id: number,
): JsonObject {
  const figuresDir = productFiguresDirForSku(workspaceRoot, input.sku);
  const pricingInput = input.pricing ?? {};
  const defaultMarket = input.defaultMarket?.trim() || pricingInput.market?.trim() || "CN";
  const market = pricingInput.market?.trim() || defaultMarket;
  const currency = pricingInput.currency?.trim() || "CNY";
  const costCurrency = pricingInput.costCurrency?.trim() || currency;
  const offer = {
    currency,
    list_price: pricingInput.listPrice ?? null,
    promo_price: pricingInput.promoPrice ?? null,
    floor_price: pricingInput.floorPrice ?? null,
  };
  const markets: Record<string, JsonObject> = {
    [defaultMarket]: offer,
  };
  if (market !== defaultMarket) markets[market] = { ...offer };

  return {
    schema: "wanghai.promo.product-meta",
    schema_version: 5,
    sku: input.sku,
    sku_category: PRODUCT_SKU_SUBCATEGORIES[input.skuSubcategory].category,
    sku_subcategory: input.skuSubcategory,
    id,
    name: input.name ?? null,
    name_en: input.nameEn ?? null,
    status: "draft",
    inventory: input.inventory ?? 1,
    include_in_external: input.includeInExternal ?? true,
    source: null,
    packaging: {
      normal: {
        dimensions_mm: {
          length: null,
          width: null,
          height: null,
        },
        weight_with_packaging_kg: null,
      },
      gift: {
        dimensions_mm: {
          length: null,
          width: null,
          height: null,
        },
        weight_with_packaging_kg: null,
      },
    },
    pricing: {
      default_market: defaultMarket,
      costs: {
        currency: costCurrency,
        purchase_price: pricingInput.purchasePrice ?? null,
        packaging_price: pricingInput.packagingPrice ?? null,
        labor_price: pricingInput.laborPrice ?? null,
      },
      markets,
    },
    copy: {
      title: null,
      selling_points: [],
      description: input.description ?? null,
      faq: [],
    },
    assets: {
      figures_dir: figuresDir,
      source_dir: `${figuresDir}/assets`,
      selected: {
        near: null,
        wear: null,
        detail: null,
      },
      promo_usage_image: null,
    },
    notes: [],
  };
}

function validProductId(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Product ID must be a non-negative integer");
  }
  return value;
}

export function createProduct(workspaceRoot: string, input: CreateProductInput): ProductSummary {
  const sku = normalizeSku(input.sku);
  const skuSubcategory = normalizeSkuSubcategory(input.skuSubcategory);
  if (skuSubcategoryFromSku(sku) !== skuSubcategory) {
    throw new Error("SKU does not match its selected SKU subcategory");
  }
  const productPath = productPathForSku(workspaceRoot, sku);
  if (fs.existsSync(productPath)) {
    throw new Error(`Product already exists: ${sku}`);
  }
  const id = validProductId(input.id) ?? nextGlobalProductId(workspaceRoot);
  for (const dirName of [...PRODUCT_IMAGE_DIRECTORIES, "assets"]) {
    fs.mkdirSync(productPathForSku(workspaceRoot, sku, dirName), { recursive: true });
  }
  const metaPath = productPathForSku(workspaceRoot, sku, "meta.json");
  const meta = defaultProductMeta(workspaceRoot, { ...input, sku, skuSubcategory }, id);
  validateProductMeta(meta, metaPath);
  writeJsonFile(metaPath, meta);
  return readProduct(workspaceRoot, sku);
}

export function listProducts(workspaceRoot: string): ProductSummary[] {
  const root = productRoot(workspaceRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => readProduct(workspaceRoot, entry.name))
    .sort((a, b) => a.sku.localeCompare(b.sku));
}

export function listAllProducts(workspaceRoot: string): ProductSummary[] {
  return listProducts(workspaceRoot);
}

export function findProductBySku(workspaceRoot: string, sku: string): ProductSummary | null {
  try {
    return readProduct(workspaceRoot, sku);
  } catch {
    return null;
  }
}

export function findProductById(workspaceRoot: string, productId: string | number): ProductSummary | null {
  const id = typeof productId === "number" ? productId : Number(productId);
  if (!Number.isFinite(id)) return null;
  return listProducts(workspaceRoot).find((product) => product.meta.id === id) ?? null;
}

export function nextGlobalProductId(workspaceRoot: string): number {
  let maxId = 0;
  for (const product of listProducts(workspaceRoot)) {
    const id = typeof product.meta.id === "number" ? product.meta.id : null;
    if (id !== null && Number.isInteger(id) && id > maxId) maxId = id;
  }
  return maxId + 1;
}

export function nextProductSku(
  workspaceRoot: string,
  subcategoryValue: ProductSkuSubcategory,
): string {
  const subcategory = normalizeSkuSubcategory(subcategoryValue);
  let highestSerial = 0;
  for (const product of listProducts(workspaceRoot)) {
    if (product.meta.sku_subcategory !== subcategory) continue;
    const match = SKU_PATTERN.exec(product.sku);
    const serial = match?.[3] ? Number(match[3]) : 0;
    if (Number.isInteger(serial) && serial > highestSerial) highestSerial = serial;
  }
  return formatProductSku(subcategory, highestSerial + 1);
}

export function readProduct(workspaceRoot: string, sku: string): ProductSummary {
  const normalizedSku = normalizeSku(sku);
  const productPath = productPathForSku(workspaceRoot, normalizedSku);
  const metaPath = productPathForSku(workspaceRoot, normalizedSku, "meta.json");
  if (!fs.existsSync(metaPath)) throw new Error(`Product meta not found: ${normalizedSku}`);
  const meta = readAndValidateProductMeta(metaPath);
  if (meta.sku !== normalizedSku) {
    throw new Error(`${metaPath}: sku does not match its product directory`);
  }
  const skuCategory = normalizeSkuCategory(meta.sku_category);
  if (skuCategoryFromSku(normalizedSku) !== skuCategory) {
    throw new Error(`${metaPath}: sku does not match sku_category`);
  }
  const skuSubcategory = normalizeSkuSubcategory(meta.sku_subcategory);
  if (skuSubcategoryFromSku(normalizedSku) !== skuSubcategory) {
    throw new Error(`${metaPath}: sku does not match sku_subcategory`);
  }
  return {
    sku: normalizedSku,
    workspaceRoot,
    path: productPath,
    metaPath,
    meta,
  };
}

export function productOrigin(product: ProductSummary): ProductOrigin {
  const source = asObject(product.meta.source);
  const batch = typeof source.legacy_batch === "string" ? source.legacy_batch : null;
  const slug = typeof source.legacy_slug === "string" ? source.legacy_slug : null;
  return batch && slug ? { batch, slug } : null;
}

export function writeProductMeta(metaPath: string, meta: JsonObject): JsonObject {
  validateProductMeta(meta, metaPath);
  writeJsonFileAtomic(metaPath, meta);
  return meta;
}

function rewriteAssetReference(reference: unknown, oldFiguresDir: string, newFiguresDir: string): string | null {
  if (typeof reference !== "string" || !reference.trim()) return null;
  const normalized = reference.trim().replace(/\\/g, "/");
  if (normalized === oldFiguresDir) return newFiguresDir;
  if (normalized.startsWith(`${oldFiguresDir}/`)) {
    return `${newFiguresDir}${normalized.slice(oldFiguresDir.length)}`;
  }
  if (normalized.includes("..")) return null;
  return `${newFiguresDir}/${normalized.replace(/^\/+/, "")}`;
}

function updateMetaForSku(
  workspaceRoot: string,
  product: ProductSummary,
  nextSku: string,
  nextSkuSubcategory: ProductSkuSubcategory,
): JsonObject {
  const next = structuredClone(product.meta) as Record<string, unknown>;
  const oldFiguresDir = productFiguresDir(product);
  const nextFiguresDir = productFiguresDirForSku(workspaceRoot, nextSku);
  const assets = asObject(next.assets);
  const selected = asObject(assets.selected);
  next.sku = nextSku;
  next.sku_category = PRODUCT_SKU_SUBCATEGORIES[nextSkuSubcategory].category;
  next.sku_subcategory = nextSkuSubcategory;
  next.assets = {
    ...assets,
    figures_dir: nextFiguresDir,
    source_dir: `${nextFiguresDir}/assets`,
    selected: {
      near: rewriteAssetReference(selected.near, oldFiguresDir, nextFiguresDir),
      wear: rewriteAssetReference(selected.wear, oldFiguresDir, nextFiguresDir),
      detail: rewriteAssetReference(selected.detail, oldFiguresDir, nextFiguresDir),
    },
    promo_usage_image: rewriteAssetReference(assets.promo_usage_image, oldFiguresDir, nextFiguresDir),
  };
  return next as JsonObject;
}

export function renameProductSku(
  workspaceRoot: string,
  sku: string,
  nextSkuValue: string,
  nextSkuSubcategoryValue?: ProductSkuSubcategory,
): ProductSummary {
  const product = readProduct(workspaceRoot, sku);
  const nextSku = normalizeSku(nextSkuValue);
  const nextSkuSubcategory = nextSkuSubcategoryValue
    ? normalizeSkuSubcategory(nextSkuSubcategoryValue)
    : skuSubcategoryFromSku(nextSku);
  if (skuSubcategoryFromSku(nextSku) !== nextSkuSubcategory) {
    throw new Error("SKU does not match its selected SKU subcategory");
  }
  if (nextSku === product.sku) return product;
  const nextPath = productPathForSku(workspaceRoot, nextSku);
  if (fs.existsSync(nextPath)) throw new Error(`Product already exists: ${nextSku}`);
  const meta = updateMetaForSku(workspaceRoot, product, nextSku, nextSkuSubcategory);
  writeProductMeta(product.metaPath, meta);
  fs.renameSync(product.path, nextPath);
  return readProduct(workspaceRoot, nextSku);
}

function walkProductFiles(product: ProductSummary, relativeDirPath: string, result: string[]): void {
  const dirPath = productPathForSummary(product, relativeDirPath);
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error("Product paths must not contain symlinks");
    }
    const childRelativePath = relativeDirPath ? path.join(relativeDirPath, entry.name) : entry.name;
    const child = productPathForSummary(product, childRelativePath);
    if (entry.isDirectory()) walkProductFiles(product, childRelativePath, result);
    else if (entry.isFile()) result.push(child);
  }
}

export function listProductAssets(product: ProductSummary): ProductAsset[] {
  const files: string[] = [];
  if (fs.existsSync(productPathForSummary(product))) walkProductFiles(product, "", files);
  return files
    .filter((filePath) => path.basename(filePath) !== "meta.json")
    .map((filePath) => {
      const stat = fs.statSync(filePath);
      const relativePath = path.relative(product.path, filePath).split(path.sep).join("/");
      const ext = path.extname(filePath).toLowerCase();
      return {
        kind: IMAGE_EXTENSIONS.has(ext) ? "image" as const : "file" as const,
        modified_at: stat.mtime.toISOString(),
        name: path.basename(filePath),
        path: workspaceRelativeProductPath(product, filePath),
        relative_path: relativePath,
        size: stat.size,
      };
    })
    .sort((a, b) => a.relative_path.localeCompare(b.relative_path));
}

export function writeProductAsset(product: ProductSummary, fileName: string, contents: Uint8Array): string {
  if (!fileName || fileName !== path.basename(fileName) || fileName.includes("\\") || /%[0-9a-f]{2}/iu.test(fileName)) {
    throw new Error("Invalid product asset name");
  }
  const assetsDir = productPathForSummary(product, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const targetPath = productPathForSummary(product, "assets", fileName);
  const descriptor = fs.openSync(targetPath, "wx", 0o600);
  let complete = false;
  try {
    fs.writeFileSync(descriptor, contents);
    complete = true;
  } finally {
    fs.closeSync(descriptor);
    if (!complete) fs.rmSync(targetPath, { force: true });
  }
  return targetPath;
}

function clearAssetReferences(
  workspaceRoot: string,
  product: ProductSummary,
  relativePath: string,
): ProductSummary {
  const meta = structuredClone(product.meta) as Record<string, unknown>;
  const assets = asObject(meta.assets);
  const selected = asObject(assets.selected);
  const expectedPath = `${productFiguresDir(product)}/${relativePath}`;
  let changed = false;
  const nextSelected: Record<string, unknown> = { ...selected };
  for (const slot of ["near", "wear", "detail"]) {
    if (nextSelected[slot] === expectedPath || nextSelected[slot] === relativePath) {
      nextSelected[slot] = null;
      changed = true;
    }
  }
  const promoUsage = assets.promo_usage_image === expectedPath || assets.promo_usage_image === relativePath
    ? null
    : assets.promo_usage_image;
  if (promoUsage !== assets.promo_usage_image) changed = true;
  if (!changed) return product;
  meta.assets = { ...assets, selected: nextSelected, promo_usage_image: promoUsage };
  writeProductMeta(product.metaPath, meta as JsonObject);
  return readProduct(workspaceRoot, product.sku);
}

export function deleteProductAsset(workspaceRoot: string, sku: string, relativePath: string): ProductSummary {
  const product = readProduct(workspaceRoot, sku);
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized === "meta.json" || normalized.includes("..") || path.isAbsolute(normalized)) {
    throw new Error("Invalid product asset path");
  }
  const filePath = productPathForSummary(product, normalized);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error("Product asset not found");
  }
  fs.rmSync(filePath);
  return clearAssetReferences(workspaceRoot, product, normalized);
}

export function deleteProduct(workspaceRoot: string, sku: string): void {
  const product = readProduct(workspaceRoot, sku);
  fs.rmSync(productPathForSummary(product), { recursive: true, force: true });
}
