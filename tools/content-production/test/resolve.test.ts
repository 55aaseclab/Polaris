import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createProduct, writeJsonFile } from "@polaris/business-core";
import { parseCatalogInput } from "../src/validate.js";
import { defaultCatalogInput, resolveCatalog } from "../src/resolve.js";
import { renderCatalogHtml } from "../src/render.js";
import { runCatalog } from "../src/run.js";
import { sha256Json } from "../src/hash.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tinyPng(): Buffer {
  // 1x1 PNG
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEugAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
}

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-ws-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "产品管理"), { recursive: true });
  fs.mkdirSync(path.join(root, "产品管理", "交付归档"), { recursive: true });
  return root;
}

function seedProduct(
  workspaceRoot: string,
  opts: {
    sku: string;
    id: number;
    status?: "draft" | "review" | "ready";
    include?: boolean;
    withNear?: boolean;
    listPrice?: number | null;
    market?: string;
  },
): void {
  const product = createProduct(workspaceRoot, {
    sku: opts.sku,
    skuSubcategory: "earrings",
    id: opts.id,
    name: opts.sku,
  });
  const meta = product.meta;
  meta.status = opts.status ?? "ready";
  meta.include_in_external = opts.include ?? true;
  meta.name_en = `${opts.sku}-en`;
  meta.source = { legacy_batch: "batch-a", legacy_slug: opts.sku };
  meta.copy = {
    title: opts.sku,
    selling_points: ["point-a", "point-b", "point-c"],
    description: "A demo product.",
    faq: [],
  };
  const markets = (meta.pricing as { markets: Record<string, unknown> }).markets;
  const market = opts.market ?? "CH";
  markets[market] = {
    currency: market === "CH" ? "CHF" : "CNY",
    list_price: opts.listPrice === undefined ? 29 : opts.listPrice,
    promo_price: null,
    floor_price: null,
  };
  (meta.pricing as { default_market: string }).default_market = market;
  writeJsonFile(product.metaPath, meta);

  if (opts.withNear !== false) {
    const nearDir = path.join(product.path, "01_单品近景");
    fs.writeFileSync(path.join(nearDir, "main.png"), tinyPng());
  }
}

describe("catalog-input schema", () => {
  it("accepts default input", () => {
    const input = defaultCatalogInput({
      catalog_id: "demo-three-sku",
      product_ids: [12, 15, 43],
      market: "CH",
    });
    const parsed = parseCatalogInput(input);
    assert.equal(parsed.catalog_id, "demo-three-sku");
    assert.equal(parsed.selection.mode, "explicit");
  });

  it("rejects bad catalog_id", () => {
    const input = defaultCatalogInput({ catalog_id: "Bad_ID", product_ids: [1] });
    assert.throws(() => parseCatalogInput(input), /catalog_id/);
  });
});

describe("resolveCatalog", () => {
  it("includes ready products and skips draft / missing image", () => {
    const ws = makeWorkspace();
    seedProduct(ws, { sku: "SKU-1-1-012", id: 12, status: "ready", withNear: true });
    seedProduct(ws, { sku: "SKU-1-1-015", id: 15, status: "draft", withNear: true });
    seedProduct(ws, { sku: "SKU-1-1-043", id: 43, status: "ready", withNear: false });

    const input = defaultCatalogInput({
      catalog_id: "demo-three-sku",
      product_ids: [12, 15, 43, 99],
      market: "CH",
      locale: "en",
    });
    const snapshot = resolveCatalog(ws, input);
    assert.equal(snapshot.pages.length, 1);
    assert.equal(snapshot.pages[0]?.product_id, 12);
    assert.equal(snapshot.pages[0]?.display_name, "SKU-1-1-012-en");
    assert.equal(snapshot.pages[0]?.category, "耳环");
    assert.ok(snapshot.pages[0]?.images.near);
    assert.equal(snapshot.pages[0]?.price.currency, "CHF");
    assert.equal(snapshot.pages[0]?.price.amount, 29);

    const reasons = snapshot.skipped.map((s) => s.reason).sort();
    assert.deepEqual(reasons, ["missing_image", "not_found", "not_ready"]);
  });

  it("hides price when policy is hide", () => {
    const ws = makeWorkspace();
    seedProduct(ws, { sku: "SKU-1-1-007", id: 7, listPrice: 10, market: "CH" });
    const input = defaultCatalogInput({
      catalog_id: "price-hide",
      product_ids: [7],
      market: "CH",
    });
    input.price_policy.mode = "hide";
    const snapshot = resolveCatalog(ws, input);
    assert.equal(snapshot.pages[0]?.price.display, null);
    assert.equal(snapshot.pages[0]?.price.policy, "hide");
  });

  it("uses inquiry display when mode is inquiry", () => {
    const ws = makeWorkspace();
    seedProduct(ws, { sku: "SKU-1-1-008", id: 8, listPrice: 10, market: "CH" });
    const input = defaultCatalogInput({
      catalog_id: "price-inquiry",
      product_ids: [8],
      market: "CH",
    });
    input.price_policy.mode = "inquiry";
    input.price_policy.label = "Ask us";
    const snapshot = resolveCatalog(ws, input);
    assert.equal(snapshot.pages[0]?.price.display, "Ask us");
  });

  it("batch mode collects products from one batch", () => {
    const ws = makeWorkspace();
    seedProduct(ws, { sku: "SKU-1-1-001", id: 1 });
    seedProduct(ws, { sku: "SKU-1-1-002", id: 2 });
    const input = defaultCatalogInput({
      catalog_id: "batch-mode",
      mode: "batch",
      batch: "batch-a",
      market: "CH",
    });
    const snapshot = resolveCatalog(ws, input);
    assert.equal(snapshot.pages.length, 2);
  });

  it("external mode dynamically selects products allowed for external use", () => {
    const ws = makeWorkspace();
    seedProduct(ws, { sku: "SKU-1-1-001", id: 1, include: true });
    seedProduct(ws, { sku: "SKU-1-1-002", id: 2, include: false });
    const input = defaultCatalogInput({
      catalog_id: "external-products",
      mode: "external",
      market: "CH",
    });
    const snapshot = resolveCatalog(ws, input);

    assert.deepEqual(snapshot.pages.map((page) => page.product_id), [1]);
  });
});

describe("renderCatalogHtml", () => {
  it("renders cover + product + contact and escapes HTML", () => {
    const ws = makeWorkspace();
    seedProduct(ws, {
      sku: "SKU-1-1-012",
      id: 12,
      market: "CH",
    });
    const productPath = path.join(ws, "产品管理", "产品库", "SKU-1-1-012");
    // rewrite name with special chars in meta
    const metaPath = path.join(productPath, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
    meta.name = 'Leaf <script>x</script>';
    meta.name_en = 'Leaf <b>EN</b>';
    (meta.copy as { selling_points: string[] }).selling_points = ['Safe & "sound"'];
    writeJsonFile(metaPath, meta);

    const input = defaultCatalogInput({
      catalog_id: "render-demo",
      product_ids: [12],
      market: "CH",
      locale: "en",
    });
    const snapshot = resolveCatalog(ws, input);
    const htmlPath = path.join(ws, "work", "render.html");
    const result = renderCatalogHtml(ws, snapshot, htmlPath);
    assert.equal(result.pageCount, 3);
    const html = fs.readFileSync(htmlPath, "utf-8");
    assert.match(html, /Leaf &lt;b&gt;EN&lt;\/b&gt;/);
    assert.match(html, /Safe &amp; &quot;sound&quot;/);
    assert.doesNotMatch(html, /<b>EN<\/b>/);
    assert.ok(fs.existsSync(path.join(ws, "work", "assets")));
  });
});

describe("runCatalog", () => {
  it("writes snapshot html output and is hash-stable for same input", () => {
    const ws = makeWorkspace();
    seedProduct(ws, { sku: "SKU-1-1-012", id: 12, market: "CH" });
    const input = defaultCatalogInput({
      catalog_id: "run-demo",
      product_ids: [12],
      market: "CH",
    });
    const first = runCatalog({
      workspaceRoot: ws,
      input,
      skipPdf: true,
    });
    assert.ok(fs.existsSync(first.htmlPath));
    assert.ok(fs.existsSync(first.snapshotPath));
    assert.ok(fs.existsSync(first.outputPath));
    assert.equal(first.pdfPath, null);

    const html1 = fs.readFileSync(first.htmlPath, "utf-8");
    const snap1 = JSON.parse(fs.readFileSync(first.snapshotPath, "utf-8")) as {
      from_input_sha256: string;
      pages: unknown[];
    };
    assert.equal(snap1.from_input_sha256, sha256Json(input));

    const second = runCatalog({
      workspaceRoot: ws,
      input,
      skipPdf: true,
    });
    const html2 = fs.readFileSync(second.htmlPath, "utf-8");
    // drop frozen_at differences by comparing structural product content
    const snap2 = JSON.parse(fs.readFileSync(second.snapshotPath, "utf-8")) as {
      pages: unknown[];
    };
    assert.equal(JSON.stringify(snap1.pages), JSON.stringify(snap2.pages));
    assert.equal(html1.replace(/assets\/[a-f0-9]+/g, "assets/HASH"), html2.replace(/assets\/[a-f0-9]+/g, "assets/HASH"));
  });

  it("exits path with code semantics when nothing included", () => {
    const ws = makeWorkspace();
    seedProduct(ws, { sku: "SKU-1-1-001", id: 1, status: "draft" });
    const input = defaultCatalogInput({
      catalog_id: "empty-run",
      product_ids: [1],
      market: "CH",
    });
    assert.throws(
      () => runCatalog({ workspaceRoot: ws, input, skipPdf: true }),
      (err: Error & { exitCode?: number }) => err.exitCode === 3,
    );
  });
});
