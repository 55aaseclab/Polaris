import { NextResponse } from "next/server";
import {
  createProduct,
  listProducts,
  nextProductSku,
  normalizeSkuSubcategory,
  PRODUCT_SKU_SUBCATEGORIES,
} from "@polaris/business-core/products";
import {
  mutateWorkspace,
  readJsonObject,
  requestError,
  workspaceMutationJson,
  workspaceFromContext,
  type RouteContext,
} from "../../../_lib";
import { productDetail, productSummary } from "./_product";

function optionalText(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function inventory(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return 1;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0) {
    throw new Error("Inventory must be a non-negative integer");
  }
  return result;
}

function money(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return result;
}

export async function GET(_request: Request, context: RouteContext<{ workspace: string }>) {
  try {
    const { root } = await workspaceFromContext(context);
    const nextSkus = Object.fromEntries(
      Object.keys(PRODUCT_SKU_SUBCATEGORIES).map((subcategory) => [
        subcategory,
        nextProductSku(root, normalizeSkuSubcategory(subcategory)),
      ]),
    );
    return NextResponse.json({ next_skus: nextSkus, products: listProducts(root).map(productSummary) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

export async function POST(request: Request, context: RouteContext<{ workspace: string }>) {
  try {
    const { name, root } = await workspaceFromContext(context);
    const payload = await readJsonObject(request);
    const skuSubcategory = normalizeSkuSubcategory(payload.sku_subcategory);
    const mutation = await mutateWorkspace({
      request,
      workspace: name,
      workspaceRoot: root,
      mutate: () => {
        const defaultMarket = optionalText(payload.default_market) ?? "CN";
        const market = optionalText(payload.market) ?? defaultMarket;
        const currency = optionalText(payload.currency) ?? "CNY";
        return createProduct(root, {
          defaultMarket,
          description: optionalText(payload.description),
          includeInExternal: payload.include_in_external !== false,
          inventory: inventory(payload.inventory),
          name: optionalText(payload.name),
          nameEn: optionalText(payload.name_en),
          pricing: {
            costCurrency: optionalText(payload.cost_currency) ?? currency,
            currency,
            floorPrice: money(payload.floor_price, "Floor price"),
            laborPrice: money(payload.labor_price, "Labor price"),
            listPrice: money(payload.list_price, "List price"),
            market,
            packagingPrice: money(payload.packaging_price, "Packaging price"),
            promoPrice: money(payload.promo_price, "Promotional price"),
            purchasePrice: money(payload.purchase_price, "Purchase price"),
          },
          sku: nextProductSku(root, skuSubcategory),
          skuSubcategory,
        });
      },
    });
    return workspaceMutationJson(
      { product: productDetail(mutation.result) },
      mutation.workspaceVersion,
      { status: 201 },
    );
  } catch (error) {
    return requestError(error);
  }
}
