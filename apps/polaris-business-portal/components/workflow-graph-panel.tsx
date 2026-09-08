"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/components/i18n-provider";
import {
  buildWorkflowGraphLayout,
  type WorkflowGraphEdge,
  type WorkflowGraphStage,
} from "@/lib/workflow-graph";

type WorkflowGraphPanelWorkflow = {
  id: string;
  stages: Array<{
    depends_on_stage_ids: string[];
    id: string;
    label: string;
    root_path: string;
    status: {
      ready: boolean;
      status: string | null;
    };
    steps: Array<{
      args: string[];
      command: string;
      id: string;
      label: string;
      tool: string;
    }>;
  }>;
  title: string;
};

function stageTone(status: string | null, ready: boolean): {
  badge: string;
  card: string;
  label: string;
} {
  if (status === "running") {
    return {
      badge: "bg-amber-500/10 text-amber-700 border-amber-500/30",
      card: "border-amber-500/30 bg-amber-500/5",
      label: "运行中",
    };
  }
  if (status === "error" || status === "failed") {
    return {
      badge: "bg-rose-500/10 text-rose-700 border-rose-500/30",
      card: "border-rose-500/30 bg-rose-500/5",
      label: "失败",
    };
  }
  if (ready || status === "final" || status === "success" || status === "current") {
    return {
      badge: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30",
      card: "border-emerald-500/30 bg-emerald-500/5",
      label: "就绪",
    };
  }
  if (status === "stale" || status === "incomplete") {
    return {
      badge: "bg-orange-500/10 text-orange-700 border-orange-500/30",
      card: "border-orange-500/30 bg-orange-500/5",
      label: "未完成",
    };
  }
  return {
    badge: "bg-muted text-muted-foreground border-border",
    card: "border-border bg-card",
    label: "待处理",
  };
}

function polylinePath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) {
    return "";
  }
  const [first, ...rest] = points;
  if (!first) {
    return "";
  }
  return `M ${first.x} ${first.y} ${rest.map((point) => `L ${point.x} ${point.y}`).join(" ")}`;
}

function edgeStroke(edge: WorkflowGraphEdge): { color: string; dasharray?: string } {
  if (edge.kind === "dependency") {
    return { color: "#0f766e" };
  }
  return {
    color: edge.inferred ? "#8b7b67" : "#6b7280",
    dasharray: "9 6",
  };
}

function stepArgumentSummary(args: string[], ts: (source: string, values?: Record<string, string | number | boolean>) => string): string {
  const flags = args.filter((value) => value.startsWith("--")).slice(0, 3);
  if (flags.length > 0) {
    const extra = args.length - flags.length;
    return extra > 0 ? `${flags.join(" · ")} · +${extra}` : flags.join(" · ");
  }
  if (args.length === 0) {
    return ts("无参数");
  }
  return ts("{count} 个参数", { count: args.length });
}

function parameterRows(args: string[]): Array<{ label: string; value: string | null }> {
  const rows: Array<{ label: string; value: string | null }> = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current) {
      continue;
    }
    if (!current.startsWith("--")) {
      rows.push({ label: current, value: null });
      continue;
    }

    const values: string[] = [];
    while (index + 1 < args.length && !args[index + 1]!.startsWith("--")) {
      values.push(args[index + 1]!);
      index += 1;
    }
    rows.push({
      label: current,
      value: values.length > 0 ? values.join(" ") : null,
    });
  }

  return rows;
}

export function WorkflowGraphPanel({ workflow }: { workflow: WorkflowGraphPanelWorkflow }) {
  const { ts } = useI18n();
  const reactId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(() => new Set());
  const markerId = useMemo(
    () => `workflow-graph-arrow-${reactId.replaceAll(":", "-")}`,
    [reactId],
  );
  const stages = useMemo<WorkflowGraphStage[]>(
    () => workflow.stages.map((stage) => ({
      depends_on_stage_ids: stage.depends_on_stage_ids,
      id: stage.id,
      label: stage.label,
      root_path: stage.root_path,
      status: stage.status,
      steps: stage.steps,
    })),
    [workflow],
  );

  useEffect(() => {
    setExpandedSteps(new Set());
  }, [workflow.id]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const nextWidth = Math.max(0, Math.floor(entry.contentRect.width));
      setContainerWidth((current) => current === nextWidth ? current : nextWidth);
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const graph = useMemo(
    () => buildWorkflowGraphLayout(stages, {
      maxWidth: containerWidth > 0 ? containerWidth : null,
    }),
    [containerWidth, stages],
  );

  if (stages.length === 0) {
    return (
      <div
        className="flex h-full min-h-0 items-center justify-center rounded-lg border border-dashed p-6 text-sm text-muted-foreground"
        ref={containerRef}
      >
        {ts("当前 workflow 没有可视化阶段。")}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" ref={containerRef}>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-muted/20 [scrollbar-gutter:stable]">
        <div
          className="relative"
          style={{
            height: `${graph.height}px`,
            minHeight: "100%",
            minWidth: `${graph.width}px`,
            width: `${graph.width}px`,
          }}
        >
          <svg
            aria-hidden="true"
            className="absolute inset-0 pointer-events-none"
            height={graph.height}
            width={graph.width}
          >
            <defs>
              <marker
                id={markerId}
                markerHeight="8"
                markerWidth="8"
                orient="auto-start-reverse"
                refX="7"
                refY="4"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
              </marker>
            </defs>
            {graph.edges.map((edge) => {
              const path = polylinePath(edge.points);
              const stroke = edgeStroke(edge);
              return (
                <path
                  d={path}
                  fill="none"
                  key={edge.id}
                  markerEnd={`url(#${markerId})`}
                  stroke={stroke.color}
                  strokeDasharray={stroke.dasharray}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={edge.kind === "dependency" ? 2.5 : 2}
                  style={{ color: stroke.color }}
                />
              );
            })}
          </svg>
          {graph.stages.map((stage) => {
            const tone = stageTone(stage.status.status, stage.status.ready);
            return (
              <section
                className={`absolute flex flex-col overflow-hidden rounded-xl border shadow-sm ${tone.card}`}
                key={stage.id}
                style={{
                  height: `${stage.height}px`,
                  left: `${stage.x}px`,
                  top: `${stage.y}px`,
                  width: `${stage.width}px`,
                }}
              >
                <div className="border-b border-black/5 px-4 py-3">
                  <div className="flex items-start gap-3">
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-background/80 text-xs font-semibold text-foreground shadow-sm">
                      {stage.index + 1}
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate text-sm font-semibold text-foreground">
                          {stage.label}
                        </h3>
                        <Badge className={tone.badge} variant="outline">
                          {ts(tone.label)}
                        </Badge>
                      </div>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {stage.id}
                      </p>
                    </div>
                  </div>
                  {stage.depends_on_stage_ids.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {stage.depends_on_stage_ids.map((dependency) => (
                        <Badge key={`${stage.id}:${dependency}`} variant="secondary">
                          {ts("依赖 {id}", { id: dependency })}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3 [scrollbar-gutter:stable]">
                  {stage.steps.length > 0 ? stage.steps.map((step) => {
                    const expansionKey = `${stage.id}:${step.id}`;
                    const expanded = expandedSteps.has(expansionKey);
                    const rows = parameterRows(step.args);
                    const expandable = rows.length > 0;
                    return (
                      <div
                        className="rounded-lg border bg-background/85 px-3 py-2 shadow-sm"
                        key={step.id}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">
                              {step.id}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              {step.label}
                            </p>
                          </div>
                          <Badge variant="outline">
                            {step.command}
                          </Badge>
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <p className="truncate text-xs text-muted-foreground">
                            {stepArgumentSummary(step.args, ts)}
                          </p>
                          {expandable ? (
                            <button
                              className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                              onClick={() => setExpandedSteps((current) => {
                                const next = new Set(current);
                                if (next.has(expansionKey)) next.delete(expansionKey);
                                else next.add(expansionKey);
                                return next;
                              })}
                              type="button"
                            >
                              {expanded ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}
                              <span>{expanded ? ts("收起参数") : ts("展开参数")}</span>
                            </button>
                          ) : null}
                        </div>
                        {expandable && expanded ? (
                          <div className="mt-3 space-y-2 border-t pt-3">
                            <div className="space-y-1">
                              {rows.length > 0 ? rows.map((row, index) => (
                                <div
                                  className="grid grid-cols-[minmax(0,140px)_1fr] gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-xs"
                                  key={`${step.id}:${row.label}:${index}`}
                                >
                                  <code className="truncate font-mono text-foreground">
                                    {row.label}
                                  </code>
                                  <code className="break-all font-mono text-muted-foreground">
                                    {row.value ?? "—"}
                                  </code>
                                </div>
                              )) : (
                                <div className="rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
                                  {ts("无参数")}
                                </div>
                              )}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  }) : (
                    <div className="rounded-lg border border-dashed bg-background/60 px-3 py-4 text-sm text-muted-foreground">
                      {ts("此阶段没有自动步骤。")}
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
