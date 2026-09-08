import { NextResponse } from "next/server";
import { type JsonObject } from "@polaris/business-core/json";
import { findProductBySku } from "@polaris/business-core/products";
import {
  defaultOrderMeta,
  ensureOrderDirs,
  listOrders,
  readOrderMeta,
  validateOrderIdentifier,
  writeOrderMeta,
} from "@polaris/business-core/operations";
import {
  mutateWorkspace,
  readJsonObject,
  requestError,
  workspaceFromContext,
  workspaceMutationJson,
  type RouteContext,
} from "../../../_lib";

function requiredText(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function positiveQuantity(value: unknown): number {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity < 1) {
    throw new Error("Quantity must be at least 1");
  }
  return quantity;
}

function nonNegativeAmount(value: unknown): number {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
    throw new Error("Amount is required");
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Amount must be a non-negative number");
  }
  return amount;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function GET(_request: Request, context: RouteContext<{ workspace: string }>) {
  try {
    const { root } = await workspaceFromContext(context);
    return NextResponse.json({ orders: listOrders(root) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function POST(request: Request, context: RouteContext<{ workspace: string }>) {
  try {
    const { name, root } = await workspaceFromContext(context);
    const payload = await readJsonObject(request);
    const orderNo = validateOrderIdentifier(requiredText(payload.order_no, "Order number"));
    const customer = requiredText(payload.customer, "Customer");
    const sku = requiredText(payload.sku, "SKU");
    const quantity = positiveQuantity(payload.quantity);
    const amount = nonNegativeAmount(payload.amount);
    const product = findProductBySku(root, sku);
    if (!product) throw new Error(`Product not found: ${sku}`);

    const mutation = await mutateWorkspace({
      request,
      workspace: name,
      workspaceRoot: root,
      mutate: () => {
        if (readOrderMeta(root, orderNo)) throw new Error(`Order already exists: ${orderNo}`);
        ensureOrderDirs(root, orderNo);
        const next = defaultOrderMeta(orderNo) as Record<string, unknown>;
        next.customer = { ...asRecord(next.customer), name: customer };
        next.lines = [{
          product_id: typeof product.meta.id === "number" ? product.meta.id : product.sku,
          quantity,
        }];
        next.totals = {
          ...asRecord(next.totals),
          customer_payable: amount,
          items_subtotal: amount,
        };
        return writeOrderMeta(root, orderNo, next as JsonObject);
      },
    });
    return workspaceMutationJson({ order: mutation.result }, mutation.workspaceVersion, { status: 201 });
  } catch (error) {
    return requestError(error);
  }
}
