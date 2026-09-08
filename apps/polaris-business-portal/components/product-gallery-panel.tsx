"use client";

import { Download, ExternalLink, FileText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { wanghaiPath } from "@/lib/paths";

type CatalogPdf = {
  modified_at: string;
  path: string;
  size: number;
};

type ProductCatalog = {
  catalog_id: string;
  generated_at: string;
  locale: string | null;
  market: string | null;
  pdf: CatalogPdf;
  products_included: number;
  products_skipped: number;
  status: string;
  subtitle: string | null;
  title: string;
};

function assetUrl(workspace: string, asset: CatalogPdf) {
  const encodedPath = asset.path.split("/").map((part) => encodeURIComponent(part)).join("/");
  const version = `&v=${encodeURIComponent(asset.modified_at)}&s=${asset.size}`;
  return wanghaiPath(`/api/workspaces/${encodeURIComponent(workspace)}/assets?path=${encodedPath}${version}`);
}

function formatWhen(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

async function fetchCatalogs(workspace: string): Promise<ProductCatalog[]> {
  const response = await fetch(wanghaiPath(`/api/workspaces/${encodeURIComponent(workspace)}/catalogs`), {
    cache: "no-store",
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof body?.error === "string" ? body.error : `请求失败：${response.status}`);
  }
  return Array.isArray(body?.catalogs) ? body.catalogs as ProductCatalog[] : [];
}

export function ProductGalleryPanel({ refreshKey, workspace }: {
  refreshKey: number;
  workspace: string;
}) {
  const { formatDateTime, locale, t } = useI18n();
  const selectedIdRef = useRef<string | null>(null);
  const handledRefreshKeyRef = useRef(refreshKey);
  const [catalogs, setCatalogs] = useState<ProductCatalog[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loadCatalogs = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchCatalogs(workspace);
      setCatalogs(next);
      const selected = selectedIdRef.current;
      const nextSelected = selected && next.some((catalog) => catalog.catalog_id === selected)
        ? selected
        : next[0]?.catalog_id ?? null;
      selectedIdRef.current = nextSelected;
      setSelectedId(nextSelected);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  useEffect(() => {
    selectedIdRef.current = null;
    setCatalogs([]);
    setSelectedId(null);
    void loadCatalogs();
  }, [loadCatalogs]);

  useEffect(() => {
    if (refreshKey === handledRefreshKeyRef.current) return;
    handledRefreshKeyRef.current = refreshKey;
    void loadCatalogs();
  }, [loadCatalogs, refreshKey]);

  const selected = catalogs.find((catalog) => catalog.catalog_id === selectedId) ?? null;
  const pdfUrl = selected ? assetUrl(workspace, selected.pdf) : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b bg-card px-4 py-4 md:px-6">
        <p className="text-sm text-muted-foreground">{t("productGallery.headerLabel", undefined, "产品管理")}</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{t("productGallery.title", undefined, "产品图册")}</h1>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(17rem,0.8fr)_minmax(0,1.4fr)]">
        <aside className="min-h-0 overflow-y-auto border-b bg-card/40 p-2 [scrollbar-gutter:stable] lg:border-b-0 lg:border-r">
          {loading ? <p className="p-3 text-sm text-muted-foreground">{t("productGallery.loading", undefined, "正在加载产品图册…")}</p> : null}
          {error ? <p className="p-3 text-sm text-destructive">{t("productGallery.loadFailed", { error }, `加载失败：${error}`)}</p> : null}
          {!loading && !error && catalogs.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">{t("productGallery.empty", undefined, "尚未生成产品图册。")}</p>
          ) : null}
          <div className="space-y-1">
            {catalogs.map((catalog) => {
              const selectedCatalog = catalog.catalog_id === selectedId;
              return (
                <button
                  aria-current={selectedCatalog ? "true" : undefined}
                  className={`flex w-full items-start gap-3 rounded-md p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selectedCatalog ? "bg-accent" : "hover:bg-muted"}`}
                  key={catalog.catalog_id}
                  onClick={() => {
                    selectedIdRef.current = catalog.catalog_id;
                    setSelectedId(catalog.catalog_id);
                  }}
                  type="button"
                >
                  <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{catalog.title}</span>
                    <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                      {catalog.catalog_id}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {`${t("productGallery.productCount", { count: catalog.products_included }, `${catalog.products_included} 个产品`)} · ${formatDateTime(catalog.generated_at, {
                        year: "numeric",
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })}`}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="flex min-h-0 flex-col bg-background">
          {!loading && !selected ? (
            <div className="flex h-full min-h-72 items-center justify-center p-6 text-center text-sm text-muted-foreground">
              {t("productGallery.selectPrompt", undefined, "从左侧选择一个产品图册。")}
            </div>
          ) : null}
          {selected && pdfUrl ? (
            <>
              <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b bg-card px-4 py-3 md:px-6">
                <div className="min-w-0">
                  <h2 className="truncate font-medium">{selected.title}</h2>
                  {selected.subtitle ? <p className="mt-1 truncate text-sm text-muted-foreground">{selected.subtitle}</p> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button asChild size="sm" type="button" variant="outline">
                    <a href={pdfUrl} rel="noreferrer" target="_blank">
                      <ExternalLink data-icon="inline-start" />
                      {t("productGallery.openInNewWindow", undefined, "新窗口打开")}
                    </a>
                  </Button>
                  <Button asChild size="sm" type="button" variant="outline">
                    <a download href={pdfUrl}>
                      <Download data-icon="inline-start" />
                      {t("productGallery.download", undefined, "下载")}
                    </a>
                  </Button>
                </div>
              </header>
              <iframe
                className="min-h-0 w-full flex-1 border-0 bg-card"
                key={`${selected.pdf.path}:${selected.pdf.modified_at}:${selected.pdf.size}`}
                src={pdfUrl}
                title={selected.title}
              />
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
