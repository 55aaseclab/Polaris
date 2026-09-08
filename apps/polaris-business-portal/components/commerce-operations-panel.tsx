"use client";

import {
  AlertCircle,
  ArrowLeft,
  LoaderCircle,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  ShoppingCart,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useI18n } from "@/components/i18n-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { OrderDetailEditor } from "@/components/order-detail-editor";
import { wanghaiMutationFetch } from "@/lib/mutation-request";
import { resolveSelectedOrderNo } from "@/lib/order-management-navigation";

type WorkflowView = "products" | "orders";
type ProductFilter = "all" | "draft" | "review" | "ready";
type ProductStatusValue = "draft" | "review" | "ready";

type OrderSummary = {
  amount: number | null;
  currency: string;
  customer: string | null;
  order_date: string | null;
  order_no: string;
  process_status: string;
  status: string;
  validation_error: string | null;
};

type ProductSummary = {
  asset_count: number;
  description: string | null;
  id: number;
  inventory: number | null;
  name: string | null;
  name_en: string | null;
  pricing: {
    cost_currency: string;
    currency: string;
    default_market: string;
    floor_price: number | null;
    labor_price: number | null;
    list_price: number | null;
    market?: string;
    markets?: Record<string, { currency?: string; floor_price?: number | null; list_price?: number | null; promo_price?: number | null }>;
    packaging_price: number | null;
    promo_price: number | null;
    purchase_price: number | null;
  };
  sku: string;
  sku_subcategory_label?: string;
  status: string | null;
  thumbnail: string | null;
};

type CreateProductDraft = {
  costCurrency: string;
  currency: string;
  defaultMarket: string;
  description: string;
  floorPrice: string;
  inventory: string;
  laborPrice: string;
  listPrice: string;
  market: string;
  name: string;
  nameEn: string;
  packagingPrice: string;
  promoPrice: string;
  purchasePrice: string;
  skuSubcategory: string;
};

type UpdateProductDraft = {
  defaultMarket: string;
  description: string;
  inventory: string;
  name: string;
  nameEn: string;
  status: ProductStatusValue;
};

type CreateOrderDraft = {
  amount: string;
  customer: string;
  orderNo: string;
  quantity: string;
  sku: string;
};

const SKU_SUBCATEGORY_OPTIONS = [
  { label: "耳环", value: "earrings" },
  { label: "项链", value: "necklaces" },
  { label: "发夹", value: "hair_clips" },
  { label: "发簪", value: "hairpins" },
  { label: "头绳", value: "hair_ties" },
  { label: "摆件", value: "ornaments" },
  { label: "葫芦", value: "gourds" },
  { label: "挂坠", value: "pendants" },
  { label: "养生锤", value: "health_hammers" },
  { label: "测试产品", value: "test_products" },
] as const;

const PRODUCT_STATUS_OPTIONS: Array<{ label: string; value: ProductStatusValue }> = [
  { label: "草稿", value: "draft" },
  { label: "待审核", value: "review" },
  { label: "已就绪", value: "ready" },
];

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await wanghaiMutationFetch(url, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof body?.error === "string" ? body.error : `请求失败：${response.status}`);
  }
  return body as T;
}

function formatMoney(amount: number | null, currency: string, locale: string): string {
  if (amount === null) return "—";
  return `${currency} ${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(amount)}`;
}

function productPrice(product: ProductSummary, locale: string): string {
  const { pricing } = product;
  return formatMoney(
    pricing.promo_price ?? pricing.list_price ?? pricing.floor_price,
    pricing.currency,
    locale,
  );
}

function orderStatusLabel(order: OrderSummary): string {
  if (order.process_status) return order.process_status;
  const labels: Record<string, string> = {
    cancelled: "已取消",
    completed: "已完成",
    confirmed: "已确认",
    draft: "草稿",
  };
  return labels[order.status] ?? order.status;
}

function productStatusLabel(product: ProductSummary): string {
  const labels: Record<string, string> = {
    draft: "草稿",
    review: "待审核",
    ready: "已就绪",
  };
  return labels[product.status ?? ""] ?? product.status ?? "未设置";
}

function numberOrNull(value: string): number | null {
  if (!value.trim()) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function newOrderNumber(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `ORD-${stamp}`;
}

function SummaryStat({ detail, label, value }: { detail: string; label: string; value: number }) {
  return (
    <div className="border bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function ResultHeader({
  action,
  filter,
  label,
  onRefresh,
  query,
  setQuery,
}: {
  action?: {
    icon: ReactNode;
    label: string;
    onClick: () => void;
  };
  filter?: {
    ariaLabel: string;
    onChange: (value: string) => void;
    options: Array<{ label: string; value: string }>;
    value: string;
  };
  label: string;
  onRefresh: () => void;
  query: string;
  setQuery: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 md:px-5">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">当前{label}</h2>
      </div>
      <div className="flex items-center gap-2">
        {action ? (
          <Button onClick={action.onClick} size="sm" type="button">
            {action.icon}
            {action.label}
          </Button>
        ) : null}
        {filter ? (
          <div className="shrink-0">
            <Select value={filter.value} onValueChange={filter.onChange}>
              <SelectTrigger aria-label={filter.ariaLabel} className="h-8 w-36 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {filter.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <Input
          aria-label={`搜索${label}`}
          className="h-8 w-48 text-sm"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`搜索${label}`}
          type="search"
          value={query}
        />
        <Button aria-label="刷新" onClick={onRefresh} size="icon" title="刷新" type="button" variant="ghost">
          <RefreshCw className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

export function OrderResults({
  locale,
  onOpenOrder,
  orders,
}: {
  locale: string;
  onOpenOrder: (orderNo: string) => void;
  orders: OrderSummary[];
}) {
  if (orders.length === 0) {
    return <p className="p-5 text-sm text-muted-foreground">当前没有订单。</p>;
  }

  return (
    <div className="divide-y">
      {orders.map((order) => (
        <button
          aria-label={`打开订单 ${order.order_no}`}
          className="grid w-full gap-3 px-4 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center md:px-5"
          key={order.order_no}
          onClick={() => onOpenOrder(order.order_no)}
          type="button"
        >
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-medium">{order.order_no}</span>
              <Badge variant={order.status === "completed" ? "secondary" : "outline"}>{orderStatusLabel(order)}</Badge>
            </span>
            <span className="mt-1 block truncate text-sm">{order.customer ?? "未填写客户"}</span>
            {order.validation_error ? <span className="mt-1 block truncate text-xs text-destructive">{order.validation_error}</span> : null}
          </span>
          <span className="text-sm text-muted-foreground md:text-right">
            <span className="block">{order.order_date ?? "未填写日期"}</span>
            <span className="mt-1 block font-medium text-foreground tabular-nums">{formatMoney(order.amount, order.currency, locale)}</span>
          </span>
          <ShoppingCart className="hidden size-4 text-muted-foreground md:block" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

function ProductResults({
  editLabel,
  locale,
  onEdit,
  products,
}: {
  editLabel: string;
  locale: string;
  onEdit: (product: ProductSummary) => void;
  products: ProductSummary[];
}) {
  if (products.length === 0) {
    return <p className="p-5 text-sm text-muted-foreground">当前没有产品。</p>;
  }

  return (
    <div className="divide-y">
      {products.map((product) => (
        <article className="grid gap-3 px-4 py-4 md:grid-cols-[minmax(0,1fr)_8rem_8rem_auto_auto] md:items-center md:px-5" key={product.sku}>
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted">
              <Package className="size-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{product.name ?? "未命名产品"}</p>
              <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{product.sku}</p>
            </div>
          </div>
          <div className="text-sm md:text-right">
            <p className="text-xs text-muted-foreground">库存</p>
            <p className="mt-1 tabular-nums">{product.inventory ?? "—"}</p>
          </div>
          <div className="text-sm md:text-right">
            <p className="text-xs text-muted-foreground">价格</p>
            <p className="mt-1 tabular-nums">{productPrice(product, locale)}</p>
          </div>
          <Badge className="w-fit" variant={product.status === "ready" ? "secondary" : "outline"}>
            {productStatusLabel(product)}
          </Badge>
          <Button
            aria-label={`${editLabel} ${product.sku}`}
            onClick={() => onEdit(product)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Pencil className="size-3.5" aria-hidden="true" />
            {editLabel}
          </Button>
        </article>
      ))}
    </div>
  );
}

function ProductDialog({
  createDraft,
  editDraft,
  editSku,
  mode,
  onCreateDraftChange,
  onEditDraftChange,
  onOpenChange,
  onSubmit,
  open,
  saving,
  submitLabel,
}: {
  createDraft: CreateProductDraft;
  editDraft: UpdateProductDraft | null;
  editSku: string | null;
  mode: "create" | "update";
  onCreateDraftChange: (draft: CreateProductDraft) => void;
  onEditDraftChange: (draft: UpdateProductDraft) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
  open: boolean;
  saving: boolean;
  submitLabel: string;
}) {
  const isCreate = mode === "create";

  function patchCreate<Key extends keyof CreateProductDraft>(key: Key, value: CreateProductDraft[Key]) {
    onCreateDraftChange({ ...createDraft, [key]: value });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{submitLabel}</DialogTitle>
          {editSku ? <DialogDescription>{editSku}</DialogDescription> : null}
        </DialogHeader>
        {isCreate ? (
          <FieldGroup>
            <Field>
              <FieldLabel>SKU 子类</FieldLabel>
              <Select
                value={createDraft.skuSubcategory}
                onValueChange={(value) => onCreateDraftChange({ ...createDraft, skuSubcategory: value })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SKU_SUBCATEGORY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>产品名称</FieldLabel>
                <Input autoFocus onChange={(event) => patchCreate("name", event.target.value)} value={createDraft.name} />
              </Field>
              <Field>
                <FieldLabel>英文名称</FieldLabel>
                <Input onChange={(event) => patchCreate("nameEn", event.target.value)} value={createDraft.nameEn} />
              </Field>
              <Field>
                <FieldLabel>库存</FieldLabel>
                <Input inputMode="numeric" min="0" onChange={(event) => patchCreate("inventory", event.target.value)} type="number" value={createDraft.inventory} />
              </Field>
              <Field>
                <FieldLabel>默认市场</FieldLabel>
                <Input onChange={(event) => patchCreate("defaultMarket", event.target.value.toUpperCase())} value={createDraft.defaultMarket} />
              </Field>
            </div>
            <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>价格市场</FieldLabel>
                <Input onChange={(event) => patchCreate("market", event.target.value.toUpperCase())} value={createDraft.market} />
              </Field>
              <Field>
                <FieldLabel>销售币种</FieldLabel>
                <Input onChange={(event) => patchCreate("currency", event.target.value.toUpperCase())} value={createDraft.currency} />
              </Field>
              <Field>
                <FieldLabel>标价</FieldLabel>
                <Input inputMode="decimal" min="0" onChange={(event) => patchCreate("listPrice", event.target.value)} step="0.01" type="number" value={createDraft.listPrice} />
              </Field>
              <Field>
                <FieldLabel>促销价</FieldLabel>
                <Input inputMode="decimal" min="0" onChange={(event) => patchCreate("promoPrice", event.target.value)} step="0.01" type="number" value={createDraft.promoPrice} />
              </Field>
              <Field>
                <FieldLabel>最低价</FieldLabel>
                <Input inputMode="decimal" min="0" onChange={(event) => patchCreate("floorPrice", event.target.value)} step="0.01" type="number" value={createDraft.floorPrice} />
              </Field>
            </div>
            <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>成本币种</FieldLabel>
                <Input onChange={(event) => patchCreate("costCurrency", event.target.value.toUpperCase())} value={createDraft.costCurrency} />
              </Field>
              <Field>
                <FieldLabel>采购成本</FieldLabel>
                <Input inputMode="decimal" min="0" onChange={(event) => patchCreate("purchasePrice", event.target.value)} step="0.01" type="number" value={createDraft.purchasePrice} />
              </Field>
              <Field>
                <FieldLabel>包装成本</FieldLabel>
                <Input inputMode="decimal" min="0" onChange={(event) => patchCreate("packagingPrice", event.target.value)} step="0.01" type="number" value={createDraft.packagingPrice} />
              </Field>
              <Field>
                <FieldLabel>人工成本</FieldLabel>
                <Input inputMode="decimal" min="0" onChange={(event) => patchCreate("laborPrice", event.target.value)} step="0.01" type="number" value={createDraft.laborPrice} />
              </Field>
            </div>
            <Field>
              <FieldLabel>产品描述</FieldLabel>
              <Textarea onChange={(event) => patchCreate("description", event.target.value)} value={createDraft.description} />
            </Field>
          </FieldGroup>
        ) : editDraft ? (
          <FieldGroup>
            <Field>
              <FieldLabel>SKU</FieldLabel>
              <Input disabled value={editSku ?? ""} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>产品名称</FieldLabel>
                <Input
                  onChange={(event) => onEditDraftChange({ ...editDraft, name: event.target.value })}
                  value={editDraft.name}
                />
              </Field>
              <Field>
                <FieldLabel>英文名称</FieldLabel>
                <Input
                  onChange={(event) => onEditDraftChange({ ...editDraft, nameEn: event.target.value })}
                  value={editDraft.nameEn}
                />
              </Field>
              <Field>
                <FieldLabel>状态</FieldLabel>
                <Select
                  value={editDraft.status}
                  onValueChange={(value) => onEditDraftChange({ ...editDraft, status: value as ProductStatusValue })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRODUCT_STATUS_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>库存</FieldLabel>
                <Input
                  inputMode="numeric"
                  min="0"
                  onChange={(event) => onEditDraftChange({ ...editDraft, inventory: event.target.value })}
                  type="number"
                  value={editDraft.inventory}
                />
              </Field>
              <Field>
                <FieldLabel>默认市场</FieldLabel>
                <Input
                  onChange={(event) => onEditDraftChange({ ...editDraft, defaultMarket: event.target.value.toUpperCase() })}
                  value={editDraft.defaultMarket}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel>产品描述</FieldLabel>
              <Textarea
                onChange={(event) => onEditDraftChange({ ...editDraft, description: event.target.value })}
                value={editDraft.description}
              />
            </Field>
          </FieldGroup>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button disabled={saving} onClick={() => onOpenChange(false)} type="button" variant="outline">取消</Button>
          <Button
            disabled={saving || (isCreate && (!createDraft.name.trim() || !createDraft.defaultMarket.trim() || !createDraft.market.trim() || !createDraft.currency.trim()))}
            onClick={onSubmit}
            type="button"
          >
            {isCreate ? <Plus className="size-4" aria-hidden="true" /> : <Pencil className="size-4" aria-hidden="true" />}
            {saving ? "保存中…" : submitLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OrderDialog({
  draft,
  onDraftChange,
  onOpenChange,
  onSubmit,
  open,
  products,
  saving,
  submitLabel,
}: {
  draft: CreateOrderDraft;
  onDraftChange: (draft: CreateOrderDraft) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
  open: boolean;
  products: ProductSummary[];
  saving: boolean;
  submitLabel: string;
}) {
  const canSubmit = Boolean(
    draft.orderNo.trim()
      && draft.customer.trim()
      && draft.sku
      && numberOrNull(draft.quantity) !== null
      && Number(draft.quantity) >= 1
      && numberOrNull(draft.amount) !== null
      && Number(draft.amount) >= 0,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{submitLabel}</DialogTitle>
          <DialogDescription>创建后进入待审批状态</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>订单号</FieldLabel>
              <Input autoFocus onChange={(event) => onDraftChange({ ...draft, orderNo: event.target.value })} value={draft.orderNo} />
            </Field>
            <Field>
              <FieldLabel>客户</FieldLabel>
              <Input onChange={(event) => onDraftChange({ ...draft, customer: event.target.value })} value={draft.customer} />
            </Field>
            <Field>
              <FieldLabel>SKU</FieldLabel>
              <Select value={draft.sku || undefined} onValueChange={(value) => onDraftChange({ ...draft, sku: value })}>
                <SelectTrigger aria-label="选择产品 SKU" disabled={products.length === 0}>
                  <SelectValue placeholder={products.length === 0 ? "暂无产品" : "选择产品"} />
                </SelectTrigger>
                <SelectContent>
                  {products.map((product) => (
                    <SelectItem key={product.sku} value={product.sku}>
                      {product.sku} · {product.name ?? "未命名产品"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>数量</FieldLabel>
              <Input inputMode="numeric" min="1" onChange={(event) => onDraftChange({ ...draft, quantity: event.target.value })} type="number" value={draft.quantity} />
            </Field>
            <Field>
              <FieldLabel>订单金额</FieldLabel>
              <Input inputMode="decimal" min="0" onChange={(event) => onDraftChange({ ...draft, amount: event.target.value })} step="0.01" type="number" value={draft.amount} />
            </Field>
          </div>
        </FieldGroup>
        <div className="flex justify-end gap-2">
          <Button disabled={saving} onClick={() => onOpenChange(false)} type="button" variant="outline">取消</Button>
          <Button disabled={saving || !canSubmit} onClick={onSubmit} type="button">
            <Plus className="size-4" aria-hidden="true" />
            {saving ? "保存中…" : submitLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CommerceOperationsPanel({
  initialOrderNo = null,
  view,
  workspace,
}: {
  initialOrderNo?: string | null;
  view: WorkflowView;
  workspace: string;
}) {
  const { locale } = useI18n();
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [query, setQuery] = useState("");
  const [productFilter, setProductFilter] = useState<ProductFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateProductDraft>({
    costCurrency: "CNY",
    currency: "CNY",
    defaultMarket: "CN",
    description: "",
    floorPrice: "",
    inventory: "1",
    laborPrice: "",
    listPrice: "",
    market: "CN",
    name: "",
    nameEn: "",
    packagingPrice: "",
    promoPrice: "",
    purchasePrice: "",
    skuSubcategory: "earrings",
  });
  const [createOrderOpen, setCreateOrderOpen] = useState(false);
  const [createOrderDraft, setCreateOrderDraft] = useState<CreateOrderDraft>({
    amount: "",
    customer: "",
    orderNo: newOrderNumber(),
    quantity: "1",
    sku: "",
  });
  const [editingProduct, setEditingProduct] = useState<ProductSummary | null>(null);
  const [editDraft, setEditDraft] = useState<UpdateProductDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedOrderNo, setSelectedOrderNo] = useState<string | null>(initialOrderNo);

  const loadDashboard = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [orderData, productData] = await Promise.all([
        fetchJson<{ orders: OrderSummary[] }>(
          `/api/workspaces/${encodeURIComponent(workspace)}/orders`,
        ),
        fetchJson<{ products: ProductSummary[] }>(
          `/api/workspaces/${encodeURIComponent(workspace)}/products`,
        ),
      ]);
      const nextOrders = orderData.orders ?? [];
      setOrders(nextOrders);
      setSelectedOrderNo((current) => resolveSelectedOrderNo(current, nextOrders));
      const nextProducts = productData.products ?? [];
      setProducts(nextProducts);
      setCreateOrderDraft((current) => ({
        ...current,
        sku: current.sku || nextProducts[0]?.sku || "",
      }));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "数据加载失败");
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  useEffect(() => {
    if (view === "orders") setSelectedOrderNo(initialOrderNo);
    else setSelectedOrderNo(null);
  }, [initialOrderNo, view, workspace]);

  useEffect(() => {
    setQuery("");
    setProductFilter("all");
    void loadDashboard();
  }, [loadDashboard, view]);

  const filteredOrders = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return orders;
    return orders.filter((order) => [
      order.order_no,
      order.customer,
      order.status,
      order.process_status,
      order.order_date,
    ].filter(Boolean).join(" ").toLocaleLowerCase().includes(needle));
  }, [orders, query]);
  const filteredProducts = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const scoped = products.filter((product) => {
      if (productFilter === "draft") return product.status === "draft";
      if (productFilter === "review") return product.status === "review";
      if (productFilter === "ready") return product.status === "ready";
      return true;
    });
    if (!needle) return scoped;
    return scoped.filter((product) => [
      product.sku,
      product.name,
      product.name_en,
      product.sku_subcategory_label,
    ].filter(Boolean).join(" ").toLocaleLowerCase().includes(needle));
  }, [productFilter, products, query]);
  const activeOrders = orders.filter((order) => order.status !== "completed").length;
  const resultLabel = view === "orders" ? "订单" : "产品";

  function openEditProduct(product: ProductSummary) {
    setEditingProduct(product);
    setEditDraft({
      defaultMarket: product.pricing.default_market,
      description: product.description ?? "",
      inventory: product.inventory === null ? "" : String(product.inventory),
      name: product.name ?? "",
      nameEn: product.name_en ?? "",
      status: product.status === "review" || product.status === "ready" ? product.status : "draft",
    });
  }

  async function createProduct() {
    setSaving(true);
    try {
      await fetchJson<{ product: ProductSummary }>(
        `/api/workspaces/${encodeURIComponent(workspace)}/products`,
        {
          body: JSON.stringify({
            cost_currency: createDraft.costCurrency,
            currency: createDraft.currency,
            default_market: createDraft.defaultMarket,
            description: createDraft.description,
            floor_price: numberOrNull(createDraft.floorPrice),
            inventory: createDraft.inventory === "" ? null : Number(createDraft.inventory),
            labor_price: numberOrNull(createDraft.laborPrice),
            list_price: numberOrNull(createDraft.listPrice),
            market: createDraft.market,
            name: createDraft.name,
            name_en: createDraft.nameEn,
            packaging_price: numberOrNull(createDraft.packagingPrice),
            promo_price: numberOrNull(createDraft.promoPrice),
            purchase_price: numberOrNull(createDraft.purchasePrice),
            sku_subcategory: createDraft.skuSubcategory,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      setCreateOpen(false);
      setCreateDraft({
        costCurrency: "CNY",
        currency: "CNY",
        defaultMarket: "CN",
        description: "",
        floorPrice: "",
        inventory: "1",
        laborPrice: "",
        listPrice: "",
        market: "CN",
        name: "",
        nameEn: "",
        packagingPrice: "",
        promoPrice: "",
        purchasePrice: "",
        skuSubcategory: "earrings",
      });
      await loadDashboard();
      toast.success("产品已创建");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建产品失败");
    } finally {
      setSaving(false);
    }
  }

  async function updateProduct() {
    if (!editingProduct || !editDraft) return;
    setSaving(true);
    try {
      await fetchJson<{ product: ProductSummary }>(
        `/api/workspaces/${encodeURIComponent(workspace)}/products/${encodeURIComponent(editingProduct.sku)}`,
        {
          body: JSON.stringify({
            default_market: editDraft.defaultMarket,
            description: editDraft.description,
            inventory: editDraft.inventory === "" ? null : Number(editDraft.inventory),
            name: editDraft.name,
            name_en: editDraft.nameEn,
            status: editDraft.status,
          }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        },
      );
      setEditingProduct(null);
      setEditDraft(null);
      await loadDashboard();
      toast.success("产品已修改");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "修改产品失败");
    } finally {
      setSaving(false);
    }
  }

  async function createOrder() {
    setSaving(true);
    try {
      await fetchJson<{ order: OrderSummary }>(
        `/api/workspaces/${encodeURIComponent(workspace)}/orders`,
        {
          body: JSON.stringify({
            amount: numberOrNull(createOrderDraft.amount),
            customer: createOrderDraft.customer,
            order_no: createOrderDraft.orderNo,
            quantity: numberOrNull(createOrderDraft.quantity),
            sku: createOrderDraft.sku,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      setCreateOrderOpen(false);
      setCreateOrderDraft({
        amount: "",
        customer: "",
        orderNo: newOrderNumber(),
        quantity: "1",
        sku: products[0]?.sku ?? "",
      });
      await loadDashboard();
      toast.success("订单已创建");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建订单失败");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        正在读取当前数据…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="m-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{loadError}</span>
      </div>
    );
  }

  if (view === "orders" && selectedOrderNo) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <header className="flex shrink-0 items-center gap-3 border-b bg-card px-4 py-3 md:px-6">
          <Button
            aria-label="返回订单列表"
            onClick={() => setSelectedOrderNo(null)}
            size="sm"
            type="button"
            variant="outline"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            返回订单列表
          </Button>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">订单详情</p>
            <p className="truncate font-mono text-sm font-medium">{selectedOrderNo}</p>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          <OrderDetailEditor
            onClose={() => setSelectedOrderNo(null)}
            orderNo={selectedOrderNo}
            workspace={workspace}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-7xl space-y-4">
          {view === "orders" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <SummaryStat detail="全部记录" label="订单" value={orders.length} />
              <SummaryStat detail="未归档订单" label="进行中" value={activeOrders} />
            </div>
          ) : null}

          <section className="border bg-card">
            <ResultHeader
              action={view === "products"
                ? {
                    icon: <Plus className="size-4" aria-hidden="true" />,
                    label: "创建产品",
                    onClick: () => setCreateOpen(true),
                  }
                : view === "orders"
                  ? {
                      icon: <Plus className="size-4" aria-hidden="true" />,
                      label: "创建订单",
                      onClick: () => setCreateOrderOpen(true),
                    }
                  : undefined}
              filter={view === "products" ? {
                ariaLabel: "筛选产品状态",
                onChange: (value) => setProductFilter(value as ProductFilter),
                options: [
                  { label: "全部", value: "all" },
                  { label: "草稿", value: "draft" },
                  { label: "待审核", value: "review" },
                  { label: "已就绪", value: "ready" },
                ],
                value: productFilter,
              } : undefined}
              label={resultLabel}
              onRefresh={() => void loadDashboard()}
              query={query}
              setQuery={setQuery}
            />
            {view === "orders" ? (
              <OrderResults
                locale={locale}
                onOpenOrder={setSelectedOrderNo}
                orders={filteredOrders}
              />
            ) : (
              <ProductResults
                editLabel="修改产品"
                locale={locale}
                onEdit={openEditProduct}
                products={filteredProducts}
              />
            )}
          </section>
        </div>
      </main>
      {view === "products" ? (
        <ProductDialog
          createDraft={createDraft}
          editDraft={null}
          editSku={null}
          mode="create"
          onCreateDraftChange={setCreateDraft}
          onEditDraftChange={() => undefined}
          onOpenChange={setCreateOpen}
          onSubmit={() => void createProduct()}
          open={createOpen}
          saving={saving}
          submitLabel="创建产品"
        />
      ) : null}
      {view === "products" ? (
        <ProductDialog
          createDraft={createDraft}
          editDraft={editDraft}
          editSku={editingProduct?.sku ?? null}
          mode="update"
          onCreateDraftChange={setCreateDraft}
          onEditDraftChange={(draft) => setEditDraft(draft)}
          onOpenChange={(open) => {
            if (!open) {
              setEditingProduct(null);
              setEditDraft(null);
            }
          }}
          onSubmit={() => void updateProduct()}
          open={editingProduct !== null}
          saving={saving}
          submitLabel="修改产品"
        />
      ) : null}
      {view === "orders" ? (
        <OrderDialog
          draft={createOrderDraft}
          onDraftChange={setCreateOrderDraft}
          onOpenChange={setCreateOrderOpen}
          onSubmit={() => void createOrder()}
          open={createOrderOpen}
          products={products}
          saving={saving}
          submitLabel="创建订单"
        />
      ) : null}
    </div>
  );
}
