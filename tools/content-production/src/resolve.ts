import fs from "node:fs";
import path from "node:path";
import {
  findProductById,
  isJsonObject,
  listProducts,
  productOrigin,
  productImageSlots,
  skuSubcategoryFromSku,
  skuSubcategoryLabel,
  type JsonObject,
  type ProductSummary,
} from "@polaris/business-core";
import { sha256File, sha256Json, sha256Text } from "./hash.js";
import {
  assertSafeWorkspaceRelative,
  resolveUnderWorkspace,
  utcNow,
} from "./paths.js";
import {
  CatalogError,
  type CatalogInput,
  type CatalogSnapshot,
  type ImageRef,
  type ImageSlot,
  type SnapshotPage,
  type SkippedProduct,
} from "./types.js";

function asObject(value: unknown): JsonObject {
  return isJsonObject(value as JsonObject) ? (value as JsonObject) : {};
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function uniqueSortedIds(ids: number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isInteger(id)))].sort((a, b) => a - b);
}

function collectRequestedIds(workspaceRoot: string, input: CatalogInput): number[] {
  if (input.selection.mode === "explicit") {
    return uniqueSortedIds(input.selection.product_ids);
  }
  if (input.selection.mode === "external") {
    return uniqueSortedIds(
      listProducts(workspaceRoot)
        .filter((product) => product.meta.include_in_external === true)
        .map((product) => (typeof product.meta.id === "number" ? product.meta.id : null))
        .filter((id): id is number => id !== null),
    );
  }
  const batch = input.selection.batch;
  if (!batch) {
    throw new CatalogError("selection.batch is required for mode=batch", 2);
  }
  const products = listProducts(workspaceRoot).filter(
    (product) => productOrigin(product)?.batch === batch,
  );
  return uniqueSortedIds(
    products
      .map((p) => (typeof p.meta.id === "number" ? p.meta.id : null))
      .filter((id): id is number => id !== null),
  );
}

function resolveImageRef(
  workspaceRoot: string,
  relativePath: string | null,
  label: string,
): ImageRef {
  if (!relativePath) return null;
  const safe = assertSafeWorkspaceRelative(relativePath, label);
  const absolute = resolveUnderWorkspace(workspaceRoot, safe, label);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new CatalogError(`${label}: image file missing: ${safe}`, 1);
  }
  return { path: safe, sha256: sha256File(absolute) };
}

function marketPrice(
  meta: JsonObject,
  market: string,
  mode: CatalogInput["price_policy"]["mode"],
  showCurrency: boolean,
  hideIfNull: boolean,
  label: string | null,
): SnapshotPage["price"] {
  if (mode === "hide") {
    return { currency: null, amount: null, display: null, policy: "hide" };
  }
  if (mode === "inquiry") {
    return {
      currency: null,
      amount: null,
      display: label?.trim() || "Inquiry",
      policy: "inquiry",
    };
  }
  const pricing = asObject(meta.pricing);
  const markets = asObject(pricing.markets);
  const row = asObject(markets[market]);
  const currency = stringOrNull(row.currency);
  const amount =
    mode === "promo_price"
      ? numberOrNull(row.promo_price) ?? numberOrNull(row.list_price)
      : numberOrNull(row.list_price);
  if (amount === null) {
    if (hideIfNull) {
      return { currency, amount: null, display: null, policy: mode };
    }
    return {
      currency,
      amount: null,
      display: label?.trim() || "Inquiry",
      policy: mode,
    };
  }
  const amountText = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  const display = showCurrency && currency ? `${currency} ${amountText}` : amountText;
  return { currency, amount, display, policy: mode };
}

function projectPage(
  workspaceRoot: string,
  product: ProductSummary,
  input: CatalogInput,
): SnapshotPage | SkippedProduct {
  const meta = product.meta;
  const productId = typeof meta.id === "number" ? meta.id : null;
  if (productId === null) {
    return { product_id: null, reason: "missing_product_id", detail: product.sku };
  }

  if (input.options.require_ready && meta.status !== "ready") {
    return {
      product_id: productId,
      reason: "not_ready",
      detail: `status=${String(meta.status)}`,
    };
  }
  if (input.options.require_include_in_external && meta.include_in_external === false) {
    return { product_id: productId, reason: "not_external", detail: null };
  }

  const slots = productImageSlots(product);
  const images: Record<ImageSlot, ImageRef> = {
    near: null,
    wear: null,
    detail: null,
  };
  for (const slot of input.options.image_slots_on_page) {
    try {
      images[slot] = resolveImageRef(
        workspaceRoot,
        slots[slot],
        `${product.sku}.${slot}`,
      );
    } catch (error) {
      if (error instanceof CatalogError && error.message.includes("missing")) {
        images[slot] = null;
      } else {
        throw error;
      }
    }
  }
  for (const required of input.options.require_images) {
    if (!images[required]) {
      return {
        product_id: productId,
        reason: "missing_image",
        detail: required,
      };
    }
  }

  const copy = asObject(meta.copy);
  const sellingPoints = Array.isArray(copy.selling_points)
    ? copy.selling_points.map((item) => String(item)).filter(Boolean)
    : [];
  const maxPoints = Math.max(0, input.options.max_selling_points);
  const packaging = asObject(meta.packaging);
  const normal = asObject(packaging.normal);
  const dimensions = asObject(normal.dimensions_mm);

  const name = stringOrNull(meta.name) ?? product.sku;
  const nameEn = stringOrNull(meta.name_en);
  const displayName =
    input.locale === "en" ? nameEn || name : name;

  return {
    kind: "product",
    product_id: productId,
    slug: product.sku,
    batch: productOrigin(product)?.batch ?? "product-library",
    display_name: displayName,
    name_en: nameEn,
    category: skuSubcategoryLabel(skuSubcategoryFromSku(product.sku)),
    copy: {
      title: stringOrNull(copy.title),
      selling_points: sellingPoints.slice(0, maxPoints),
      description: stringOrNull(copy.description),
    },
    specs: {
      dimensions_mm: {
        length: numberOrNull(dimensions.length),
        width: numberOrNull(dimensions.width),
        height: numberOrNull(dimensions.height),
      },
      weight_with_packaging_kg: numberOrNull(normal.weight_with_packaging_kg),
      packaging_mode: "normal",
    },
    images,
    price: marketPrice(
      meta,
      input.market,
      input.price_policy.mode,
      input.price_policy.show_currency,
      input.price_policy.hide_if_null,
      input.price_policy.label,
    ),
    source_meta_sha256: sha256File(product.metaPath),
  };
}

export function resolveCatalog(
  workspaceRoot: string,
  input: CatalogInput,
): CatalogSnapshot {
  if (input.brand.logo_path) {
    assertSafeWorkspaceRelative(input.brand.logo_path, "brand.logo_path");
    const logoAbs = resolveUnderWorkspace(
      workspaceRoot,
      input.brand.logo_path,
      "brand.logo_path",
    );
    if (!fs.existsSync(logoAbs)) {
      throw new CatalogError(`brand.logo_path missing: ${input.brand.logo_path}`, 2);
    }
  }

  const requestedIds = collectRequestedIds(workspaceRoot, input);
  const pages: SnapshotPage[] = [];
  const skipped: SkippedProduct[] = [];

  for (const productId of requestedIds) {
    const product = findProductById(workspaceRoot, productId);
    if (!product) {
      skipped.push({ product_id: productId, reason: "not_found", detail: null });
      continue;
    }
    const result = projectPage(workspaceRoot, product, input);
    if ("reason" in result) {
      skipped.push(result);
    } else {
      pages.push(result);
    }
  }

  const inputSha = sha256Json(input);
  return {
    schema: "wanghai.promo.catalog-snapshot",
    schema_version: 1,
    catalog_id: input.catalog_id,
    frozen_at: utcNow(),
    from_input_sha256: inputSha,
    template_id: input.template_id,
    locale: input.locale,
    market: input.market,
    page_size: input.page_size,
    orientation: input.orientation,
    cover: {
      title: input.title,
      subtitle: input.subtitle,
    },
    brand: {
      name: input.brand.name,
      tagline: input.brand.tagline,
      logo_path: input.brand.logo_path,
      contact_lines: [...input.brand.contact_lines],
    },
    include_sections: { ...input.include_sections },
    price_policy: { ...input.price_policy },
    pages,
    skipped,
  };
}

export function defaultCatalogInput(partial: {
  catalog_id: string;
  title?: string;
  product_ids?: number[];
  batch?: string | null;
  mode?: CatalogInput["selection"]["mode"];
  locale?: CatalogInput["locale"];
  market?: string;
  brand_name?: string;
  contact_lines?: string[];
}): CatalogInput {
  const mode = partial.mode ?? (partial.batch && !partial.product_ids?.length ? "batch" : "explicit");
  return {
    schema: "wanghai.promo.catalog-input",
    schema_version: 1,
    catalog_id: partial.catalog_id,
    title: partial.title ?? partial.catalog_id,
    subtitle: null,
    locale: partial.locale ?? "en",
    market: partial.market ?? "CN",
    template_id: "single-product-page.v1",
    page_size: "A4",
    orientation: "portrait",
    selection: {
      mode,
      product_ids: partial.product_ids ?? [],
      batch: partial.batch ?? null,
      filters: null,
    },
    price_policy: {
      mode: "list_price",
      show_currency: true,
      hide_if_null: true,
      label: "List price",
    },
    include_sections: {
      cover: true,
      toc: false,
      brand_intro: false,
      product_pages: true,
      packaging: false,
      contact: true,
    },
    brand: {
      name: partial.brand_name ?? "Demo Brand",
      tagline: null,
      logo_path: null,
      contact_lines: partial.contact_lines ?? ["sales@example.com"],
    },
    options: {
      require_ready: true,
      require_include_in_external: true,
      require_images: ["near"],
      max_selling_points: 5,
      image_slots_on_page: ["near", "wear", "detail"],
    },
    notes: [],
  };
}

/** Exported for tests: hash of canonical empty skip detail */
export function emptyDetailHash(): string {
  return sha256Text("");
}

export function workspaceProductMetaExists(workspaceRoot: string, productId: number): boolean {
  return findProductById(workspaceRoot, productId) !== null;
}

export function productDir(product: ProductSummary): string {
  return path.dirname(product.metaPath);
}
