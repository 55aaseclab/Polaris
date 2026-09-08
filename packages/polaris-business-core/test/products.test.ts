import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  createProduct,
  deleteProduct,
  deleteProductAsset,
  findProductBySku,
  formatProductSku,
  listProductAssets,
  listProducts,
  nextProductSku,
  productImageSlots,
  readProduct,
  renameProductSku,
  skuCategoryFromSku,
  skuSubcategoryFromSku,
  writeProductAsset,
} from "../src/products.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { force: true, recursive: true });
  }
});

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-products-"));
  fs.mkdirSync(path.join(root, "产品管理"), { recursive: true });
  tempDirs.push(root);
  return root;
}

function makeManagedWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-products-managed-"));
  fs.mkdirSync(path.join(root, "assets", "产品管理", "产品库"), { recursive: true });
  tempDirs.push(root);
  return root;
}

describe("SKU product library", () => {
  it("uses category code 5 for test products", () => {
    const sku = formatProductSku("test_products", 1);

    assert.equal(sku, "SKU-5-1-001");
    assert.equal(skuCategoryFromSku(sku), "test");
    assert.equal(skuSubcategoryFromSku(sku), "test_products");
  });

  it("creates, renames, and deletes a SKU product", () => {
    const root = makeWorkspace();
    const created = createProduct(root, {
      name: "Example Product",
      sku: "SKU-1-1-001",
      skuSubcategory: "earrings",
    });

    assert.equal(created.sku, "SKU-1-1-001");
    assert.equal(created.meta.schema_version, 5);
    assert.equal(created.meta.sku, "SKU-1-1-001");
    assert.equal(created.meta.sku_category, "wear");
    assert.equal(created.meta.sku_subcategory, "earrings");
    assert.equal("category" in created.meta, false);
    assert.equal(listProducts(root).length, 1);
    assert.equal(findProductBySku(root, "SKU-1-1-001")?.sku, "SKU-1-1-001");
    assert.equal(nextProductSku(root, "earrings"), "SKU-1-1-002");

    const renamed = renameProductSku(root, "SKU-1-1-001", "SKU-1-1-002", "earrings");
    assert.equal(renamed.sku, "SKU-1-1-002");
    assert.equal(readProduct(root, "SKU-1-1-002").meta.sku, "SKU-1-1-002");
    assert.equal(findProductBySku(root, "SKU-1-1-001"), null);

    deleteProduct(root, "SKU-1-1-002");
    assert.equal(listProducts(root).length, 0);
  });

  it("persists the ecommerce product offer and cost inputs", () => {
    const root = makeWorkspace();
    const created = createProduct(root, {
      defaultMarket: "US",
      description: "A product description",
      name: "Example Product",
      nameEn: "Example Product",
      pricing: {
        costCurrency: "CNY",
        currency: "USD",
        floorPrice: 18,
        laborPrice: 3,
        listPrice: 30,
        market: "US",
        packagingPrice: 2,
        promoPrice: 25,
        purchasePrice: 10,
      },
      sku: "SKU-1-1-001",
      skuSubcategory: "earrings",
    });

    const pricing = created.meta.pricing as Record<string, any>;
    const market = (pricing.markets as Record<string, any>).US;
    const costs = pricing.costs as Record<string, any>;
    assert.equal(created.meta.name_en, "Example Product");
    assert.equal((created.meta.copy as Record<string, any>).description, "A product description");
    assert.equal(pricing.default_market, "US");
    assert.equal(market.list_price, 30);
    assert.equal(market.promo_price, 25);
    assert.equal(market.floor_price, 18);
    assert.equal(costs.purchase_price, 10);
    assert.equal(costs.packaging_price, 2);
    assert.equal(costs.labor_price, 3);
  });

  it("lists and deletes product assets without touching meta.json", () => {
    const root = makeWorkspace();
    const product = createProduct(root, { sku: "SKU-1-1-001", skuSubcategory: "earrings" });
    const assetPath = path.join(product.path, "assets", "reference.txt");
    fs.writeFileSync(assetPath, "synthetic fixture", "utf-8");

    const assets = listProductAssets(product);
    assert.equal(assets.length, 1);
    assert.equal(assets[0]?.relative_path, "assets/reference.txt");

    deleteProductAsset(root, product.sku, "assets/reference.txt");
    assert.equal(listProductAssets(readProduct(root, product.sku)).length, 0);
    assert.equal(fs.existsSync(path.join(product.path, "meta.json")), true);
  });

  it("refuses to delete an asset through a product symlink", () => {
    const root = makeWorkspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-products-outside-"));
    tempDirs.push(outside);
    const product = createProduct(root, { sku: "SKU-1-1-001", skuSubcategory: "earrings" });
    const outsideAsset = path.join(outside, "outside.txt");
    fs.writeFileSync(outsideAsset, "synthetic outside fixture", "utf8");
    fs.symlinkSync(outside, path.join(product.path, "assets", "outside"));

    assert.throws(
      () => deleteProductAsset(root, product.sku, "assets/outside/outside.txt"),
      /symlink outside/i,
    );
    assert.equal(fs.readFileSync(outsideAsset, "utf8"), "synthetic outside fixture");
  });

  it("refuses product directories and product roots that are symlinks", () => {
    const root = makeWorkspace();
    const outside = makeWorkspace();
    const outsideProduct = createProduct(outside, { sku: "SKU-1-1-001", skuSubcategory: "earrings" });
    const productRoot = path.join(root, "产品管理", "产品库");
    fs.mkdirSync(productRoot, { recursive: true });
    fs.symlinkSync(outsideProduct.path, path.join(productRoot, outsideProduct.sku));

    assert.throws(() => readProduct(root, outsideProduct.sku), /symlink/i);
    assert.throws(
      () => renameProductSku(root, outsideProduct.sku, "SKU-1-1-002", "earrings"),
      /symlink/i,
    );

    const internalRoot = path.join(root, "untrusted-product-root");
    fs.mkdirSync(internalRoot, { recursive: true });
    fs.rmSync(productRoot, { force: true, recursive: true });
    fs.symlinkSync(internalRoot, productRoot);
    assert.throws(
      () => createProduct(root, { sku: "SKU-1-1-002", skuSubcategory: "earrings" }),
      /symlink/i,
    );
  });

  it("refuses image discovery and writes through symlinked asset directories", () => {
    const root = makeWorkspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wanghai-products-outside-"));
    tempDirs.push(outside);
    const product = createProduct(root, { sku: "SKU-1-1-001", skuSubcategory: "earrings" });
    const imageDir = path.join(product.path, "01_单品近景");
    fs.rmSync(imageDir, { force: true, recursive: true });
    fs.writeFileSync(path.join(outside, "outside.png"), "synthetic image fixture", "utf8");
    fs.symlinkSync(outside, imageDir);

    assert.throws(() => productImageSlots(readProduct(root, product.sku)), /symlink/i);

    const assetsDir = path.join(product.path, "assets");
    fs.rmSync(assetsDir, { force: true, recursive: true });
    fs.symlinkSync(outside, assetsDir);
    assert.throws(
      () => writeProductAsset(readProduct(root, product.sku), "asset.txt", Buffer.from("synthetic upload")),
      /symlink/i,
    );
    assert.equal(fs.existsSync(path.join(outside, "asset.txt")), false);
  });

  it("does not replace an existing product asset", () => {
    const root = makeWorkspace();
    const product = createProduct(root, { sku: "SKU-1-1-001", skuSubcategory: "earrings" });
    const assetPath = writeProductAsset(product, "asset.txt", Buffer.from("first upload"));

    assert.throws(
      () => writeProductAsset(product, "asset.txt", Buffer.from("second upload")),
      /EEXIST/i,
    );
    assert.equal(fs.readFileSync(assetPath, "utf8"), "first upload");
  });

  it("returns workspace-root-relative asset paths for migrated workspaces", () => {
    const root = makeManagedWorkspace();
    const created = createProduct(root, { sku: "SKU-1-1-001", skuSubcategory: "earrings" });
    const thumbPath = path.join(created.path, "ai", "thumb.png");
    fs.writeFileSync(thumbPath, "synthetic image fixture", "utf8");

    const staleMeta = {
      ...created.meta,
      assets: {
        ...(created.meta.assets as Record<string, unknown>),
        figures_dir: "产品管理/产品库/SKU-1-1-001",
        promo_usage_image: "产品管理/产品库/SKU-1-1-001/ai/thumb.png",
      },
    };
    fs.writeFileSync(created.metaPath, `${JSON.stringify(staleMeta, null, 2)}\n`, "utf8");

    const product = readProduct(root, created.sku);
    const assets = listProductAssets(product);

    assert.equal(
      assets.find((asset) => asset.name === "thumb.png")?.path,
      "assets/产品管理/产品库/SKU-1-1-001/ai/thumb.png",
    );
    assert.equal(
      productImageSlots(product).promo_usage_image,
      "assets/产品管理/产品库/SKU-1-1-001/ai/thumb.png",
    );
  });
});
