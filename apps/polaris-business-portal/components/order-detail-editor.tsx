"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { wanghaiMutationFetch } from "@/lib/mutation-request";
import { orderDocumentAssetUrl } from "@/lib/order-document-assets";
import { wanghaiPath } from "@/lib/paths";

type WorkspaceResponse = {
  workspaces: { name: string }[];
};

type ProductRow = {
  sku: string;
  id: number | null;
  inventory: number | null;
  name: string;
  sku_subcategory_label: string;
  status: string;
  include_in_external: boolean;
  thumbnail: string | null;
  thumbnail_modified_at?: string | null;
  thumbnail_size?: number | null;
  pricing: {
    market: string;
    list_price: number | null;
    promo_price: number | null;
    floor_price: number | null;
    currency: string;
    markets?: Record<string, { currency?: string; list_price?: number | null; promo_price?: number | null; floor_price?: number | null }>;
  };
};

type OrderBundle = { order: Record<string, any>; process_status: string; submodules: Record<OrderSubmoduleKind, Record<string, any> | null>; files: string[] };
type OrderSubmoduleKind = "quotes" | "inspections" | "payments" | "shipments" | "invoices" | "reconciliations" | "archives" | "attachments";
type OrderLineProductId = string | number;
type OrderLineItem = { product_id: OrderLineProductId; quantity: number };
type TradeDocumentKind = "quotes" | "invoices";

const COMMON_CURRENCIES = ["CNY", "USD", "EUR", "GBP", "CHF", "JPY", "HKD", "SGD", "AUD", "CAD"] as const;
const COMMON_COUNTRIES = [
  "China",
  "Hong Kong",
  "Macao",
  "Taiwan",
  "Singapore",
  "Malaysia",
  "Thailand",
  "Japan",
  "South Korea",
  "Vietnam",
  "Indonesia",
  "Philippines",
  "India",
  "United Arab Emirates",
  "Saudi Arabia",
  "Turkey",
  "Germany",
  "France",
  "Italy",
  "Spain",
  "Netherlands",
  "Belgium",
  "Switzerland",
  "United Kingdom",
  "Ireland",
  "United States",
  "Canada",
  "Australia",
  "New Zealand",
  "Brazil",
] as const;
const PACKAGING_OPTIONS = [
  { value: "normal", label: "普通包装" },
  { value: "gift", label: "精包装" },
] as const;

const ORDER_SUBMODULES: { kind: OrderSubmoduleKind; label: string }[] = [
  { kind: "quotes", label: "报价" },
  { kind: "inspections", label: "报检" },
  { kind: "payments", label: "收款" },
  { kind: "shipments", label: "发货明细" },
  { kind: "invoices", label: "开票" },
  { kind: "reconciliations", label: "对账" },
  { kind: "archives", label: "归档" },
  { kind: "attachments", label: "附件" },
];

export const ORDER_EDITOR_ITEMS: Array<{ value: string; label: string }> = [
  { value: "order", label: "概览" },
  { value: "quotes", label: "报价" },
  { value: "inspections", label: "报检" },
  { value: "payments", label: "收款" },
  { value: "shipments", label: "发货" },
  { value: "invoices", label: "开票" },
  { value: "reconciliations", label: "对账" },
  { value: "archives", label: "归档" },
  { value: "attachments", label: "附件" },
];

function assetUrl(workspace: string, assetPath: string | null | undefined) {
  if (!workspace || !assetPath) return "";
  const encoded = assetPath.split("/").map((part) => encodeURIComponent(part)).join("/");
  return wanghaiPath(`/api/workspaces/${encodeURIComponent(workspace)}/assets?path=${encoded}`);
}

function thumbnailUrl(
  workspace: string,
  assetPath: string | null | undefined,
  asset?: { modified_at?: string | null; size?: number | null },
) {
  if (!workspace || !assetPath) return "";
  const encoded = assetPath.split("/").map((part) => encodeURIComponent(part)).join("/");
  const version = asset?.modified_at && typeof asset?.size === "number"
    ? `&v=${encodeURIComponent(asset.modified_at)}&s=${asset.size}`
    : "";
  return wanghaiPath(`/api/workspaces/${encodeURIComponent(workspace)}/thumb?path=${encoded}${version}`);
}

function LoadingNotice({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="space-y-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="mt-4">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-sm text-muted-foreground">{description}</div>
      </div>
    </div>
  );
}

function responseErrorMessage(url: string, status: number, body: unknown): string {
  if (typeof body === "object" && body && "error" in body) {
    return String((body as { error: unknown }).error);
  }
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (trimmed) return trimmed.slice(0, 200);
  }
  return `Request failed: ${status} for ${url}`;
}

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await wanghaiMutationFetch(url, init);
  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(responseErrorMessage(url, res.status, body));

  if (!contentType.includes("application/json")) throw new Error(`Expected JSON from ${url}`);
  return body as T;
}


export function OrderDetailEditor({
  workspace,
  orderNo,
  onClose,
}: {
  workspace: string;
  orderNo: string;
  onClose?: () => void;
}) {
  const [bundle, setBundle] = useState<OrderBundle | null>(null);
  const [loadingBundle, setLoadingBundle] = useState(true);
  const [activeTab, setActiveTab] = useState("order");

  useEffect(() => {
    if (!workspace || !orderNo) return;
    let cancelled = false;
    setLoadingBundle(true);
    setActiveTab("order");
    fetchJson<OrderBundle>(
      `/api/workspaces/${encodeURIComponent(workspace)}/orders/${encodeURIComponent(orderNo)}`,
    )
      .then((data) => {
        if (!cancelled) setBundle(data);
      })
      .catch((error) => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : "订单读取失败");
      })
      .finally(() => {
        if (!cancelled) setLoadingBundle(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, orderNo]);

  if (loadingBundle || !bundle) {
    return (
      <div className="h-full overflow-auto p-4 md:p-6">
        <LoadingNotice title="正在加载订单" description="正在读取订单 metadata、商品资料和流程子模块。" />
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4 [scrollbar-gutter:stable] md:p-6">
      <OrderEditorPageContent
        workspace={workspace}
        orderNo={orderNo}
        bundle={bundle}
        activeTab={activeTab}
        onActiveTabChange={setActiveTab}
        onClose={onClose}
      />
    </div>
  );
}

function OrderEditorPageContent({
  workspace,
  orderNo,
  bundle,
  activeTab,
  onActiveTabChange,
  onClose,
}: {
  workspace: string;
  orderNo: string;
  bundle: OrderBundle;
  activeTab: string;
  onActiveTabChange: (value: string) => void;
  onClose?: () => void;
}) {
  const { locale, ts } = useI18n();
  const [order, setOrder] = useState(bundle.order);
  const [submodules, setSubmodules] = useState(bundle.submodules);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const isViewingReadonlyDocument = activeTab === "quotes" || activeTab === "inspections" || activeTab === "invoices";
  const currentProcessStatus = ts(deriveOrderProcessStatus(order, submodules));
  const activeSubmodule = ORDER_SUBMODULES.find((item) => item.kind === activeTab);
  const activeSubmoduleRecord = activeSubmodule ? submodules[activeSubmodule.kind] ?? defaultSubmoduleForm(activeSubmodule.kind, orderNo) : null;
  const activeSubmoduleConfig = activeSubmodule ? submoduleMeta(activeSubmodule.kind) : null;
  const orderLines = normalizeOrderLineItems(order.lines);
  const derivedItemsSubtotal = calculateOrderItemsSubtotal(orderLines, products, String(order.currency ?? "CNY"));

  useEffect(() => {
    setProductsLoading(true);
    fetchJson<{ products: ProductRow[] }>(`/api/workspaces/${encodeURIComponent(workspace)}/products?all=1`)
      .then((data) => setProducts((data.products ?? []).filter((product) => product.id !== null)))
      .catch((error) => toast.error(error instanceof Error ? error.message : "产品列表加载失败"))
      .finally(() => setProductsLoading(false));
  }, [workspace]);

  useEffect(() => {
    setOrder((current) => {
      const currentSubtotal = numericOrNull(String(current.totals?.items_subtotal ?? ""));
      if (currentSubtotal === derivedItemsSubtotal) return current;
      return patchObject(current, "totals.items_subtotal", derivedItemsSubtotal);
    });
  }, [derivedItemsSubtotal]);

  function patch(path: string, value: unknown) {
    setOrder((current) => patchObject(current, path, value));
  }

  function patchSubmodule(kind: OrderSubmoduleKind, path: string, value: unknown) {
    setSubmodules((current) => ({ ...current, [kind]: patchObject(current[kind] ?? defaultSubmoduleForm(kind, orderNo), path, value) }));
  }

  function replaceSubmodule(kind: OrderSubmoduleKind, nextRecord: Record<string, any>) {
    setSubmodules((current) => ({ ...current, [kind]: nextRecord }));
  }

  async function save() {
    try {
      await fetchJson(`/api/workspaces/${encodeURIComponent(workspace)}/orders/${encodeURIComponent(orderNo)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patchObject(order, "totals.items_subtotal", derivedItemsSubtotal)),
      });
      for (const kind of ORDER_SUBMODULES.map((item) => item.kind)) {
        const record = submodules[kind];
        if (!record) continue;
        await fetchJson(`/api/workspaces/${encodeURIComponent(workspace)}/orders/${encodeURIComponent(orderNo)}/submodules/${kind}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(record),
        });
      }
      toast.success("订单已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "订单保存失败");
    }
  }

  return (
    <div>
      <Card className="border-0 shadow-none sm:border sm:shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0 px-0 sm:px-6">
          <div>
            <CardTitle>编辑订单</CardTitle>
            <CardDescription>{orderNo}</CardDescription>
          </div>
          {activeTab === "order" ? (
            <div className="w-40 shrink-0">
              <Input value={currentProcessStatus} disabled />
            </div>
          ) : activeSubmodule && activeSubmoduleConfig?.statusOptions && activeSubmoduleRecord ? (
            <div className="w-40 shrink-0">
              <Select value={String(activeSubmoduleRecord.status ?? activeSubmoduleConfig.statusOptions[0]?.value ?? "")} onValueChange={(value) => patchSubmodule(activeSubmodule.kind, "status", value)}>
                <SelectTrigger aria-label={`${activeSubmoduleConfig.title}状态`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {activeSubmoduleConfig.statusOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="px-0 sm:px-6">
          <Tabs value={activeTab} onValueChange={onActiveTabChange}>
            <TabsList className="mb-4 flex h-auto w-full flex-wrap justify-start gap-1">
              {ORDER_EDITOR_ITEMS.map((entry) => (
                <TabsTrigger key={entry.value} value={entry.value}>
                  {entry.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="order" className="mt-0">
              <FieldGroup>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field><FieldLabel>订单号</FieldLabel><Input value={orderNo} disabled /></Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field><FieldLabel>下单日期</FieldLabel><Input type="date" lang={locale} value={order.dates?.order_date ?? ""} onChange={(event) => patch("dates.order_date", event.target.value || null)} /></Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field><FieldLabel>客户名称</FieldLabel><Input value={order.customer?.name ?? ""} onChange={(event) => patch("customer.name", event.target.value || null)} /></Field>
                  <Field>
                    <FieldLabel>国家</FieldLabel>
                    <Select value={COMMON_COUNTRIES.includes(String(order.customer?.country ?? "") as (typeof COMMON_COUNTRIES)[number]) ? String(order.customer?.country) : undefined} onValueChange={(value) => patch("customer.country", value || null)}>
                      <SelectTrigger aria-label="选择国家">
                        <SelectValue placeholder="选择国家" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {COMMON_COUNTRIES.map((country) => (
                            <SelectItem key={country} value={country}>
                              {country}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field><FieldLabel>联系人姓名</FieldLabel><Input value={order.customer?.contact_name ?? ""} onChange={(event) => patch("customer.contact_name", event.target.value || null)} /></Field>
                  <Field><FieldLabel>联系人邮箱</FieldLabel><Input type="email" value={order.customer?.contact_email ?? ""} onChange={(event) => patch("customer.contact_email", event.target.value || null)} /></Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel>包装</FieldLabel>
                    <Select value={normalizeOrderPackaging(order.packaging)} onValueChange={(value) => patch("packaging", value)}>
                      <SelectTrigger aria-label="选择包装">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {PACKAGING_OPTIONS.map((packaging) => (
                            <SelectItem key={packaging.value} value={packaging.value}>
                              {packaging.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel>币种</FieldLabel>
                    <Select value={String(order.currency ?? "CNY")} onValueChange={(value) => patch("currency", value)}>
                      <SelectTrigger aria-label="选择币种">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {COMMON_CURRENCIES.map((currency) => (
                            <SelectItem key={currency} value={currency}>
                              {currency}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field><FieldLabel>商品小计</FieldLabel><Input value={derivedItemsSubtotal} disabled /></Field>
                  <Field><FieldLabel>运费</FieldLabel><Input value={order.totals?.shipping ?? ""} onChange={(event) => patch("totals.shipping", numericOrNull(event.target.value))} /></Field>
                  <Field><FieldLabel>客户应付</FieldLabel><Input value={order.totals?.customer_payable ?? ""} onChange={(event) => patch("totals.customer_payable", numericOrNull(event.target.value))} /></Field>
                </div>
                <Field>
                  <FieldLabel>商品明细</FieldLabel>
                  <OrderLineItemsEditor workspace={workspace} currency={String(order.currency ?? "CNY")} lines={orderLines} products={products} loading={productsLoading} onChange={(lines) => patch("lines", lines)} />
                </Field>
                <Field><FieldLabel>备注</FieldLabel><Textarea value={linesText(order.notes)} onChange={(event) => patch("notes", splitLines(event.target.value))} /></Field>
              </FieldGroup>
            </TabsContent>
            {ORDER_SUBMODULES.map((item) => (
              <TabsContent key={item.kind} value={item.kind} className="mt-0">
                <SubmoduleForm
                  workspace={workspace}
                  order={order}
                  kind={item.kind}
                  record={submodules[item.kind] ?? defaultSubmoduleForm(item.kind, orderNo)}
                  onPatch={(field, value) => patchSubmodule(item.kind, field, value)}
                  onReplace={(record) => replaceSubmodule(item.kind, record)}
                />
              </TabsContent>
            ))}
          </Tabs>
          {isViewingReadonlyDocument ? null : (
            <div className="mt-6 flex justify-end gap-3">
              {onClose ? (
                <Button variant="outline" onClick={onClose} type="button">关闭</Button>
              ) : null}
              <Button onClick={save} type="button">保存</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function OrderLineItemsEditor({
  workspace,
  currency,
  lines,
  products,
  loading,
  onChange,
}: {
  workspace: string;
  currency: string;
  lines: OrderLineItem[];
  products: ProductRow[];
  loading: boolean;
  onChange: (lines: OrderLineItem[]) => void;
}) {
  const productMap = new Map(products.map((product) => [String(product.id), product] as const));
  const [pickerOpen, setPickerOpen] = useState(false);

  function appendLine(productId: number | null | undefined) {
    if (productId === null || productId === undefined) return;
    onChange([...lines, { product_id: productId, quantity: 1 }]);
    setPickerOpen(false);
  }

  function updateQuantity(index: number, value: string) {
    const next = [...lines];
    next[index] = { ...next[index], quantity: numericOrNull(value) ?? 0 };
    onChange(next);
  }

  function removeLine(index: number) {
    onChange(lines.filter((_, lineIndex) => lineIndex !== index));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">{lines.length} 个商品</div>
        <Button type="button" size="sm" variant="outline" onClick={() => setPickerOpen(true)} disabled={loading || products.length === 0}>
          <Plus data-icon="inline-start" />
          添加商品
        </Button>
      </div>
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>选择商品</DialogTitle>
            <DialogDescription>选择一个商品加入当前订单。</DialogDescription>
          </DialogHeader>
          <div className="max-h-96 overflow-y-auto">
            <div className="flex flex-col gap-2">
              {products.map((product) => (
                <button
                  key={product.sku}
                  type="button"
                  className="flex items-center justify-between rounded-md border px-3 py-2 text-left hover:bg-muted"
                  onClick={() => appendLine(product.id)}
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="overflow-hidden rounded-md border bg-muted">
                      {product.thumbnail ? (
                        <img
                          src={thumbnailUrl(workspace, product.thumbnail, {
                            modified_at: product.thumbnail_modified_at,
                            size: product.thumbnail_size,
                          })}
                          alt={product.name}
                          className="h-12 w-12 object-cover"
                        />
                      ) : (
                        <span className="flex h-12 w-12 items-center justify-center text-xs text-muted-foreground">无图</span>
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium">{product.sku} · {product.name}</span>
                      <span className="block text-sm text-muted-foreground">{product.sku_subcategory_label}</span>
                    </span>
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {currency} {productUnitPrice(product, currency) ?? "-"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {loading ? (
        <LoadingNotice title="正在加载商品明细" description="正在读取产品管理中的商品编号和基础信息。" />
      ) : lines.length === 0 ? (
        <Empty>
          <EmptyTitle>暂无商品</EmptyTitle>
          <EmptyDescription>先从产品管理里选择商品编号，再把订单侧金额与备注补在上方字段或子模块里。</EmptyDescription>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {lines.map((line, index) => {
            const selected = productMap.get(String(line.product_id));
            const unitPrice = selected ? productUnitPrice(selected, currency) : null;
            return (
              <div key={`${String(line.product_id)}-${index}`} className="rounded-lg border bg-card p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 text-sm font-medium">商品 {index + 1}</div>
                    <div className="grid gap-3 sm:grid-cols-[88px_repeat(4,minmax(0,1fr))]">
                      <div className="overflow-hidden rounded-md border bg-muted">
                        {selected?.thumbnail ? (
                          <img
                            src={thumbnailUrl(workspace, selected.thumbnail, {
                              modified_at: selected.thumbnail_modified_at,
                              size: selected.thumbnail_size,
                            })}
                            alt={selected.name}
                            className="h-20 w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-20 items-center justify-center text-xs text-muted-foreground">无图</div>
                        )}
                      </div>
                      <Field>
                        <FieldLabel>编号</FieldLabel>
                        <Input value={String(line.product_id ?? "")} disabled />
                      </Field>
                      <Field>
                        <FieldLabel>名称</FieldLabel>
                        <Input value={selected?.name ?? ""} disabled />
                      </Field>
                      <Field>
                        <FieldLabel>数量</FieldLabel>
                        <Input value={line.quantity ?? ""} onChange={(event) => updateQuantity(index, event.target.value)} inputMode="decimal" />
                      </Field>
                      <Field>
                        <FieldLabel>单价</FieldLabel>
                        <Input value={unitPrice ?? ""} disabled />
                      </Field>
                    </div>
                    {selected ? null : (
                      <div className="text-sm text-destructive">未找到产品编号 {String(line.product_id)}</div>
                    )}
                  </div>
                  <Button type="button" size="icon" variant="ghost" onClick={() => removeLine(index)} aria-label={`删除商品 ${index + 1}`}>
                    <Trash2 data-icon="inline-start" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function defaultSubmoduleForm(kind: OrderSubmoduleKind, orderNo: string) {
  if (kind === "quotes") return { schema: "wanghai.operations.quote", schema_version: 2, order_no: orderNo, status: "draft", quote_no: null, quote_date: today(), valid_until: null, currency: "USD", customer_text: null, ports: { loading: "SHENZHEN, CHINA", discharge: null }, trade_term: { label: null, place: null }, container: null, payment_terms: "ONE-TIME PAYMENT", delivery_time: "AFTER DEPOSIT 14 DAYS", partial_shipment: "NO ALLOWED", quantity_tolerance: "5% MORE OR LESS ALLOWED", items: [], totals: { quantity_ctns: null, weight_kgs: null, amount_usd: null, amount_words: null }, documents: [], notes: [] };
  if (kind === "inspections") return { schema: "wanghai.operations.inspection", schema_version: 1, order_no: orderNo, status: "pending", inspection_no: null, inspection_date: today(), items: [], checks: {}, documents: [], notes: [] };
  if (kind === "payments") return { schema: "wanghai.operations.payment", schema_version: 1, order_no: orderNo, status: "pending", receivable_amount: null, received_amount: null, method: null, received_at: null, exchange_rate: null, proof_documents: [], documents: [], notes: [] };
  if (kind === "shipments") return { schema: "wanghai.operations.shipment", schema_version: 1, order_no: orderNo, status: "pending", carrier: null, channel: null, tracking_no: null, ship_date: today(), destination_country: null, packages: [], costs: {}, documents: [], notes: [] };
  if (kind === "invoices") return { schema: "wanghai.operations.invoice", schema_version: 2, order_no: orderNo, status: "not_requested", invoice_type: "CI", invoice_no: null, issue_date: today(), buyer: {}, currency: "USD", customer_text: null, ports: { loading: "SHENZHEN, CHINA", discharge: null }, trade_term: { label: null, place: null }, container: null, items: [], totals: { quantity_ctns: null, weight_kgs: null, amount_usd: null, amount_words: null }, amount: null, documents: [], notes: [] };
  if (kind === "reconciliations") return { schema: "wanghai.operations.reconciliation", schema_version: 1, order_no: orderNo, status: "pending", checked_at: null, sales_amount: null, received_amount: null, invoice_amount: null, logistics_cost: null, supplier_payable: null, difference: null, documents: [], notes: [] };
  if (kind === "archives") return { schema: "wanghai.operations.archive", schema_version: 1, order_no: orderNo, status: "pending", archived_at: null, location: null, documents: [], notes: [] };
  return { schema: "wanghai.operations.attachments", schema_version: 1, order_no: orderNo, documents: [], notes: [] };
}

function patchObject(value: Record<string, any>, fieldPath: string, nextValue: unknown): Record<string, any> {
  const next = structuredClone(value);
  const keys = fieldPath.split(".");
  let target: any = next;
  for (const key of keys.slice(0, -1)) {
    target[key] = target[key] && typeof target[key] === "object" ? target[key] : {};
    target = target[key];
  }
  target[keys.at(-1)!] = nextValue;
  return next;
}

function splitLines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function linesText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join("\n");
  return typeof value === "string" ? value : "";
}

function numericOrNull(value: string): number | null {
  if (!value) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function roundMoney(value: number): number {
  return Number(value.toFixed(2));
}

function productUnitPrice(product: ProductRow, currency: string): number | null {
  const markets = product.pricing?.markets ?? {};
  const normalizedCurrency = currency.trim().toUpperCase();
  for (const market of Object.values(markets)) {
    if (String(market?.currency ?? "").trim().toUpperCase() !== normalizedCurrency) continue;
    const price = numericOrNull(String(market?.list_price ?? market?.promo_price ?? market?.floor_price ?? ""));
    if (price !== null) return price;
  }
  const fallback = numericOrNull(String(product.pricing?.list_price ?? product.pricing?.promo_price ?? product.pricing?.floor_price ?? ""));
  return fallback;
}

function calculateOrderItemsSubtotal(lines: OrderLineItem[], products: ProductRow[], currency: string): number {
  const productMap = new Map(products.map((product) => [String(product.id), product] as const));
  return roundMoney(lines.reduce((sum, line) => {
    const product = productMap.get(String(line.product_id));
    const unitPrice = product ? productUnitPrice(product, currency) : null;
    const quantity = line.quantity ?? 0;
    return sum + (unitPrice ?? 0) * quantity;
  }, 0));
}

function normalizeOrderPackaging(value: unknown): "normal" | "gift" {
  return value === "gift" ? "gift" : "normal";
}

function normalizeOrderLineItems(value: unknown): OrderLineItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "number") {
        return Number.isFinite(entry) ? { product_id: entry, quantity: 1 } : null;
      }
      if (typeof entry === "string") {
        const trimmed = entry.trim();
        if (!trimmed) return null;
        const numeric = Number(trimmed);
        return { product_id: Number.isInteger(numeric) ? numeric : trimmed, quantity: 1 };
      }
      if (entry && typeof entry === "object" && "product_id" in entry) {
        const productId = (entry as { product_id?: unknown }).product_id;
        const quantity = numericOrNull(String((entry as { quantity?: unknown }).quantity ?? "")) ?? 1;
        if (typeof productId === "number") return Number.isFinite(productId) ? { product_id: productId, quantity } : null;
        if (typeof productId === "string") {
          const trimmed = productId.trim();
          if (!trimmed) return null;
          const numeric = Number(trimmed);
          return { product_id: Number.isInteger(numeric) ? numeric : trimmed, quantity };
        }
      }
      return null;
    })
    .filter((entry): entry is OrderLineItem => entry !== null);
}

function orderDocumentVersion(record: Record<string, any>, documentPath: string) {
  const totals = record.totals && typeof record.totals === "object" ? record.totals : {};
  return [documentPath, record.quote_date, record.inspection_date, totals.customer_payable, totals.items_subtotal].filter((value) => value !== null && value !== undefined && value !== "").join("-");
}

function pickPdfDocument(record: Record<string, any>, preferredKind?: string) {
  const documents = Array.isArray(record.documents) ? record.documents : [];
  const pdfs = documents.filter((document) => typeof document?.path === "string" && document.path.toLowerCase().endsWith(".pdf"));
  if (preferredKind) {
    const matched = pdfs.find((document) => document?.kind === preferredKind);
    if (matched) return matched;
  }
  return pdfs[0] ?? null;
}

function documentDownloadName(order: Record<string, any>, record: Record<string, any>, title: string) {
  const currentOrderNo = String(record.order_no ?? order.order_no ?? "order");
  const customer = String(order.customer?.name ?? "客户");
  const date = String(record.quote_date ?? record.issue_date ?? record.inspection_date ?? order.dates?.order_date ?? today()).replaceAll("-", "");
  return `${safeDownloadName(currentOrderNo)}-${safeDownloadName(customer)}-${title}-${safeDownloadName(date)}.pdf`;
}

function safeDownloadName(value: string) {
  return value.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "document";
}

function PdfPreview({ url, title, downloadName }: { url: string; title: string; downloadName: string }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end gap-4">
        <a
          href={url}
          rel="noreferrer"
          target="_blank"
          className="text-sm font-medium text-primary underline underline-offset-4"
        >
          在新窗口打开 PDF
        </a>
        <a
          href={url}
          download={downloadName}
          className="text-sm font-medium text-primary underline underline-offset-4"
        >
          下载 PDF
        </a>
      </div>
      <div className="h-[72vh] w-full overflow-auto rounded-md border bg-muted">
        <iframe
          key={url}
          title={title}
          src={`${url}#toolbar=0&navpanes=0&view=FitH&zoom=page-width`}
          className="block h-full w-full bg-white"
        />
      </div>
    </div>
  );
}

function DocumentOnlyPreview({
  workspace,
  order,
  record,
  title,
  missingTitle,
  missingDescription,
  preferredDocumentKind,
  refreshToken,
}: {
  workspace: string;
  order: Record<string, any>;
  record: Record<string, any>;
  title: string;
  missingTitle: string;
  missingDescription: string;
  preferredDocumentKind?: string;
  refreshToken?: string;
}) {
  const pdf = pickPdfDocument(record, preferredDocumentKind);
  const [mountToken] = useState(() => String(Date.now()));
  if (!pdf) {
    return (
      <Empty className="rounded-md border bg-muted/30 py-12">
        <EmptyTitle>{missingTitle}</EmptyTitle>
        <EmptyDescription>{missingDescription}</EmptyDescription>
      </Empty>
    );
  }
  const version = orderDocumentVersion(record, pdf.path);
  const cacheKey = [version, refreshToken, mountToken].filter(Boolean).join("-");
  const url = `${orderDocumentAssetUrl(workspace, String(record.order_no), pdf.path)}${cacheKey ? `&v=${encodeURIComponent(cacheKey)}` : ""}`;
  return <PdfPreview url={url} title={title} downloadName={documentDownloadName(order, record, title)} />;
}

function submoduleMeta(kind: OrderSubmoduleKind): {
  title: string;
  statusOptions: Array<{ value: string; label: string }> | null;
} {
  if (kind === "quotes") return { title: "报价", statusOptions: [
    { value: "draft", label: "草稿" },
    { value: "sent", label: "已发送" },
    { value: "accepted", label: "已接受" },
    { value: "expired", label: "已过期" },
    { value: "cancelled", label: "已取消" },
  ] };
  if (kind === "inspections") return { title: "报检", statusOptions: [
    { value: "pending", label: "待处理" },
    { value: "draft", label: "草稿" },
    { value: "passed", label: "通过" },
    { value: "failed", label: "未通过" },
    { value: "recheck", label: "待复检" },
  ] };
  if (kind === "payments") return { title: "收款", statusOptions: [
    { value: "pending", label: "待收款" },
    { value: "partial", label: "部分收款" },
    { value: "paid", label: "已收款" },
    { value: "refunded", label: "已退款" },
    { value: "unverified", label: "待核验" },
  ] };
  if (kind === "shipments") return { title: "发货", statusOptions: [
    { value: "pending", label: "待发货" },
    { value: "ready", label: "已备货" },
    { value: "shipped", label: "已发货" },
    { value: "delivered", label: "已送达" },
    { value: "exception", label: "异常" },
  ] };
  if (kind === "invoices") return { title: "开票", statusOptions: [
    { value: "not_requested", label: "未申请" },
    { value: "collecting_info", label: "收集中" },
    { value: "draft", label: "草稿" },
    { value: "issued", label: "已开票" },
    { value: "cancelled", label: "已取消" },
  ] };
  if (kind === "reconciliations") return { title: "对账", statusOptions: [
    { value: "pending", label: "待对账" },
    { value: "matched", label: "已匹配" },
    { value: "mismatch", label: "有差异" },
    { value: "closed", label: "已关闭" },
  ] };
  if (kind === "archives") return { title: "归档", statusOptions: [
    { value: "pending", label: "待归档" },
    { value: "partial", label: "部分归档" },
    { value: "complete", label: "已归档" },
  ] };
  return { title: "附件", statusOptions: null };
}

function SubmoduleShell({
  children,
}: {
  children: ReactNode;
}) {
  return <div className="flex flex-col gap-4">{children}</div>;
}

function SubmoduleForm({
  workspace,
  order,
  kind,
  record,
  onPatch,
  onReplace,
}: {
  workspace: string;
  order: Record<string, any>;
  kind: OrderSubmoduleKind;
  record: Record<string, any>;
  onPatch: (path: string, value: unknown) => void;
  onReplace: (record: Record<string, any>) => void;
}) {
  if (kind === "quotes" || kind === "invoices") {
    return <SubmoduleShell><GeneratedTradeDocumentPanel workspace={workspace} order={order} kind={kind} record={record} onReplace={onReplace} /></SubmoduleShell>;
  }
  if (kind === "inspections") {
    return <SubmoduleShell><DocumentOnlyPreview workspace={workspace} order={order} record={record} title="报检单" missingTitle="尚未生成报检单" missingDescription="请先通过订单脚本生成报检单 PDF。" /></SubmoduleShell>;
  }
  if (kind === "payments") {
    return (
      <SubmoduleShell>
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field><FieldLabel>应收金额</FieldLabel><Input value={record.receivable_amount ?? ""} onChange={(event) => onPatch("receivable_amount", numericOrNull(event.target.value))} /></Field>
          <Field><FieldLabel>实收金额</FieldLabel><Input value={record.received_amount ?? ""} onChange={(event) => onPatch("received_amount", numericOrNull(event.target.value))} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field><FieldLabel>收款方式</FieldLabel><Input value={record.method ?? ""} onChange={(event) => onPatch("method", event.target.value || null)} /></Field>
          <Field><FieldLabel>收款时间</FieldLabel><Input value={record.received_at ?? ""} onChange={(event) => onPatch("received_at", event.target.value || null)} /></Field>
          <Field><FieldLabel>汇率</FieldLabel><Input value={record.exchange_rate ?? ""} onChange={(event) => onPatch("exchange_rate", numericOrNull(event.target.value))} /></Field>
        </div>
        <Field><FieldLabel>备注</FieldLabel><Textarea value={linesText(record.notes)} onChange={(event) => onPatch("notes", splitLines(event.target.value))} /></Field>
      </FieldGroup>
      </SubmoduleShell>
    );
  }
  if (kind === "shipments") {
    return (
      <SubmoduleShell>
      <FieldGroup>
        <Field><FieldLabel>承运商</FieldLabel><Input value={record.carrier ?? ""} onChange={(event) => onPatch("carrier", event.target.value || null)} /></Field>
        <Field><FieldLabel>渠道</FieldLabel><Input value={record.channel ?? ""} onChange={(event) => onPatch("channel", event.target.value || null)} /></Field>
        <Field><FieldLabel>运单号</FieldLabel><Input value={record.tracking_no ?? ""} onChange={(event) => onPatch("tracking_no", event.target.value || null)} /></Field>
        <Field><FieldLabel>发货日期</FieldLabel><Input value={record.ship_date ?? ""} onChange={(event) => onPatch("ship_date", event.target.value || null)} /></Field>
        <Field><FieldLabel>目的国</FieldLabel><Input value={record.destination_country ?? ""} onChange={(event) => onPatch("destination_country", event.target.value || null)} /></Field>
        <Field><FieldLabel>备注</FieldLabel><Textarea value={linesText(record.notes)} onChange={(event) => onPatch("notes", splitLines(event.target.value))} /></Field>
      </FieldGroup>
      </SubmoduleShell>
    );
  }
  if (kind === "reconciliations") {
    return (
      <SubmoduleShell>
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field><FieldLabel>对账日期</FieldLabel><Input value={record.checked_at ?? ""} onChange={(event) => onPatch("checked_at", event.target.value || null)} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field><FieldLabel>销售金额</FieldLabel><Input value={record.sales_amount ?? ""} onChange={(event) => onPatch("sales_amount", numericOrNull(event.target.value))} /></Field>
          <Field><FieldLabel>实收金额</FieldLabel><Input value={record.received_amount ?? ""} onChange={(event) => onPatch("received_amount", numericOrNull(event.target.value))} /></Field>
          <Field><FieldLabel>发票金额</FieldLabel><Input value={record.invoice_amount ?? ""} onChange={(event) => onPatch("invoice_amount", numericOrNull(event.target.value))} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field><FieldLabel>物流费用</FieldLabel><Input value={record.logistics_cost ?? ""} onChange={(event) => onPatch("logistics_cost", numericOrNull(event.target.value))} /></Field>
          <Field><FieldLabel>供应商应付</FieldLabel><Input value={record.supplier_payable ?? ""} onChange={(event) => onPatch("supplier_payable", numericOrNull(event.target.value))} /></Field>
          <Field><FieldLabel>差额</FieldLabel><Input value={record.difference ?? ""} onChange={(event) => onPatch("difference", numericOrNull(event.target.value))} /></Field>
        </div>
        <Field><FieldLabel>备注</FieldLabel><Textarea value={linesText(record.notes)} onChange={(event) => onPatch("notes", splitLines(event.target.value))} /></Field>
      </FieldGroup>
      </SubmoduleShell>
    );
  }
  if (kind === "archives") {
    return (
      <SubmoduleShell>
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field><FieldLabel>归档日期</FieldLabel><Input value={record.archived_at ?? ""} onChange={(event) => onPatch("archived_at", event.target.value || null)} /></Field>
          <Field><FieldLabel>归档位置</FieldLabel><Input value={record.location ?? ""} onChange={(event) => onPatch("location", event.target.value || null)} /></Field>
        </div>
        <Field><FieldLabel>备注</FieldLabel><Textarea value={linesText(record.notes)} onChange={(event) => onPatch("notes", splitLines(event.target.value))} /></Field>
      </FieldGroup>
      </SubmoduleShell>
    );
  }
  return <SubmoduleShell>
    <FieldGroup>
      <Field><FieldLabel>附件备注</FieldLabel><Textarea value={linesText(record.notes)} onChange={(event) => onPatch("notes", splitLines(event.target.value))} /></Field>
    </FieldGroup>
  </SubmoduleShell>;
}

function GeneratedTradeDocumentPanel({
  workspace,
  order,
  kind,
  record,
  onReplace,
}: {
  workspace: string;
  order: Record<string, any>;
  kind: TradeDocumentKind;
  record: Record<string, any>;
  onReplace: (record: Record<string, any>) => void;
}) {
  const { ts } = useI18n();
  const pdf = pickPdfDocument(record, kind === "quotes" ? "pi" : "ci");
  const [refreshToken, setRefreshToken] = useState<string>("");
  const generateLabel = kind === "quotes" ? ts("生成 PI PDF") : ts("生成 CI PDF");
  const downloadLabel = kind === "quotes" ? ts("下载 PI PDF") : ts("下载 CI PDF");
  const missingLabel = kind === "quotes" ? ts("尚未生成 PI PDF") : ts("尚未生成 CI PDF");

  async function generateDocument() {
    try {
      const data = await fetchJson<{ record: Record<string, any> }>(`/api/workspaces/${encodeURIComponent(workspace)}/orders/${encodeURIComponent(String(order.order_no))}/submodules/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "generate_document" }),
      });
      onReplace(data.record);
      setRefreshToken(String(Date.now()));
      toast.success(`${kind === "quotes" ? "PI" : "CI"} PDF 已生成`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "PDF 生成失败");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={generateDocument}>{generateLabel}</Button>
        {pdf ? (
          <Button type="button" variant="outline" asChild>
            <a
              href={orderDocumentAssetUrl(workspace, String(record.order_no ?? order.order_no), pdf.path)}
              download={documentDownloadName(order, record, kind === "quotes" ? "PI" : "CI")}
            >
              {downloadLabel}
            </a>
          </Button>
        ) : null}
      </div>
      {pdf ? (
        <DocumentOnlyPreview
          workspace={workspace}
          order={order}
          record={record}
          title={kind === "quotes" ? "PI" : "CI"}
          missingTitle=""
          missingDescription=""
          preferredDocumentKind={kind === "quotes" ? "pi" : "ci"}
          refreshToken={refreshToken}
        />
      ) : (
        <Empty>
          <EmptyTitle>{missingLabel}</EmptyTitle>
          <EmptyDescription>点击上方按钮，按模板生成并预览 PDF。</EmptyDescription>
        </Empty>
      )}
    </div>
  );
}

function deriveOrderProcessStatus(order: Record<string, any>, submodules: Record<OrderSubmoduleKind, Record<string, any> | null>) {
  if (String(order.status ?? "draft") === "cancelled") return "已取消";
  if (!isQuoteReady(submodules.quotes)) return "待报价";
  if (!isInspectionReady(submodules.inspections)) return "待报检";
  if (!isPaymentReady(submodules.payments)) return "待收款";
  if (!isShipmentReady(submodules.shipments)) return "待发货";
  if (!isInvoiceReady(submodules.invoices)) return "待开票";
  if (!isReconciliationReady(submodules.reconciliations)) return "待对账";
  if (!isArchiveReady(submodules.archives)) return "待归档";
  return "已归档";
}

function hasGeneratedDocuments(meta: Record<string, any> | null, kinds: string[]) {
  const documents = Array.isArray(meta?.documents) ? meta.documents : [];
  return documents.some((document) => {
    if (!document || typeof document !== "object") return false;
    const pathValue = typeof document.path === "string" ? document.path.toLowerCase() : "";
    const kindValue = typeof document.kind === "string" ? document.kind : "";
    return Boolean(pathValue.endsWith(".pdf") || pathValue.endsWith(".html")) && (kinds.length === 0 || kinds.includes(kindValue));
  });
}

function isQuoteReady(meta: Record<string, any> | null) {
  const status = String(meta?.status ?? "");
  return ["sent", "accepted", "expired", "cancelled"].includes(status) || hasGeneratedDocuments(meta, ["quote", "pi"]);
}

function isInspectionReady(meta: Record<string, any> | null) {
  const status = String(meta?.status ?? "");
  return ["passed", "failed", "recheck"].includes(status) || hasGeneratedDocuments(meta, ["inspection"]);
}

function isPaymentReady(meta: Record<string, any> | null) {
  const status = String(meta?.status ?? "");
  return ["paid", "refunded"].includes(status);
}

function isShipmentReady(meta: Record<string, any> | null) {
  const status = String(meta?.status ?? "");
  return ["shipped", "delivered"].includes(status);
}

function isInvoiceReady(meta: Record<string, any> | null) {
  const status = String(meta?.status ?? "");
  return ["issued", "cancelled"].includes(status) || hasGeneratedDocuments(meta, ["invoice", "ci"]);
}

function isReconciliationReady(meta: Record<string, any> | null) {
  const status = String(meta?.status ?? "");
  return ["matched", "closed"].includes(status);
}

function isArchiveReady(meta: Record<string, any> | null) {
  return String(meta?.status ?? "") === "complete";
}
