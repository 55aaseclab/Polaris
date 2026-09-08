"use client";

import { Globe2, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
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
import { wanghaiMutationFetch } from "@/lib/mutation-request";

type TaskStatus = "todo" | "doing" | "done" | "blocked" | "skipped";
type SiteStatus = "planning" | "building" | "live" | "paused" | "archived";

type Progress = {
  total: number;
  done: number;
  doing: number;
  blocked: number;
  percent: number;
};

type SiteSummary = {
  site_id: string;
  name: string;
  primary_domain: string;
  status: SiteStatus;
  locale: string;
  markets: string[];
  progress: Progress;
  ga4_property_id: string | null;
  gsc_site_url: string | null;
  latest_metrics: {
    source: string;
    period_start: string;
    period_end: string;
    totals: {
      sessions: number | null;
      organic_sessions: number | null;
      clicks: number | null;
      impressions: number | null;
    };
  } | null;
  updated_at: string;
};

type TaskRow = {
  id: string;
  section: string;
  section_title: string;
  title: string;
  description: string;
  order: number;
  state: { status: TaskStatus; updated_at: string; note: string | null };
};

type Section = {
  id: string;
  title: string;
  blurb: string;
  tasks: TaskRow[];
};

type SiteDetail = {
  site: {
    site_id: string;
    name: string;
    primary_domain: string;
    status: SiteStatus;
    locale: string;
    markets: string[];
    positioning: {
      icp: string | null;
      one_liner: string | null;
      search_fit: string | null;
    };
    integrations: {
      ga4_property_id: string | null;
      gsc_site_url: string | null;
      clarity_project_id: string | null;
    };
    notes: string[];
  };
  summary: SiteSummary;
  sections: Section[];
  metrics: Array<{
    source: string;
    period_start: string;
    period_end: string;
    captured_at: string;
    totals: Record<string, number | null>;
    notes: string[];
  }>;
  playbook_version: string;
};

const STATUS_LABEL: Record<SiteStatus, string> = {
  planning: "规划中",
  building: "建设中",
  live: "已上线",
  paused: "暂停",
  archived: "归档",
};

const TASK_LABEL: Record<TaskStatus, string> = {
  todo: "待办",
  doing: "进行中",
  done: "完成",
  blocked: "阻塞",
  skipped: "跳过",
};

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
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

export function SeoOpsPanel({ refreshKey, workspace }: { refreshKey: number; workspace: string }) {
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SiteDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    site_id: "",
    name: "",
    primary_domain: "",
    locale: "en",
    markets: "global",
    icp: "",
    one_liner: "",
  });
  const [metricsForm, setMetricsForm] = useState({
    period_start: new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10),
    period_end: new Date().toISOString().slice(0, 10),
    sessions: "",
    organic_sessions: "",
    clicks: "",
    impressions: "",
  });

  const loadSites = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      const body = await apiJson<{ sites: SiteSummary[] }>(
        `/api/workspaces/${encodeURIComponent(workspace)}/seo/sites`,
      );
      setSites(body.sites);
      setSelectedId((current) => {
        if (current && body.sites.some((site) => site.site_id === current)) return current;
        return body.sites[0]?.site_id ?? null;
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  const loadDetail = useCallback(
    async (siteId: string) => {
      setDetailLoading(true);
      try {
        const body = await apiJson<SiteDetail>(
          `/api/workspaces/${encodeURIComponent(workspace)}/seo/sites/${encodeURIComponent(siteId)}`,
        );
        setDetail(body);
      } catch (reason) {
        toast.error(reason instanceof Error ? reason.message : String(reason));
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [workspace],
  );

  useEffect(() => {
    void loadSites();
  }, [loadSites, refreshKey]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  const selected = useMemo(
    () => sites.find((site) => site.site_id === selectedId) ?? null,
    [selectedId, sites],
  );

  async function createSite() {
    try {
      const body = await apiJson<{ site: SiteSummary }>(
        `/api/workspaces/${encodeURIComponent(workspace)}/seo/sites`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            site_id: createForm.site_id.trim(),
            name: createForm.name.trim(),
            primary_domain: createForm.primary_domain.trim(),
            locale: createForm.locale,
            markets: createForm.markets.split(/[,，\s]+/).filter(Boolean),
            icp: createForm.icp.trim() || null,
            one_liner: createForm.one_liner.trim() || null,
          }),
        },
      );
      toast.success(`已创建站点 ${body.site.site_id}`);
      setCreateOpen(false);
      setCreateForm({
        site_id: "",
        name: "",
        primary_domain: "",
        locale: "en",
        markets: "global",
        icp: "",
        one_liner: "",
      });
      await loadSites();
      setSelectedId(body.site.site_id);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function updateTask(taskId: string, status: TaskStatus) {
    if (!selectedId) return;
    try {
      const body = await apiJson<SiteDetail>(
        `/api/workspaces/${encodeURIComponent(workspace)}/seo/sites/${encodeURIComponent(selectedId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task_id: taskId, task_status: status }),
        },
      );
      setDetail(body);
      await loadSites();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function saveSiteMeta(patch: Record<string, unknown>) {
    if (!selectedId) return;
    try {
      const body = await apiJson<SiteDetail>(
        `/api/workspaces/${encodeURIComponent(workspace)}/seo/sites/${encodeURIComponent(selectedId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      setDetail(body);
      await loadSites();
      toast.success("已保存");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function saveManualMetrics() {
    if (!selectedId) return;
    try {
      await apiJson(
        `/api/workspaces/${encodeURIComponent(workspace)}/seo/sites/${encodeURIComponent(selectedId)}/metrics`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            period_start: metricsForm.period_start,
            period_end: metricsForm.period_end,
            totals: {
              sessions: metricsForm.sessions || null,
              organic_sessions: metricsForm.organic_sessions || null,
              clicks: metricsForm.clicks || null,
              impressions: metricsForm.impressions || null,
            },
          }),
        },
      );
      toast.success("指标已记录");
      setMetricsOpen(false);
      await loadDetail(selectedId);
      await loadSites();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function syncGa4() {
    if (!selectedId) return;
    try {
      await apiJson(
        `/api/workspaces/${encodeURIComponent(workspace)}/seo/sites/${encodeURIComponent(selectedId)}/metrics`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "sync_ga4" }),
        },
      );
      toast.message("已写入 GA4 占位快照（v1 需配置 API 后才有真数）");
      await loadDetail(selectedId);
      await loadSites();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-end justify-between gap-3 border-b bg-card px-4 py-4 md:px-6">
        <div>
          <p className="text-sm text-muted-foreground">资产库 · 长期运营</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">SEO 运营</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            多站点 playbook（基石 / 基建 / 内容 / 外链 / 高级），指标可手工录入或后续接 GA4。
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void loadSites()}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            刷新
          </Button>
          <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" aria-hidden="true" />
            新建站点
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(16rem,0.75fr)_minmax(0,1.5fr)]">
        <aside className="min-h-0 overflow-y-auto border-b bg-card/40 p-2 [scrollbar-gutter:stable] lg:border-b-0 lg:border-r">
          {loading ? <p className="p-3 text-sm text-muted-foreground">加载站点…</p> : null}
          {error ? <p className="p-3 text-sm text-destructive">{error}</p> : null}
          {!loading && !error && sites.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              还没有网站资产。先建 1–3 个站点，例如 product-a、docs-b、blog-c。
            </p>
          ) : null}
          <div className="space-y-1">
            {sites.map((site) => {
              const active = site.site_id === selectedId;
              return (
                <button
                  key={site.site_id}
                  type="button"
                  className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${active ? "border-primary bg-accent" : "border-transparent hover:bg-accent/60"}`}
                  onClick={() => setSelectedId(site.site_id)}
                >
                  <div className="flex items-center gap-2">
                    <Globe2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate text-sm font-medium">{site.name}</span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{site.primary_domain}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    <Badge variant="outline">{STATUS_LABEL[site.status]}</Badge>
                    <Badge variant="secondary">{site.progress.percent}%</Badge>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <main className="min-h-0 overflow-y-auto p-4 md:p-6">
          {!selected ? (
            <p className="text-sm text-muted-foreground">选择或创建一个站点。</p>
          ) : detailLoading && !detail ? (
            <p className="text-sm text-muted-foreground">加载详情…</p>
          ) : detail ? (
            <div className="space-y-6">
              <section className="rounded-lg border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">{detail.site.name}</h2>
                    <p className="text-sm text-muted-foreground">{detail.site.primary_domain}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      playbook {detail.playbook_version} · 进度 {detail.summary.progress.done}/
                      {detail.summary.progress.total}
                    </p>
                  </div>
                  <Select
                    value={detail.site.status}
                    onValueChange={(value) => void saveSiteMeta({ status: value })}
                  >
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(STATUS_LABEL) as SiteStatus[]).map((status) => (
                        <SelectItem key={status} value={status}>
                          {STATUS_LABEL[status]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <div className="rounded-md border bg-background p-3">
                    <p className="text-xs text-muted-foreground">Sessions</p>
                    <p className="text-xl font-semibold tabular-nums">
                      {detail.summary.latest_metrics?.totals.sessions ?? "—"}
                    </p>
                  </div>
                  <div className="rounded-md border bg-background p-3">
                    <p className="text-xs text-muted-foreground">Organic</p>
                    <p className="text-xl font-semibold tabular-nums">
                      {detail.summary.latest_metrics?.totals.organic_sessions ?? "—"}
                    </p>
                  </div>
                  <div className="rounded-md border bg-background p-3">
                    <p className="text-xs text-muted-foreground">GSC clicks</p>
                    <p className="text-xl font-semibold tabular-nums">
                      {detail.summary.latest_metrics?.totals.clicks ?? "—"}
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => setMetricsOpen(true)}>
                    录入指标
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => void syncGa4()}>
                    同步 GA4（占位）
                  </Button>
                </div>
              </section>

              <section className="rounded-lg border bg-card p-4">
                <h3 className="font-medium">定位</h3>
                <FieldGroup className="mt-3 grid gap-3 md:grid-cols-1">
                  <Field>
                    <FieldLabel>ICP</FieldLabel>
                    <Textarea
                      defaultValue={detail.site.positioning.icp ?? ""}
                      rows={2}
                      onBlur={(event) =>
                        void saveSiteMeta({
                          positioning: {
                            ...detail.site.positioning,
                            icp: event.target.value.trim() || null,
                          },
                        })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel>一句话价值主张</FieldLabel>
                    <Input
                      defaultValue={detail.site.positioning.one_liner ?? ""}
                      onBlur={(event) =>
                        void saveSiteMeta({
                          positioning: {
                            ...detail.site.positioning,
                            one_liner: event.target.value.trim() || null,
                          },
                        })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel>GA4 property id</FieldLabel>
                    <Input
                      defaultValue={detail.site.integrations.ga4_property_id ?? ""}
                      placeholder="properties/123456"
                      onBlur={(event) =>
                        void saveSiteMeta({
                          integrations: {
                            ...detail.site.integrations,
                            ga4_property_id: event.target.value.trim() || null,
                          },
                        })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Search Console site URL</FieldLabel>
                    <Input
                      defaultValue={detail.site.integrations.gsc_site_url ?? ""}
                      placeholder="https://example.com/"
                      onBlur={(event) =>
                        void saveSiteMeta({
                          integrations: {
                            ...detail.site.integrations,
                            gsc_site_url: event.target.value.trim() || null,
                          },
                        })
                      }
                    />
                  </Field>
                </FieldGroup>
              </section>

              {detail.sections.map((section) => (
                <section key={section.id} className="rounded-lg border bg-card p-4">
                  <h3 className="font-medium">{section.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{section.blurb}</p>
                  <ul className="mt-3 space-y-2">
                    {section.tasks.map((task) => (
                      <li
                        key={task.id}
                        className="flex flex-col gap-2 rounded-md border bg-background p-3 sm:flex-row sm:items-start sm:justify-between"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{task.title}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">{task.description}</p>
                        </div>
                        <Select
                          value={task.state.status}
                          onValueChange={(value) => void updateTask(task.id, value as TaskStatus)}
                        >
                          <SelectTrigger className="w-28 shrink-0">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(Object.keys(TASK_LABEL) as TaskStatus[]).map((status) => (
                              <SelectItem key={status} value={status}>
                                {TASK_LABEL[status]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}

              {detail.metrics.length > 0 ? (
                <section className="rounded-lg border bg-card p-4">
                  <h3 className="font-medium">指标快照</h3>
                  <ul className="mt-2 space-y-2 text-sm">
                    {detail.metrics.map((item) => (
                      <li key={`${item.captured_at}-${item.source}`} className="rounded-md border p-2">
                        <span className="font-medium">{item.source}</span>{" "}
                        <span className="text-muted-foreground">
                          {item.period_start} → {item.period_end}
                        </span>
                        <div className="mt-1 text-xs text-muted-foreground">
                          sessions {item.totals.sessions ?? "—"} · organic{" "}
                          {item.totals.organic_sessions ?? "—"} · clicks {item.totals.clicks ?? "—"}
                        </div>
                        {item.notes?.length ? (
                          <p className="mt-1 text-xs text-muted-foreground">{item.notes.join(" · ")}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          ) : null}
        </main>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建 SEO 站点</DialogTitle>
            <DialogDescription>每个站点是长期资产，建议 1–3 个主站先跑通 playbook。</DialogDescription>
          </DialogHeader>
          <FieldGroup className="grid gap-3">
            <Field>
              <FieldLabel>site_id</FieldLabel>
              <Input
                value={createForm.site_id}
                placeholder="product-site"
                onChange={(event) => setCreateForm((f) => ({ ...f, site_id: event.target.value }))}
              />
            </Field>
            <Field>
              <FieldLabel>名称</FieldLabel>
              <Input
                value={createForm.name}
                onChange={(event) => setCreateForm((f) => ({ ...f, name: event.target.value }))}
              />
            </Field>
            <Field>
              <FieldLabel>主域名</FieldLabel>
              <Input
                value={createForm.primary_domain}
                placeholder="www.example.com"
                onChange={(event) =>
                  setCreateForm((f) => ({ ...f, primary_domain: event.target.value }))
                }
              />
            </Field>
            <Field>
              <FieldLabel>市场（逗号分隔）</FieldLabel>
              <Input
                value={createForm.markets}
                onChange={(event) => setCreateForm((f) => ({ ...f, markets: event.target.value }))}
              />
            </Field>
            <Field>
              <FieldLabel>ICP（可选）</FieldLabel>
              <Textarea
                value={createForm.icp}
                rows={2}
                onChange={(event) => setCreateForm((f) => ({ ...f, icp: event.target.value }))}
              />
            </Field>
          </FieldGroup>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button type="button" onClick={() => void createSite()}>
              创建
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={metricsOpen} onOpenChange={setMetricsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>手工录入指标</DialogTitle>
            <DialogDescription>可先手填；GA4 API 接通后用「同步 GA4」替换。</DialogDescription>
          </DialogHeader>
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel>开始</FieldLabel>
              <Input
                type="date"
                value={metricsForm.period_start}
                onChange={(event) =>
                  setMetricsForm((f) => ({ ...f, period_start: event.target.value }))
                }
              />
            </Field>
            <Field>
              <FieldLabel>结束</FieldLabel>
              <Input
                type="date"
                value={metricsForm.period_end}
                onChange={(event) =>
                  setMetricsForm((f) => ({ ...f, period_end: event.target.value }))
                }
              />
            </Field>
            <Field>
              <FieldLabel>Sessions</FieldLabel>
              <Input
                value={metricsForm.sessions}
                onChange={(event) => setMetricsForm((f) => ({ ...f, sessions: event.target.value }))}
              />
            </Field>
            <Field>
              <FieldLabel>Organic sessions</FieldLabel>
              <Input
                value={metricsForm.organic_sessions}
                onChange={(event) =>
                  setMetricsForm((f) => ({ ...f, organic_sessions: event.target.value }))
                }
              />
            </Field>
            <Field>
              <FieldLabel>GSC clicks</FieldLabel>
              <Input
                value={metricsForm.clicks}
                onChange={(event) => setMetricsForm((f) => ({ ...f, clicks: event.target.value }))}
              />
            </Field>
            <Field>
              <FieldLabel>Impressions</FieldLabel>
              <Input
                value={metricsForm.impressions}
                onChange={(event) =>
                  setMetricsForm((f) => ({ ...f, impressions: event.target.value }))
                }
              />
            </Field>
          </FieldGroup>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setMetricsOpen(false)}>
              取消
            </Button>
            <Button type="button" onClick={() => void saveManualMetrics()}>
              保存
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
