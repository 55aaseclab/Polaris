"use client";

import {
  File,
  FileImage,
  FolderUp,
  PackagePlus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useI18n } from "@/components/i18n-provider";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { wanghaiMutationFetch } from "@/lib/mutation-request";
import { wanghaiPath } from "@/lib/paths";

type ProductAsset = {
  kind: "file" | "image";
  modified_at: string;
  name: string;
  path: string;
  relative_path: string;
  size: number;
};

type ProductSummary = {
  asset_count: number;
  description: string | null;
  id: number;
  include_in_external: boolean;
  inventory: number | null;
  name: string | null;
  name_en: string | null;
  pricing: {
    currency: string;
    floor_price: number | null;
    list_price: number | null;
    market: string;
    markets?: Record<string, { currency?: string; floor_price?: number | null; list_price?: number | null; promo_price?: number | null }>;
    promo_price: number | null;
  };
  sku: string;
  sku_category: ProductSkuCategory;
  sku_subcategory: ProductSkuSubcategory;
  sku_subcategory_label?: string;
  status: string | null;
  thumbnail: string | null;
  thumbnail_modified_at?: string | null;
  thumbnail_size?: number | null;
};

type ProductSkuCategory = "wear" | "display" | "hang" | "use" | "test";
type ProductSkuSubcategory =
  | "earrings"
  | "necklaces"
  | "hair_clips"
  | "hairpins"
  | "hair_ties"
  | "ornaments"
  | "gourds"
  | "pendants"
  | "health_hammers"
  | "test_products";

type ProductDetail = ProductSummary & {
  assets: ProductAsset[];
  meta: Record<string, unknown>;
};

type ProductPricingForm = {
  cost_currency: string;
  currency: string;
  floor_price: string;
  labor_price: string;
  list_price: string;
  market: string;
  packaging_price: string;
  promo_price: string;
  purchase_price: string;
};

type ProductForm = {
  description: string;
  include_in_external: boolean;
  inventory: string;
  name: string;
  name_en: string;
  notes: string;
  pricing: ProductPricingForm;
  sku: string;
  sku_subcategory: ProductSkuSubcategory;
};

type ProductDialogMode = "edit" | "inventory" | "price" | null;
type ProductDisplayTab = "draft" | "pending" | "selling" | "sku-stats";

const SKU_SUBCATEGORY_LABELS: Record<ProductSkuSubcategory, string> = {
  earrings: "戴的 · 耳环 · 1-1",
  necklaces: "戴的 · 项链 · 1-2",
  hair_clips: "戴的 · 发夹 · 1-3",
  hairpins: "戴的 · 发簪 · 1-4",
  hair_ties: "戴的 · 头绳 · 1-5",
  ornaments: "摆的 · 摆件 · 2-1",
  gourds: "挂的 · 葫芦 · 3-1",
  pendants: "挂的 · 挂坠 · 3-2",
  health_hammers: "用的 · 养生锤 · 4-1",
  test_products: "测试产品 · 5-1",
};

const SKU_CATEGORY_LABELS: Record<ProductSkuCategory, string> = {
  wear: "戴的",
  display: "摆的",
  hang: "挂的",
  use: "用的",
  test: "测试产品",
};

function assetUrl(
  workspace: string,
  assetPath: string,
  asset?: Pick<ProductAsset, "modified_at" | "size">,
) {
  const encodedPath = assetPath.split("/").map((part) => encodeURIComponent(part)).join("/");
  const version = asset
    ? `&v=${encodeURIComponent(asset.modified_at)}&s=${asset.size}`
    : "";
  return wanghaiPath(`/api/workspaces/${encodeURIComponent(workspace)}/assets?path=${encodedPath}${version}`);
}

function thumbnailUrl(
  workspace: string,
  assetPath: string,
  asset?: { modified_at?: string | null; size?: number | null },
) {
  const encodedPath = assetPath.split("/").map((part) => encodeURIComponent(part)).join("/");
  const version = asset?.modified_at && typeof asset?.size === "number"
    ? `&v=${encodeURIComponent(asset.modified_at)}&s=${asset.size}`
    : "";
  return wanghaiPath(`/api/workspaces/${encodeURIComponent(workspace)}/thumb?path=${encodedPath}${version}`);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await wanghaiMutationFetch(url, {
    cache: "no-store",
    ...init,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof body?.error === "string" ? body.error : `请求失败：${response.status}`);
  }
  return body as T;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberInputValue(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function formFromProduct(product: ProductDetail): ProductForm {
  const copy = asObject(product.meta.copy);
  const pricing = asObject(product.meta.pricing);
  const defaultMarket = typeof pricing.default_market === "string" && pricing.default_market
    ? pricing.default_market
    : "CN";
  const costs = asObject(pricing.costs);
  const costCurrency = typeof costs.currency === "string" && costs.currency
    ? costs.currency
    : "CNY";
  const markets = asObject(pricing.markets);
  const marketName = Object.entries(markets).find(([, value]) => {
    const market = asObject(value);
    return typeof market.currency === "string" && market.currency === costCurrency;
  })?.[0] ?? defaultMarket;
  const market = asObject(markets[marketName]);
  return {
    description: typeof copy.description === "string" ? copy.description : "",
    include_in_external: product.meta.include_in_external === true,
    inventory: product.inventory === null ? "" : String(product.inventory),
    name: product.name ?? "",
    name_en: product.name_en ?? "",
    notes: Array.isArray(product.meta.notes) ? product.meta.notes.map(String).join("\n") : "",
    pricing: {
      cost_currency: costCurrency,
      currency: typeof market.currency === "string" ? market.currency : "CNY",
      floor_price: numberInputValue(market.floor_price),
      labor_price: numberInputValue(costs.labor_price),
      list_price: numberInputValue(market.list_price),
      market: marketName,
      packaging_price: numberInputValue(costs.packaging_price),
      promo_price: numberInputValue(market.promo_price),
      purchase_price: numberInputValue(costs.purchase_price),
    },
    sku: product.sku,
    sku_subcategory: product.sku_subcategory,
  };
}

function formatSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMoney(amount: number | null, currency: string, locale: string): string {
  if (amount === null) return "—";
  return `${currency} ${new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2,
  }).format(amount)}`;
}

function primaryDisplayPrice(product: ProductSummary, locale: string): string {
  const pricing = product.pricing;
  return formatMoney(
    pricing.promo_price ?? pricing.list_price ?? pricing.floor_price,
    pricing.currency,
    locale,
  );
}

function BarStats({ items }: {
  items: Array<{ key: string; label: string; value: number }>;
}) {
  const max = Math.max(...items.map((item) => item.value), 0);

  if (max === 0) {
    return <p className="text-sm text-muted-foreground">暂无数据</p>;
  }

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <div className="space-y-1" key={item.key}>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate text-muted-foreground">{item.label}</span>
            <span className="shrink-0 font-medium tabular-nums">{item.value}</span>
          </div>
          <div className="h-2 rounded-full bg-muted">
            <div
              className="h-2 rounded-full bg-primary"
              style={{ width: `${Math.max(8, (item.value / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function matchesProductDisplayTab(product: ProductSummary, tab: ProductDisplayTab): boolean {
  if (tab === "sku-stats") return true;
  if (tab === "selling") return product.include_in_external;
  if (tab === "pending") return !product.include_in_external && product.status !== "draft";
  return !product.include_in_external && product.status === "draft";
}

function productLibraryStorageKey(workspace: string, name: string): string {
  return `wanghai.product-library.${name}:${workspace}`;
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

export function ProductLibraryPanel({
  onQueryChange,
  query,
  refreshKey,
  workspace,
}: {
  onQueryChange: (value: string) => void;
  query: string;
  refreshKey: number;
  workspace: string;
}) {
  const { locale } = useI18n();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const detailCacheRef = useRef(new Map<string, ProductDetail>());
  const selectedSkuRef = useRef<string | null>(null);
  const handledRefreshKeyRef = useRef(refreshKey);
  const shouldRestoreListScrollRef = useRef(false);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [selectedSku, setSelectedSku] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [form, setForm] = useState<ProductForm | null>(null);
  const [detailRefreshKey, setDetailRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteProductOpen, setDeleteProductOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<ProductDialogMode>(null);
  const [assetToDelete, setAssetToDelete] = useState<ProductAsset | null>(null);
  const [previewAsset, setPreviewAsset] = useState<ProductAsset | null>(null);
  const [displayTab, setDisplayTab] = useState<ProductDisplayTab>("selling");
  const [productSearchOpen, setProductSearchOpen] = useState(false);
  const [newProduct, setNewProduct] = useState<{
    name: string;
    sku_subcategory: ProductSkuSubcategory;
  }>({ sku_subcategory: "earrings", name: "" });
  const productSearchInputRef = useRef<HTMLInputElement | null>(null);

  const loadProducts = useCallback(async (preferredSku?: string | null) => {
    if (!workspace) return;
    setLoading(true);
    try {
      const data = await fetchJson<{ products: ProductSummary[] }>(
        `/api/workspaces/${encodeURIComponent(workspace)}/products`,
      );
      const nextProducts = data.products ?? [];
      setProducts(nextProducts);
      const candidate = preferredSku ?? selectedSkuRef.current;
      const nextSku = candidate && nextProducts.some((product) => product.sku === candidate)
        ? candidate
        : nextProducts[0]?.sku ?? null;
      selectedSkuRef.current = nextSku;
      setSelectedSku(nextSku);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "产品库加载失败");
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  useEffect(() => {
    if (!workspace) return;
    const savedSku = readStoredValue(productLibraryStorageKey(workspace, "selected-sku"));
    detailCacheRef.current.clear();
    selectedSkuRef.current = savedSku;
    shouldRestoreListScrollRef.current = true;
    setProducts([]);
    setSelectedSku(null);
    setDetail(null);
    setForm(null);
    void loadProducts(savedSku);
  }, [loadProducts, workspace]);

  useEffect(() => {
    if (refreshKey === handledRefreshKeyRef.current) return;
    handledRefreshKeyRef.current = refreshKey;
    detailCacheRef.current.clear();
    setDetailRefreshKey((current) => current + 1);
    void loadProducts(selectedSkuRef.current);
  }, [loadProducts, refreshKey]);

  useEffect(() => {
    if (!workspace || loading || !shouldRestoreListScrollRef.current) return;
    shouldRestoreListScrollRef.current = false;
    const storedScrollTop = Number(readStoredValue(productLibraryStorageKey(workspace, "list-scroll-top")));
    if (!Number.isFinite(storedScrollTop) || storedScrollTop <= 0) return;
    requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: storedScrollTop });
    });
  }, [loading, workspace]);

  useEffect(() => {
    if (!productSearchOpen) return;
    productSearchInputRef.current?.focus();
  }, [productSearchOpen]);

  useEffect(() => {
    selectedSkuRef.current = selectedSku;
    if (!workspace || !selectedSku) return;
    writeStoredValue(productLibraryStorageKey(workspace, "selected-sku"), selectedSku);
  }, [selectedSku, workspace]);

  useEffect(() => {
    if (!workspace || !selectedSku) {
      setDetail(null);
      setForm(null);
      return;
    }
    const cached = detailCacheRef.current.get(selectedSku);
    if (cached) {
      setDetail(cached);
      setForm(formFromProduct(cached));
      setLoadingDetail(false);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setForm(null);
    setLoadingDetail(true);
    fetchJson<{ product: ProductDetail }>(
      `/api/workspaces/${encodeURIComponent(workspace)}/products/${encodeURIComponent(selectedSku)}`,
    )
      .then((data) => {
        if (cancelled) return;
        detailCacheRef.current.set(data.product.sku, data.product);
        setDetail(data.product);
        setForm(formFromProduct(data.product));
      })
      .catch((error) => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : "产品读取失败");
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detailRefreshKey, selectedSku, workspace]);

  const filteredProducts = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const scoped = products.filter((product) => matchesProductDisplayTab(product, displayTab));
    if (!needle) return scoped;
    return scoped.filter((product) => [
      product.sku,
      product.name,
      product.name_en,
      SKU_SUBCATEGORY_LABELS[product.sku_subcategory],
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .includes(needle));
  }, [displayTab, products, query]);

  const productTabCounts = useMemo(() => ({
    selling: products.filter((product) => matchesProductDisplayTab(product, "selling")).length,
    pending: products.filter((product) => matchesProductDisplayTab(product, "pending")).length,
    draft: products.filter((product) => matchesProductDisplayTab(product, "draft")).length,
    skuStats: products.length,
  }), [products]);
  const skuCategoryStats = useMemo(
    () => Object.entries(SKU_CATEGORY_LABELS).map(([key, label]) => ({
      key,
      label,
      value: products.filter((product) => product.sku_category === key).length,
    })),
    [products],
  );
  const skuSubcategoryStats = useMemo(
    () => Object.entries(SKU_SUBCATEGORY_LABELS).map(([key, label]) => ({
      key,
      label,
      value: products.filter((product) => product.sku_subcategory === key).length,
    })).filter((item) => item.value > 0),
    [products],
  );

  function replaceProduct(next: ProductDetail, previousSku = detail?.sku ?? next.sku) {
    if (previousSku && previousSku !== next.sku) detailCacheRef.current.delete(previousSku);
    detailCacheRef.current.set(next.sku, next);
    setProducts((current) => current
      .map((product) => product.sku === previousSku ? next : product)
      .sort((a, b) => a.sku.localeCompare(b.sku)));
    setDetail(next);
    setForm(formFromProduct(next));
    setSelectedSku(next.sku);
  }

  async function updateProduct(
    sku: string,
    payload: Record<string, unknown>,
    successMessage: string,
  ) {
    setSaving(true);
    try {
      const data = await fetchJson<{ product: ProductDetail }>(
        `/api/workspaces/${encodeURIComponent(workspace)}/products/${encodeURIComponent(sku)}`,
        {
          body: JSON.stringify(payload),
          headers: { "content-type": "application/json" },
          method: "PUT",
        },
      );
      replaceProduct(data.product, sku);
      toast.success(successMessage);
      return data.product;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存产品失败");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function createProduct() {
    setSaving(true);
    try {
      const data = await fetchJson<{ product: ProductDetail }>(
        `/api/workspaces/${encodeURIComponent(workspace)}/products`,
        {
          body: JSON.stringify(newProduct),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      setCreateOpen(false);
      setNewProduct({ sku_subcategory: "earrings", name: "" });
      setProducts((current) => [...current, data.product].sort((a, b) => a.sku.localeCompare(b.sku)));
      detailCacheRef.current.set(data.product.sku, data.product);
      selectedSkuRef.current = data.product.sku;
      setSelectedSku(data.product.sku);
      setDetail(data.product);
      setForm(formFromProduct(data.product));
      toast.success("产品已创建");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建产品失败");
    } finally {
      setSaving(false);
    }
  }

  async function saveProduct() {
    if (!detail || !form) return;
    const saved = await updateProduct(
      detail.sku,
      {
        ...form,
        inventory: form.inventory === "" ? null : Number(form.inventory),
      },
      "产品已保存",
    );
    if (saved) setDialogMode(null);
  }

  async function uploadAssets(files: FileList | null) {
    if (!files?.length || !detail) return;
    setUploading(true);
    try {
      let next: ProductDetail | null = null;
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.set("file", file);
        const data = await fetchJson<{ product: ProductDetail }>(
          `/api/workspaces/${encodeURIComponent(workspace)}/products/${encodeURIComponent(detail.sku)}`,
          { body, method: "POST" },
        );
        next = data.product;
      }
      if (next) replaceProduct(next);
      toast.success(`已上传 ${files.length} 个素材`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "上传素材失败");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function deleteAsset() {
    if (!detail || !assetToDelete) return;
    setSaving(true);
    try {
      const params = new URLSearchParams({ path: assetToDelete.relative_path });
      const data = await fetchJson<{ product: ProductDetail }>(
        `/api/workspaces/${encodeURIComponent(workspace)}/products/${encodeURIComponent(detail.sku)}/assets?${params}`,
        { method: "DELETE" },
      );
      replaceProduct(data.product);
      setAssetToDelete(null);
      toast.success("素材已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除素材失败");
    } finally {
      setSaving(false);
    }
  }

  async function deleteCurrentProduct() {
    if (!detail) return;
    setSaving(true);
    try {
      await fetchJson(
        `/api/workspaces/${encodeURIComponent(workspace)}/products/${encodeURIComponent(detail.sku)}`,
        { method: "DELETE" },
      );
      const deletedSku = detail.sku;
      detailCacheRef.current.delete(deletedSku);
      setDeleteProductOpen(false);
      setDetail(null);
      setForm(null);
      await loadProducts(products.find((product) => product.sku !== deletedSku)?.sku ?? null);
      toast.success("产品已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除产品失败");
    } finally {
      setSaving(false);
    }
  }

  function patchForm<Key extends keyof ProductForm>(key: Key, value: ProductForm[Key]) {
    setForm((current) => current ? { ...current, [key]: value } : current);
  }

  function patchPricing<Key extends keyof ProductPricingForm>(
    key: Key,
    value: ProductPricingForm[Key],
  ) {
    setForm((current) => current
      ? { ...current, pricing: { ...current.pricing, [key]: value } }
      : current);
  }

  function selectProduct(sku: string) {
    selectedSkuRef.current = sku;
    setSelectedSku(sku);
  }

  async function openDialogForProduct(sku: string, mode: Exclude<ProductDialogMode, null>) {
    const cached = detailCacheRef.current.get(sku);
    if (cached) {
      selectProduct(sku);
      setDetail(cached);
      setForm(formFromProduct(cached));
      setDialogMode(mode);
      return;
    }

    try {
      const data = await fetchJson<{ product: ProductDetail }>(
        `/api/workspaces/${encodeURIComponent(workspace)}/products/${encodeURIComponent(sku)}`,
      );
      detailCacheRef.current.set(data.product.sku, data.product);
      selectProduct(data.product.sku);
      setDetail(data.product);
      setForm(formFromProduct(data.product));
      setDialogMode(mode);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "产品读取失败");
    }
  }

  function closeDialogMode(open: boolean) {
    if (!open) setDialogMode(null);
  }

  async function delistProduct(sku: string) {
    await updateProduct(
      sku,
      { include_in_external: false, status: "draft" },
      "产品已下架",
    );
  }

  function persistListScroll(scrollTop: number) {
    if (!workspace) return;
    writeStoredValue(productLibraryStorageKey(workspace, "list-scroll-top"), String(scrollTop));
  }

  function toggleProductSearch() {
    if (productSearchOpen) onQueryChange("");
    setProductSearchOpen((open) => !open);
  }

  const activeProduct = detail && detail.sku === selectedSku ? detail : null;
  const activeForm = activeProduct && form ? form : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div
        className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6 [scrollbar-gutter:stable]"
        onScroll={(event) => persistListScroll(event.currentTarget.scrollTop)}
        ref={listRef}
      >
        <div className="mb-4 overflow-x-auto [scrollbar-gutter:stable]">
          <div className="flex min-w-max flex-nowrap items-center gap-3 pr-1">
            <div className="flex shrink-0 flex-nowrap items-center gap-2 whitespace-nowrap">
              {[
                { id: "selling", label: "出售中", count: productTabCounts.selling },
                { id: "pending", label: "待上架", count: productTabCounts.pending },
                { id: "draft", label: "草稿中", count: productTabCounts.draft },
                { id: "sku-stats", label: "SKU统计", count: productTabCounts.skuStats },
              ].map((tab) => {
                const active = displayTab === tab.id;
                return (
                  <button
                    aria-pressed={active}
                    className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    key={tab.id}
                    onClick={() => setDisplayTab(tab.id as ProductDisplayTab)}
                    type="button"
                  >
                    <span>{tab.label}</span>
                    <span className="rounded-md border bg-background/70 px-1.5 py-0.5 text-xs text-muted-foreground">
                      {tab.count}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="ml-auto flex shrink-0 items-center justify-end gap-1">
              <div
                aria-hidden={!productSearchOpen}
                className={`relative overflow-hidden transition-[width,opacity] duration-200 ${productSearchOpen ? "w-44 opacity-100" : "w-0 opacity-0"}`}
              >
                <Input
                  aria-label="搜索 SKU"
                  className="h-8 w-44 rounded-md px-2 text-xs shadow-none"
                  onChange={(event) => onQueryChange(event.target.value)}
                  placeholder="搜索 SKU..."
                  ref={productSearchInputRef}
                  tabIndex={productSearchOpen ? 0 : -1}
                  type="search"
                  value={query}
                />
              </div>
              <Button
                aria-label="搜索 SKU"
                aria-pressed={productSearchOpen}
                className={`size-8 rounded-md p-0 ${productSearchOpen ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
                onClick={toggleProductSearch}
                size="icon"
                title="搜索 SKU"
                type="button"
                variant="ghost"
              >
                {productSearchOpen ? <X className="size-4" aria-hidden="true" /> : <Search className="size-4" aria-hidden="true" />}
              </Button>
              <Button
                aria-label="新增产品"
                className="size-8 rounded-md p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => setCreateOpen(true)}
                size="icon"
                title="新增产品"
                type="button"
                variant="ghost"
              >
                <PackagePlus className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        </div>

        {loading ? <p className="mb-4 text-sm text-muted-foreground">正在加载产品库…</p> : null}
        {!loading && displayTab !== "sku-stats" && filteredProducts.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无匹配产品。</p>
        ) : null}
        {displayTab === "sku-stats" ? (
          <div className="grid gap-4 xl:grid-cols-2">
            <section className="rounded-2xl border bg-card p-4 shadow-sm">
              <div className="mb-4 flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium">主类别统计</h2>
                <span className="text-xs text-muted-foreground">{products.length} 个 SKU</span>
              </div>
              <BarStats items={skuCategoryStats} />
            </section>
            <section className="rounded-2xl border bg-card p-4 shadow-sm">
              <div className="mb-4 flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium">子类别统计</h2>
                <span className="text-xs text-muted-foreground">{skuSubcategoryStats.length} 个子类</span>
              </div>
              <BarStats items={skuSubcategoryStats} />
            </section>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
            {filteredProducts.map((product) => (
              <article className="rounded-2xl border bg-card p-4 shadow-sm" key={product.sku}>
                <div className="flex items-start gap-4">
                  <div className="flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-muted sm:size-28">
                    {product.thumbnail ? (
                      <img
                        alt={product.name ?? product.sku}
                        className="size-full object-cover"
                        loading="lazy"
                        src={thumbnailUrl(workspace, product.thumbnail, {
                          modified_at: product.thumbnail_modified_at,
                          size: product.thumbnail_size,
                        })}
                      />
                    ) : (
                      <FileImage className="size-5 text-muted-foreground" aria-hidden="true" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h2 className="truncate text-base font-semibold">
                          {product.name || "未命名产品"}
                        </h2>
                        <p className="mt-1 font-mono text-xs text-muted-foreground">
                          {product.sku} · {product.sku_subcategory_label ?? SKU_SUBCATEGORY_LABELS[product.sku_subcategory]}
                        </p>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {product.include_in_external ? "在售" : "已下架"}
                      </p>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>{primaryDisplayPrice(product, locale)}</span>
                      <span>库存 {product.inventory ?? "—"}</span>
                      <span>{product.asset_count} 个素材</span>
                    </div>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                  <Button
                    disabled={saving}
                    onClick={() => void openDialogForProduct(product.sku, "price")}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    改价格
                  </Button>
                  <Button
                    disabled={saving}
                    onClick={() => void openDialogForProduct(product.sku, "inventory")}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    改库存
                  </Button>
                  <Button
                    disabled={saving || !product.include_in_external}
                    onClick={() => void delistProduct(product.sku)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    下架
                  </Button>
                  <Button
                    disabled={saving}
                    onClick={() => void openDialogForProduct(product.sku, "edit")}
                    size="sm"
                    type="button"
                  >
                    编辑
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <Dialog open={dialogMode === "price"} onOpenChange={closeDialogMode}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>改价格</DialogTitle>
            <DialogDescription>{selectedSku ?? ""}</DialogDescription>
          </DialogHeader>
          {!activeProduct || !activeForm ? null : (
            <>
              <FieldGroup>
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <FieldLabel>销售价格</FieldLabel>
                    <span className="font-mono text-sm text-muted-foreground">
                      {activeForm.pricing.market} · {activeForm.pricing.currency}
                    </span>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field>
                      <FieldLabel>标价</FieldLabel>
                      <Input inputMode="decimal" min="0" onChange={(event) => patchPricing("list_price", event.target.value)} step="0.01" type="number" value={activeForm.pricing.list_price} />
                    </Field>
                    <Field>
                      <FieldLabel>促销价</FieldLabel>
                      <Input inputMode="decimal" min="0" onChange={(event) => patchPricing("promo_price", event.target.value)} step="0.01" type="number" value={activeForm.pricing.promo_price} />
                    </Field>
                    <Field>
                      <FieldLabel>底价</FieldLabel>
                      <Input inputMode="decimal" min="0" onChange={(event) => patchPricing("floor_price", event.target.value)} step="0.01" type="number" value={activeForm.pricing.floor_price} />
                    </Field>
                  </div>
                </div>
              </FieldGroup>
              <div className="flex justify-end gap-2">
                <Button disabled={saving} onClick={() => setDialogMode(null)} type="button" variant="outline">取消</Button>
                <Button
                  disabled={saving}
                  onClick={async () => {
                    const saved = await updateProduct(
                      activeProduct.sku,
                      { pricing: activeForm.pricing },
                      "价格已更新",
                    );
                    if (saved) setDialogMode(null);
                  }}
                  type="button"
                >
                  保存
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={dialogMode === "inventory"} onOpenChange={closeDialogMode}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>改库存</DialogTitle>
            <DialogDescription>{selectedSku ?? ""}</DialogDescription>
          </DialogHeader>
          {!activeProduct || !activeForm ? null : (
            <>
              <FieldGroup>
                <Field>
                  <FieldLabel>库存</FieldLabel>
                  <Input inputMode="numeric" min="0" onChange={(event) => patchForm("inventory", event.target.value)} type="number" value={activeForm.inventory} />
                </Field>
              </FieldGroup>
              <div className="flex justify-end gap-2">
                <Button disabled={saving} onClick={() => setDialogMode(null)} type="button" variant="outline">取消</Button>
                <Button
                  disabled={saving}
                  onClick={async () => {
                    const saved = await updateProduct(
                      activeProduct.sku,
                      { inventory: activeForm.inventory === "" ? null : Number(activeForm.inventory) },
                      "库存已更新",
                    );
                    if (saved) setDialogMode(null);
                  }}
                  type="button"
                >
                  保存
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={dialogMode === "edit"} onOpenChange={closeDialogMode}>
        <DialogContent className="max-h-[92vh] w-[min(96vw,72rem)] max-w-none overflow-y-auto">
          <DialogHeader>
            <DialogTitle>编辑产品</DialogTitle>
            <DialogDescription>{selectedSku ?? ""}</DialogDescription>
          </DialogHeader>
          {!activeProduct || !activeForm ? null : (
            <div className="space-y-6">
              <FieldGroup>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel>SKU</FieldLabel>
                    <Input disabled spellCheck={false} value={activeForm.sku} />
                  </Field>
                  <Field>
                    <FieldLabel>SKU 子类</FieldLabel>
                    <Select value={activeForm.sku_subcategory} onValueChange={(value) => patchForm("sku_subcategory", value as ProductSkuSubcategory)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(SKU_SUBCATEGORY_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>{label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel>产品名称</FieldLabel>
                    <Input onChange={(event) => patchForm("name", event.target.value)} value={activeForm.name} />
                  </Field>
                  <Field>
                    <FieldLabel>英文名称</FieldLabel>
                    <Input onChange={(event) => patchForm("name_en", event.target.value)} value={activeForm.name_en} />
                  </Field>
                  <div className="flex items-center gap-2 rounded-md border p-3 sm:col-span-2">
                    <FieldLabel className="shrink-0">允许用于对外物料</FieldLabel>
                    <Switch checked={activeForm.include_in_external} onCheckedChange={(value) => patchForm("include_in_external", value)} />
                  </div>
                </div>
                <Field>
                  <FieldLabel>产品描述</FieldLabel>
                  <Textarea onChange={(event) => patchForm("description", event.target.value)} value={activeForm.description} />
                </Field>
                <Field>
                  <FieldLabel>备注</FieldLabel>
                  <Textarea onChange={(event) => patchForm("notes", event.target.value)} value={activeForm.notes} />
                </Field>
              </FieldGroup>

              <section className="rounded-lg border bg-card">
                <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
                  <div>
                    <h3 className="font-medium">原始素材</h3>
                    <p className="mt-1 text-sm text-muted-foreground">上传给图册和视频工作流使用的产品源文件。</p>
                  </div>
                  <input
                    accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml,application/pdf,application/zip,text/plain"
                    className="hidden"
                    multiple
                    onChange={(event) => void uploadAssets(event.target.files)}
                    ref={fileInputRef}
                    type="file"
                  />
                  <Button disabled={saving || uploading} onClick={() => fileInputRef.current?.click()} type="button" variant="outline">
                    <FolderUp data-icon="inline-start" />
                    {uploading ? "上传中…" : "上传素材"}
                  </Button>
                </header>
                {activeProduct.assets.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">尚未上传原始素材。</p>
                ) : (
                  <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
                    {activeProduct.assets.map((asset) => (
                      <article className="group overflow-hidden rounded-md border bg-background" key={asset.relative_path}>
                        <div
                          className={`relative flex h-32 items-center justify-center bg-muted ${asset.kind === "image" ? "cursor-zoom-in" : ""}`}
                          onClick={() => {
                            if (asset.kind !== "image") return;
                            setPreviewAsset(asset);
                          }}
                          role={asset.kind === "image" ? "button" : undefined}
                          tabIndex={asset.kind === "image" ? 0 : undefined}
                          title={asset.kind === "image" ? "单击查看原图" : undefined}
                          onKeyDown={(event) => {
                            if (asset.kind !== "image") return;
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            setPreviewAsset(asset);
                          }}
                        >
                          {asset.kind === "image" ? (
                            <img
                              alt={asset.name}
                              className="pointer-events-none size-full object-contain p-2"
                              loading="lazy"
                              src={assetUrl(workspace, asset.path, asset)}
                            />
                          ) : (
                            <File className="size-6 text-muted-foreground" aria-hidden="true" />
                          )}
                          <Button
                            aria-label={`删除素材 ${asset.name}`}
                            className="absolute right-2 top-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                            disabled={saving || uploading}
                            onClick={(event) => {
                              event.stopPropagation();
                              setAssetToDelete(asset);
                            }}
                            size="icon"
                            title={`删除 ${asset.name}`}
                            type="button"
                            variant="destructive"
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                          </Button>
                        </div>
                        <div className="min-w-0 p-3">
                          <p className="truncate text-sm font-medium" title={asset.name}>{asset.name}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{formatSize(asset.size)}</p>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              <div className="flex justify-between gap-2">
                <Button disabled={saving || uploading} onClick={() => setDeleteProductOpen(true)} type="button" variant="destructive">
                  删除产品
                </Button>
                <div className="flex gap-2">
                  <Button disabled={saving || uploading} onClick={() => setDialogMode(null)} type="button" variant="outline">取消</Button>
                  <Button disabled={saving || uploading} onClick={() => void saveProduct()} type="button">
                    保存
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新增产品</DialogTitle>
            <DialogDescription>系统按 SKU-主类码-子类码-三位流水号自动分配 SKU。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel>SKU 子类</FieldLabel>
              <Select value={newProduct.sku_subcategory} onValueChange={(value) => setNewProduct((current) => ({ ...current, sku_subcategory: value as ProductSkuSubcategory }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(SKU_SUBCATEGORY_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>产品名称</FieldLabel>
              <Input onChange={(event) => setNewProduct((current) => ({ ...current, name: event.target.value }))} value={newProduct.name} />
            </Field>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button disabled={saving} onClick={() => setCreateOpen(false)} type="button" variant="outline">取消</Button>
            <Button disabled={saving} onClick={() => void createProduct()} type="button">
              {saving ? "创建中…" : "创建产品"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteProductOpen} onOpenChange={setDeleteProductOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除产品</DialogTitle>
            <DialogDescription>删除「{detail?.sku}」会同时删除其产品资料和全部素材，且不可恢复。</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button disabled={saving} onClick={() => setDeleteProductOpen(false)} type="button" variant="outline">取消</Button>
            <Button disabled={saving} onClick={() => void deleteCurrentProduct()} type="button" variant="destructive">确认删除</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={assetToDelete !== null} onOpenChange={(open) => !open && setAssetToDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除素材</DialogTitle>
            <DialogDescription>删除「{assetToDelete?.name}」后不可恢复。</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button disabled={saving} onClick={() => setAssetToDelete(null)} type="button" variant="outline">取消</Button>
            <Button disabled={saving} onClick={() => void deleteAsset()} type="button" variant="destructive">确认删除</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={previewAsset !== null} onOpenChange={(open) => !open && setPreviewAsset(null)}>
        <DialogContent className="max-h-[92vh] w-[min(96vw,72rem)] max-w-none gap-3 p-4 sm:p-5">
          <DialogHeader className="pr-8">
            <DialogTitle className="truncate">{previewAsset?.name ?? "素材预览"}</DialogTitle>
            <DialogDescription>
              {previewAsset
                ? `${formatSize(previewAsset.size)} · 原始素材预览`
                : "原始素材预览"}
            </DialogDescription>
          </DialogHeader>
          {previewAsset?.kind === "image" ? (
            <div className="flex max-h-[min(78vh,56rem)] min-h-64 items-center justify-center overflow-auto rounded-md border bg-muted/40 p-2">
              <img
                alt={previewAsset.name}
                className="max-h-[min(76vh,54rem)] max-w-full object-contain"
                src={assetUrl(workspace, previewAsset.path, previewAsset)}
              />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
