import {
  listProductAssets,
  productImageSlots,
  skuSubcategoryFromSku,
  skuSubcategoryLabel,
  type ProductSummary,
} from "@polaris/business-core/products";

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function productSummary(product: ProductSummary) {
  const meta = product.meta as Record<string, unknown>;
  const copy = asObject(meta.copy);
  const pricing = asObject(meta.pricing);
  const costs = asObject(pricing.costs);
  const markets = asObject(pricing.markets);
  const marketName = typeof pricing.default_market === "string"
    ? pricing.default_market
    : Object.keys(markets)[0] ?? "CN";
  const market = asObject(markets[marketName]);
  const assets = listProductAssets(product);
  const slots = productImageSlots(product);
  const thumbnail = slots.promo_usage_image
    ?? slots.near
    ?? slots.wear
    ?? slots.detail
    ?? assets.find((asset) => asset.kind === "image")?.path
    ?? null;
  const thumbnailAsset = thumbnail
    ? assets.find((asset) => asset.path === thumbnail) ?? null
    : null;
  return {
    asset_count: assets.length,
    id: meta.id,
    inventory: meta.inventory,
    include_in_external: meta.include_in_external === true,
    description: typeof copy.description === "string" ? copy.description : null,
    name: typeof meta.name === "string" ? meta.name : product.sku,
    name_en: typeof meta.name_en === "string" ? meta.name_en : null,
    sku: product.sku,
    sku_category: meta.sku_category,
    sku_subcategory: meta.sku_subcategory,
    sku_subcategory_label: skuSubcategoryLabel(skuSubcategoryFromSku(product.sku)),
    status: meta.status,
    pricing: {
      cost_currency: typeof costs.currency === "string" ? costs.currency : "CNY",
      default_market: marketName,
      currency: typeof market.currency === "string" ? market.currency : "CNY",
      floor_price: typeof market.floor_price === "number" ? market.floor_price : null,
      labor_price: typeof costs.labor_price === "number" ? costs.labor_price : null,
      list_price: typeof market.list_price === "number" ? market.list_price : null,
      market: marketName,
      markets,
      packaging_price: typeof costs.packaging_price === "number" ? costs.packaging_price : null,
      promo_price: typeof market.promo_price === "number" ? market.promo_price : null,
      purchase_price: typeof costs.purchase_price === "number" ? costs.purchase_price : null,
    },
    thumbnail,
    thumbnail_modified_at: thumbnailAsset?.modified_at ?? null,
    thumbnail_size: thumbnailAsset?.size ?? null,
  };
}

export function productDetail(product: ProductSummary) {
  return {
    ...productSummary(product),
    assets: listProductAssets(product),
    image_slots: productImageSlots(product),
    meta: product.meta,
  };
}
