"use client";

import {
  AlertCircle,
  BookOpen,
  FileText,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { wanghaiMutationFetch } from "@/lib/mutation-request";

type WorkflowAsset = {
  kind: "data" | "document" | "image" | "pdf";
  modified_at: string;
  name: string;
  path: string;
  size: number;
};

type WorkflowStageStatus = {
  artifact: string | null;
  facts: Array<{ label: string; value: string }>;
  modified_at: string | null;
  ready: boolean;
  size: number | null;
  status: string | null;
};

type WorkflowStage = {
  id: string;
  label: string;
  outputs: WorkflowAsset[];
  status: WorkflowStageStatus;
};

type LiteratureReviewWorkflow = {
  category: string;
  description: string;
  id: string;
  last_run: {
    finished_at: string | null;
    started_at: string | null;
    status: string;
  } | null;
  pipeline_status: "current" | "stale" | "incomplete" | "unknown";
  stages: WorkflowStage[];
  template_id: string | null;
  title: string;
};

type WorkflowResponse = {
  workflows: LiteratureReviewWorkflow[];
};

const workflowResultCache = new Map<string, LiteratureReviewWorkflow>();
const workflowResultOrderCache = new Map<string, string[]>();

function workflowCacheKey(workspace: string, workflowId: string): string {
  return `${workspace}:${workflowId}`;
}

function readCachedWorkflowResults(workspace: string): LiteratureReviewWorkflow[] {
  return (workflowResultOrderCache.get(workspace) ?? []).flatMap((workflowId) => {
    const workflow = workflowResultCache.get(workflowCacheKey(workspace, workflowId));
    return workflow ? [workflow] : [];
  });
}

function cacheWorkflowResults(workspace: string, workflows: LiteratureReviewWorkflow[]): void {
  const nextIds = workflows.map((workflow) => workflow.id);
  const nextIdSet = new Set(nextIds);
  for (const workflowId of workflowResultOrderCache.get(workspace) ?? []) {
    if (!nextIdSet.has(workflowId)) workflowResultCache.delete(workflowCacheKey(workspace, workflowId));
  }
  for (const workflow of workflows) {
    workflowResultCache.set(workflowCacheKey(workspace, workflow.id), workflow);
  }
  workflowResultOrderCache.set(workspace, nextIds);
}

function cacheWorkflowResult(workspace: string, workflow: LiteratureReviewWorkflow): void {
  workflowResultCache.set(workflowCacheKey(workspace, workflow.id), workflow);
  const currentIds = workflowResultOrderCache.get(workspace) ?? [];
  if (!currentIds.includes(workflow.id)) {
    workflowResultOrderCache.set(workspace, [...currentIds, workflow.id]);
  }
}

type StatusFilter = "all" | "current" | "running" | "incomplete" | "failed";

const STATUS_FILTER_OPTIONS: Array<{ label: string; value: StatusFilter }> = [
  { label: "全部状态", value: "all" },
  { label: "已完成", value: "current" },
  { label: "进行中", value: "running" },
  { label: "待处理", value: "incomplete" },
  { label: "失败", value: "failed" },
];

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await wanghaiMutationFetch(url, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof body?.error === "string" ? body.error : `请求失败：${response.status}`);
  }
  return body as T;
}

function workflowState(workflow: LiteratureReviewWorkflow): StatusFilter {
  const stageStatuses = workflow.stages.map((stage) => stage.status.status?.toLowerCase());
  if (workflow.last_run?.status === "running" || stageStatuses.includes("running")) {
    return "running";
  }
  if (workflow.last_run?.status === "failed" || stageStatuses.some((status) => status === "failed" || status === "error")) {
    return "failed";
  }
  return workflow.pipeline_status === "current" ? "current" : "incomplete";
}

function workflowStateLabel(workflow: LiteratureReviewWorkflow): string {
  const state = workflowState(workflow);
  if (state === "current") return "已完成";
  if (state === "running") return "进行中";
  if (state === "failed") return "失败";
  return "待处理";
}

function workflowStateBadge(workflow: LiteratureReviewWorkflow): "secondary" | "outline" {
  return workflowState(workflow) === "current" ? "secondary" : "outline";
}

function reportAssets(workflow: LiteratureReviewWorkflow): WorkflowAsset[] {
  const reportStage = workflow.stages.find((stage) => stage.id === "report-writing");
  if (!reportStage) return [];
  const report = reportStage.outputs.find((asset) => asset.name === "report.pdf");
  return report ? [report] : [];
}

function assetLabel(asset: WorkflowAsset): string {
  if (asset.name === "report.pdf") return "报告 PDF";
  return asset.name;
}

function ReviewRow({
  editLabel,
  onModify,
  onOpenAsset,
  workflow,
}: {
  editLabel: string;
  onModify: (workflowId: string) => void;
  onOpenAsset: (assetPath: string) => void;
  workflow: LiteratureReviewWorkflow;
}) {
  const assets = reportAssets(workflow);
  const title = workflow.title || workflow.id;
  const description = workflow.description.trim();

  return (
    <article className="border-b px-4 py-4 last:border-b-0 md:px-5 md:py-5">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(12rem,auto)_auto_auto] md:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <BookOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <h3 className="min-w-0 truncate text-sm font-semibold" title={title}>{title}</h3>
          </div>
          {title !== workflow.id ? <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{workflow.id}</p> : null}
          {description ? <p className="mt-2 line-clamp-2 text-sm leading-5 text-muted-foreground">{description}</p> : null}
        </div>

        <div className="min-w-0 text-sm text-muted-foreground md:text-right">
          <div className="flex flex-wrap gap-2 md:justify-end">
            {assets.length > 0 ? assets.map((asset) => (
              <Button
                aria-label={`${assetLabel(asset)} · ${workflow.id}`}
                key={asset.path}
                onClick={() => onOpenAsset(asset.path)}
                size="sm"
                type="button"
                variant="default"
              >
                <FileText className="size-3.5" aria-hidden="true" />
                {assetLabel(asset)}
              </Button>
            )) : <span className="text-xs">暂无报告</span>}
          </div>
        </div>

        <Badge className="w-fit" variant={workflowStateBadge(workflow)}>{workflowStateLabel(workflow)}</Badge>

        <Button
          aria-label={`${editLabel} · ${workflow.id}`}
          onClick={() => onModify(workflow.id)}
          size="sm"
          type="button"
          variant="outline"
        >
          <Pencil className="size-3.5" aria-hidden="true" />
          {editLabel}
        </Button>
      </div>
    </article>
  );
}

function ReviewList({
  editLabel,
  onModify,
  onOpenAsset,
  workflows,
}: {
  editLabel: string;
  onModify: (workflowId: string) => void;
  onOpenAsset: (assetPath: string) => void;
  workflows: LiteratureReviewWorkflow[];
}) {
  if (workflows.length === 0) {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center gap-3 px-5 py-10 text-center">
        <BookOpen className="size-7 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">没有匹配的综述结果</p>
      </div>
    );
  }

  return (
    <div className="divide-y-0">
      {workflows.map((workflow) => (
        <ReviewRow
          editLabel={editLabel}
          key={workflow.id}
          onModify={onModify}
          onOpenAsset={onOpenAsset}
          workflow={workflow}
        />
      ))}
    </div>
  );
}

export function LiteratureReviewPanel({
  onOpenAsset,
  onModify,
  workspace,
}: {
  onOpenAsset: (assetPath: string) => void;
  onModify: (workflowId: string) => void;
  workspace: string;
}) {
  const [workflows, setWorkflows] = useState<LiteratureReviewWorkflow[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadReviews = useCallback(async () => {
    if (!workspace) return;
    const cachedWorkflows = readCachedWorkflowResults(workspace);
    const hasCachedResults = workflowResultOrderCache.has(workspace);
    if (hasCachedResults) {
      setWorkflows(cachedWorkflows.filter((workflow) => (
        workflow.category === "literature-review" || workflow.template_id === "literature-review"
      )));
    }
    setLoading(!hasCachedResults);
    setRefreshing(true);
    setLoadError(null);
    try {
      const workflowData = await fetchJson<WorkflowResponse>(
        `/api/workspaces/${encodeURIComponent(workspace)}/workflows?include_files=false`,
      );
      const nextWorkflows = workflowData.workflows ?? [];
      cacheWorkflowResults(workspace, nextWorkflows);
      setWorkflows(nextWorkflows.filter((workflow) => (
        workflow.category === "literature-review" || workflow.template_id === "literature-review"
      )));
    } catch (error) {
      const message = error instanceof Error ? error.message : "文献综述数据加载失败";
      if (hasCachedResults) toast.error(message);
      else setLoadError(message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [workspace]);

  useEffect(() => {
    setQuery("");
    setStatusFilter("all");
    setWorkflows([]);
    void loadReviews();
  }, [loadReviews]);

  const filteredWorkflows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return workflows.filter((workflow) => {
      const matchesStatus = statusFilter === "all" || workflowState(workflow) === statusFilter;
      const matchesQuery = !needle || [workflow.id, workflow.title, workflow.description].join(" ").toLocaleLowerCase().includes(needle);
      return matchesStatus && matchesQuery;
    });
  }, [query, statusFilter, workflows]);

  async function createReview() {
    setCreating(true);
    try {
      const result = await fetchJson<{ workflow: LiteratureReviewWorkflow }>(
        `/api/workspaces/${encodeURIComponent(workspace)}/workflows`,
        {
          body: JSON.stringify({ template_id: "literature-review" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      cacheWorkflowResult(workspace, result.workflow);
      setWorkflows((current) => [result.workflow, ...current.filter((item) => item.id !== result.workflow.id)]);
      toast.success("已创建综述");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建综述失败");
    } finally {
      setCreating(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        正在读取综述结果…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="m-4 flex items-start gap-3 border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p>{loadError}</p>
          <Button className="mt-3" onClick={() => void loadReviews()} size="sm" type="button" variant="outline">
            <RefreshCw className="size-3.5" aria-hidden="true" />
            重试
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-7xl">
          <section className="border bg-card">
            <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3 md:px-5">
              <div className="mr-auto flex items-center gap-2 text-sm">
                <span className="font-medium">{filteredWorkflows.length} 条结果</span>
                {filteredWorkflows.length !== workflows.length ? <span className="text-muted-foreground">/ {workflows.length}</span> : null}
              </div>
              <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-2 sm:w-auto sm:flex-nowrap">
                <Button className="shrink-0" disabled={creating} onClick={createReview} size="sm" type="button">
                  <Plus className="size-4" aria-hidden="true" />
                  {creating ? "创建中…" : "新建综述"}
                </Button>
                <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
                  <SelectTrigger aria-label="筛选综述状态" className="h-8 w-32 shrink-0 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_FILTER_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <div className="relative min-w-0 flex-1 basis-40 sm:w-48 sm:flex-none sm:basis-auto">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input aria-label="搜索文献综述" className="h-8 pl-8 text-sm" onChange={(event) => setQuery(event.target.value)} placeholder="搜索综述" type="search" value={query} />
                </div>
                <Button aria-label="刷新结果" className="shrink-0" disabled={refreshing} onClick={() => void loadReviews()} size="icon" title="刷新结果" type="button" variant="ghost">
                  <RefreshCw className={`size-4 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden="true" />
                </Button>
              </div>
            </div>
            <ReviewList
              editLabel="修改综述"
              onModify={onModify}
              onOpenAsset={onOpenAsset}
              workflows={filteredWorkflows}
            />
          </section>
        </div>
      </main>
    </div>
  );
}
