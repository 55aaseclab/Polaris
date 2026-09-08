"use client";

import {
  CircleAlert,
  LoaderCircle,
  Search,
  ShoppingCart,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/components/i18n-provider";
import { Input } from "@/components/ui/input";
import { OrderDetailEditor } from "@/components/order-detail-editor";
import { wanghaiPath } from "@/lib/paths";

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

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(wanghaiPath(url), { cache: "no-store" });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof body?.error === "string" ? body.error : `请求失败：${response.status}`);
  }
  return body as T;
}

function formatAmount(amount: number | null, currency: string, locale: string): string {
  if (amount === null) return "—";
  return `${currency} ${new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2,
  }).format(amount)}`;
}

function orderStorageKey(workspace: string, name: string) {
  return `wanghai.order-management.${name}:${workspace}`;
}

function readStoredValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private browsing contexts.
  }
}

export function OrderManagementPanel({
  initialOrderNo = null,
  refreshKey,
  workspace,
}: {
  initialOrderNo?: string | null;
  refreshKey: number;
  workspace: string;
}) {
  const { locale, t, tm } = useI18n();
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectedOrderRef = useRef<string | null>(null);
  const handledRefreshKeyRef = useRef(refreshKey);
  const shouldRestoreListScrollRef = useRef(false);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [selectedOrderNo, setSelectedOrderNo] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadOrders = useCallback(async (preferredOrderNo?: string | null) => {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<{ orders: OrderSummary[] }>(
        `/api/workspaces/${encodeURIComponent(workspace)}/orders`,
      );
      const nextOrders = data.orders ?? [];
      setOrders(nextOrders);
      const preferred = preferredOrderNo
        ?? selectedOrderRef.current
        ?? readStoredValue(orderStorageKey(workspace, "selected-order"));
      const exists = preferred && nextOrders.some((order) => order.order_no === preferred);
      const nextSelected = exists
        ? preferred
        : nextOrders[0]?.order_no ?? null;
      selectedOrderRef.current = nextSelected;
      setSelectedOrderNo(nextSelected);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("orderManagement.panelLoadFailed", undefined, "订单管理加载失败"),
      );
      setOrders([]);
      setSelectedOrderNo(null);
    } finally {
      setLoading(false);
    }
  }, [t, workspace]);

  useEffect(() => {
    if (!workspace) return;
    const saved = initialOrderNo
      ?? readStoredValue(orderStorageKey(workspace, "selected-order"));
    selectedOrderRef.current = saved;
    shouldRestoreListScrollRef.current = true;
    setOrders([]);
    setSelectedOrderNo(null);
    setQuery("");
    void loadOrders(saved);
  }, [initialOrderNo, loadOrders, workspace]);

  useEffect(() => {
    if (refreshKey === handledRefreshKeyRef.current) return;
    handledRefreshKeyRef.current = refreshKey;
    void loadOrders(selectedOrderRef.current);
  }, [loadOrders, refreshKey]);

  useEffect(() => {
    if (!workspace || loading || !shouldRestoreListScrollRef.current) return;
    shouldRestoreListScrollRef.current = false;
    const storedScrollTop = Number(readStoredValue(orderStorageKey(workspace, "list-scroll-top")));
    if (!Number.isFinite(storedScrollTop) || storedScrollTop <= 0) return;
    requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: storedScrollTop });
    });
  }, [loading, workspace]);

  useEffect(() => {
    selectedOrderRef.current = selectedOrderNo;
    if (!workspace || !selectedOrderNo) return;
    writeStoredValue(orderStorageKey(workspace, "selected-order"), selectedOrderNo);
  }, [selectedOrderNo, workspace]);

  const filteredOrders = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return orders;
    return orders.filter((order) => [
      order.order_no,
      order.customer,
      order.status,
      order.process_status,
      order.order_date,
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .includes(needle));
  }, [orders, query]);

  function selectOrder(orderNo: string) {
    selectedOrderRef.current = orderNo;
    setSelectedOrderNo(orderNo);
  }

  function persistListScroll(scrollTop: number) {
    if (!workspace) return;
    writeStoredValue(orderStorageKey(workspace, "list-scroll-top"), String(scrollTop));
  }

  const statusLabels = tm<Record<string, string>>("orderManagement.statusLabels", {});

  function statusLabel(value: string): string {
    return (statusLabels[value] ?? value) || (statusLabels.unknown ?? value);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b bg-card px-4 py-4 md:px-6">
        <div>
          <p className="text-sm text-muted-foreground">{t("orderManagement.headerLabel", undefined, "业务管理")}</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{t("orderManagement.title", undefined, "订单管理")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("orderManagement.description", undefined, "在新工作台中维护订单与流程子模块。")}
          </p>
        </div>
        <ShoppingCart className="mt-1 size-5 text-muted-foreground" aria-hidden="true" />
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(17rem,0.85fr)_minmax(0,1.35fr)]">
        <aside className="flex min-h-0 flex-col border-b bg-card/40 lg:border-b-0 lg:border-r">
          <div className="border-b p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                aria-label={t("orderManagement.searchAria", undefined, "搜索订单")}
                className="pl-9"
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("orderManagement.searchPlaceholder", undefined, "搜索订单号、客户或状态…")}
                type="search"
                value={query}
              />
            </div>
          </div>
          <div
            className="min-h-0 flex-1 overflow-y-auto p-2 [scrollbar-gutter:stable]"
            onScroll={(event) => persistListScroll(event.currentTarget.scrollTop)}
            ref={listRef}
          >
            {loading ? (
              <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                {t("orderManagement.loading", undefined, "正在读取订单管理…")}
              </div>
            ) : null}
            {error ? (
              <div className="m-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {error}
              </div>
            ) : null}
            {!loading && !error && filteredOrders.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">
                {orders.length === 0
                  ? t("orderManagement.empty", undefined, "订单管理目录中还没有订单。")
                  : t("orderManagement.emptyFiltered", undefined, "暂无匹配订单。")}
              </p>
            ) : null}
            <div className="space-y-1">
              {filteredOrders.map((order) => {
                const selected = order.order_no === selectedOrderNo;
                return (
                  <button
                    aria-current={selected ? "true" : undefined}
                    className={`flex w-full items-center gap-3 rounded-md p-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "bg-accent" : "hover:bg-muted"}`}
                    key={order.order_no}
                    onClick={() => selectOrder(order.order_no)}
                    type="button"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted">
                      <ShoppingCart className="size-4 text-muted-foreground" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs font-medium">{order.order_no}</span>
                      <span className="mt-0.5 block truncate text-sm">{order.customer ?? t("orderManagement.noCustomer", undefined, "未填写客户")}</span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {order.order_date ?? t("orderManagement.noDate", undefined, "未填写日期")} · {statusLabel(order.process_status)}
                      </span>
                      {order.validation_error ? (
                        <span className="mt-0.5 block truncate text-xs text-destructive">{order.validation_error}</span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-right text-xs font-medium tabular-nums">
                      {formatAmount(order.amount, order.currency, locale)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <section className="min-h-0 overflow-hidden">
          {!selectedOrderNo ? (
            <div className="flex h-full min-h-72 items-center justify-center p-6 text-center text-sm text-muted-foreground">
              {t("orderManagement.selectPrompt", undefined, "从左侧选择一个订单以编辑详情。")}
            </div>
          ) : (
            <OrderDetailEditor
              key={`${workspace}:${selectedOrderNo}`}
              orderNo={selectedOrderNo}
              workspace={workspace}
            />
          )}
        </section>
      </div>
    </div>
  );
}
