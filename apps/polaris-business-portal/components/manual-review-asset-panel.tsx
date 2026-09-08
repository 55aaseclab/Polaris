"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  ExternalLink,
  FileCheck2,
  FileOutput,
  RefreshCw,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { wanghaiMutationFetch } from "@/lib/mutation-request";
import { wanghaiPath } from "@/lib/paths";

type JsonObject = Record<string, unknown>;
type ReviewStatus = "pending" | "approved" | "rejected";

type ReviewDecision = {
  note: string;
  status: ReviewStatus;
  updated_at: string | null;
};

const PAGE_SIZE = 50;

type ManualReviewData = {
  asset_path: string;
  can_complete_analysis: boolean;
  collection_id?: string;
  generated_at?: string;
  kind: "collection" | "generic";
  read_only: boolean;
  review_kind?: string;
  review_mode: string | null;
  review_records: JsonObject[];
  review_set_id?: string;
  reviews: Record<string, ReviewDecision>;
  summary: Record<string, number>;
  qualified_without_manual_review?: JsonObject[];
  rejected_records?: JsonObject[];
};

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function asObjects(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function text(value: unknown, fallback = "") {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number") return String(value);
  return fallback;
}

function recordPayload(record: JsonObject) {
  const payload = asObject(record.payload);
  const legacy = asObject(payload.legacy_customer_record);
  if (Object.keys(legacy).length > 0) return legacy;
  const customerLead = asObject(payload.customer_lead);
  return Object.keys(customerLead).length > 0 ? customerLead : payload;
}

function recordId(record: JsonObject) {
  return text(record.record_id, text(record.id, "record"));
}

function recordTitle(record: JsonObject) {
  const payload = recordPayload(record);
  return text(
    record.title,
    text(
      payload.company_name,
      text(payload.name, text(payload.title, text(record.record_id, "未命名复核记录"))),
    ),
  );
}

function recordSummary(record: JsonObject) {
  const payload = recordPayload(record);
  const qualification = asObject(payload.qualification);
  const rejectionReasons = asStrings(record.rejection_reasons);
  return text(
    record.summary,
    text(
      qualification.rationale,
      text(
        payload.summary,
        text(rejectionReasons.join("；"), text(record.source_url, "没有摘要或来源说明。")),
      ),
    ),
  );
}

function reviewStatusLabel(status: ReviewStatus) {
  return {
    approved: "已通过",
    pending: "待复核",
    rejected: "不通过",
  }[status];
}

function statusVariant(status: ReviewStatus) {
  if (status === "rejected") return "destructive" as const;
  return status === "approved" ? "secondary" as const : "outline" as const;
}

function isReviewStatus(value: string): value is ReviewStatus {
  return value === "pending" || value === "approved" || value === "rejected";
}

function reviewUrl(workspace: string, assetPath: string) {
  return wanghaiPath(`/api/workspaces/${encodeURIComponent(workspace)}/manual-review?path=${assetPath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`);
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await wanghaiMutationFetch(url, {
    ...init,
    cache: "no-store",
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      typeof (body as { error?: unknown } | null)?.error === "string"
        ? (body as { error: string }).error
        : `请求失败：${response.status}`,
    );
  }
  return body as T;
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-background p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function ExternalLinkValue({ value }: { value: unknown }) {
  const url = text(value);
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return <span>{url || "未提供"}</span>;
  return (
    <a
      className="inline-flex break-all text-primary underline-offset-4 hover:underline"
      href={url}
      rel="noreferrer"
      target="_blank"
    >
      {url}
      <ExternalLink className="ml-1 mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
    </a>
  );
}

function RecordDetails({ record }: { record: JsonObject }) {
  const payload = recordPayload(record);
  const qualification = asObject(payload.qualification);
  const directEvidence = asObjects(record.evidence);
  const sourceTrace = asObjects(payload.source_trace);
  const evidence = directEvidence.length > 0 ? directEvidence : sourceTrace;
  const questions = [
    ...asStrings(record.questions),
    ...asStrings(qualification.manual_review_questions),
  ];
  const uniqueQuestions = [...new Set(questions)];
  const classification = text(record.classification, text(asObject(payload.classification).primary_buyer_type_id));
  const confidence = text(record.confidence, text(qualification.score_total));

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <section className="rounded-lg border bg-background p-3 md:col-span-2">
        <h4 className="text-sm font-medium">复核摘要</h4>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{recordSummary(record)}</p>
      </section>
      {classification || confidence ? (
        <section className="rounded-lg border bg-background p-3">
          <h4 className="text-sm font-medium">判断信息</h4>
          <dl className="mt-2 grid grid-cols-[5rem_minmax(0,1fr)] gap-y-1 text-sm">
            {classification ? <><dt className="text-muted-foreground">分类</dt><dd>{classification}</dd></> : null}
            {confidence ? <><dt className="text-muted-foreground">置信度</dt><dd>{confidence}</dd></> : null}
          </dl>
        </section>
      ) : null}
      <section className="rounded-lg border bg-background p-3">
        <h4 className="text-sm font-medium">记录标识</h4>
        <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{recordId(record)}</p>
      </section>
      {uniqueQuestions.length > 0 ? (
        <section className="rounded-lg border bg-background p-3 md:col-span-2">
          <h4 className="text-sm font-medium">待确认问题</h4>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
            {uniqueQuestions.map((question) => <li key={question}>{question}</li>)}
          </ul>
        </section>
      ) : null}
      <section className="rounded-lg border bg-background p-3 md:col-span-2">
        <h4 className="text-sm font-medium">来源证据</h4>
        {evidence.length ? (
          <div className="mt-2 space-y-2">
            {evidence.map((item, index) => {
              const excerpt = text(item.source_excerpt, text(item.quote, text(item.evidence_summary, "")));
              return (
                <div className="rounded-md bg-muted p-3 text-sm" key={`${text(item.source_url)}-${index}`}>
                  <ExternalLinkValue value={item.source_url} />
                  {excerpt ? <p className="mt-1 whitespace-pre-wrap leading-6 text-muted-foreground">{excerpt}</p> : null}
                  {text(item.observed_at) ? <p className="mt-1 text-xs text-muted-foreground">{text(item.observed_at)}</p> : null}
                </div>
              );
            })}
          </div>
        ) : <p className="mt-2 text-sm text-muted-foreground">没有可展示的来源证据。</p>}
      </section>
      {Object.keys(payload).length > 0 ? (
        <details className="rounded-lg border bg-background p-3 md:col-span-2">
          <summary className="cursor-pointer text-sm font-medium">查看原始记录</summary>
          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs leading-5 text-muted-foreground">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function ReviewRecord({
  disabled,
  onSave,
  readOnly,
  record,
  review,
}: {
  disabled: boolean;
  onSave: (status: ReviewStatus, note: string) => Promise<void>;
  readOnly: boolean;
  record: JsonObject;
  review: ReviewDecision;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(review.note);

  useEffect(() => setNote(review.note), [review.note]);

  return (
    <details
      className="group/manual-review-record border-b last:border-b-0"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 p-4 marker:content-none [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 gap-2">
          <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open/manual-review-record:rotate-90" aria-hidden="true" />
          <div className="min-w-0">
            <p className="truncate font-medium">{recordTitle(record)}</p>
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{recordSummary(record)}</p>
          </div>
        </div>
        <Badge className="shrink-0" variant={statusVariant(review.status)}>{reviewStatusLabel(review.status)}</Badge>
      </summary>
      {open ? (
        <div className="border-t bg-muted/30 p-4">
          <div className="flex flex-col gap-5">
            <RecordDetails record={record} />
            {!readOnly ? (
              <FieldGroup>
                <Field>
                  <FieldLabel>复核状态</FieldLabel>
                  <ToggleGroup
                    disabled={disabled}
                    onValueChange={(value) => {
                      if (isReviewStatus(value)) void onSave(value, note);
                    }}
                    size="sm"
                    type="single"
                    value={review.status}
                    variant="outline"
                  >
                    <ToggleGroupItem value="pending">待复核</ToggleGroupItem>
                    <ToggleGroupItem value="approved">通过</ToggleGroupItem>
                    <ToggleGroupItem value="rejected">不通过</ToggleGroupItem>
                  </ToggleGroup>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`manual-review-note-${recordId(record)}`}>复核备注</FieldLabel>
                  <Textarea
                    disabled={disabled}
                    id={`manual-review-note-${recordId(record)}`}
                    maxLength={5000}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="可选：记录判断依据或后续行动。"
                    value={note}
                  />
                </Field>
                <Button disabled={disabled} onClick={() => void onSave(review.status, note)} type="button" variant="outline">
                  <Save data-icon="inline-start" />
                  保存备注
                </Button>
              </FieldGroup>
            ) : null}
          </div>
        </div>
      ) : null}
    </details>
  );
}

function SecondaryRecord({
  label,
  record,
  variant,
}: {
  label: string;
  record: JsonObject;
  variant: "destructive" | "secondary";
}) {
  const [open, setOpen] = useState(false);

  return (
    <details
      className="group/manual-review-secondary border-b last:border-b-0"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 p-4 marker:content-none [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 gap-2">
          <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open/manual-review-secondary:rotate-90" aria-hidden="true" />
          <div className="min-w-0">
            <p className="truncate font-medium">{recordTitle(record)}</p>
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{recordSummary(record)}</p>
          </div>
        </div>
        <Badge className="shrink-0" variant={variant}>{label}</Badge>
      </summary>
      {open ? <div className="border-t bg-muted/30 p-4"><RecordDetails record={record} /></div> : null}
    </details>
  );
}

function SecondaryRecordList({
  description,
  label,
  records,
  variant,
}: {
  description: string;
  label: string;
  records: JsonObject[];
  variant: "destructive" | "secondary";
}) {
  if (!records.length) return null;
  const headerClass = variant === "secondary"
    ? "bg-emerald-500/5 hover:bg-emerald-500/10"
    : "bg-destructive/5 hover:bg-destructive/10";

  return (
    <details className="group/manual-review-secondary-list overflow-hidden rounded-lg border bg-card">
      <summary className={cn("flex cursor-pointer list-none items-start justify-between gap-3 p-4 transition-colors marker:content-none [&::-webkit-details-marker]:hidden", headerClass)}>
        <div className="flex min-w-0 gap-2">
          <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open/manual-review-secondary-list:rotate-90" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-medium">{label}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
        <Badge className="shrink-0" variant={variant}>{records.length} 条</Badge>
      </summary>
      <div className="border-t">
        {records.map((record, index) => (
          <SecondaryRecord
            key={`${label}-${recordId(record)}-${index}`}
            label={label}
            record={record}
            variant={variant}
          />
        ))}
      </div>
    </details>
  );
}

function contextLabel(data: ManualReviewData) {
  if (data.collection_id) return data.collection_id;
  if (data.review_set_id) return `${data.review_kind ?? "manual review"} · ${data.review_set_id}`;
  return "人工复核";
}

function count(data: ManualReviewData, generic: string, collection: string) {
  return data.summary[generic] ?? data.summary[collection] ?? 0;
}

export function ManualReviewAssetPanel({ assetPath, workspace }: { assetPath: string; workspace: string }) {
  const [data, setData] = useState<ManualReviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [savingRecordId, setSavingRecordId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const endpoint = reviewUrl(workspace, assetPath);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await requestJson<ManualReviewData>(endpoint));
    } catch (reason) {
      setData(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => { void load(); }, [load]);

  const records = useMemo(() => {
    if (!data) return [];
    return data.review_records.filter((record) => {
      const decision = data.reviews[recordId(record)] ?? { status: "pending" as const, note: "", updated_at: null };
      return decision.status === "pending";
    });
  }, [data]);

  const pageCount = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleRecords = records.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );

  async function save(record: JsonObject, status: ReviewStatus, note: string) {
    const id = recordId(record);
    setSavingRecordId(id);
    try {
      await requestJson(`${endpoint}`, {
        body: JSON.stringify({ asset_path: assetPath, note, record_id: id, status }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      await load();
      toast.success("复核结果已保存");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "保存复核结果失败");
    } finally {
      setSavingRecordId(null);
    }
  }

  async function exportReview() {
    if (!data) return;
    setSubmitting(true);
    try {
      const action = data.can_complete_analysis ? "complete-analysis" : "export";
      await requestJson(`${endpoint}`, {
        body: JSON.stringify({ action, asset_path: assetPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      await load();
      toast.success(data.can_complete_analysis ? "已完成复核并生成分析输出" : "已生成复核输出");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "生成复核输出失败");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">正在读取人工复核队列…</div>;
  }

  if (error || !data) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <CardTitle>无法打开人工复核</CardTitle>
            <CardDescription>{error ?? "无法读取 manual-review-list.json。"}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => void load()} type="button" variant="outline">
              <RefreshCw data-icon="inline-start" />
              重新读取
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const pending = count(data, "pending", "manual_review_pending");
  const approved = count(data, "approved", "manual_review_approved");
  const rejected = count(data, "rejected", "manual_review_rejected");
  const total = count(data, "review_total", "manual_review_total");
  const automatic = data.summary.automatic_qualified ?? 0;
  const sourceRejected = data.summary.source_rejected ?? 0;
  const outputLabel = data.can_complete_analysis
    ? "完成复核并生成分析输出"
    : data.kind === "collection"
      ? "生成 output.json"
      : "生成 review-result.json";

  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain bg-muted/20 p-4 [scrollbar-gutter:stable] md:p-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <CardTitle>人工复核概览</CardTitle>
                <CardDescription className="mt-1">{contextLabel(data)}</CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void load()} size="sm" type="button" variant="outline">
                  <RefreshCw data-icon="inline-start" />
                  刷新
                </Button>
                {!data.read_only ? (
                  <Button disabled={submitting} onClick={() => void exportReview()} size="sm" type="button">
                    {data.can_complete_analysis ? <FileCheck2 data-icon="inline-start" /> : <FileOutput data-icon="inline-start" />}
                    {submitting ? "正在生成" : outputLabel}
                  </Button>
                ) : null}
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {data.read_only ? (
              <div className="rounded-lg border border-dashed bg-muted/50 p-3 text-sm text-muted-foreground">
                此列表是自动模式留下的审计记录，不能再改写已完成的输出。
              </div>
            ) : null}
            <div className={cn("grid gap-3 sm:grid-cols-2", automatic || sourceRejected ? "xl:grid-cols-6" : "xl:grid-cols-4")}>
              <Metric label="待复核" value={pending} />
              <Metric label="人工通过" value={approved} />
              <Metric label="人工不通过" value={rejected} />
              <Metric label="复核总数" value={total} />
              {automatic ? <Metric label="自动合格" value={automatic} /> : null}
              {sourceRejected ? <Metric label="采集拒绝" value={sourceRejected} /> : null}
            </div>
          </CardContent>
        </Card>
        <details className="group/manual-review-queue overflow-hidden rounded-lg border bg-card" open>
          <summary className="flex cursor-pointer list-none items-start justify-between gap-3 bg-amber-500/5 p-4 transition-colors hover:bg-amber-500/10 marker:content-none [&::-webkit-details-marker]:hidden">
            <div className="flex min-w-0 gap-2">
              <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open/manual-review-queue:rotate-90" aria-hidden="true" />
              <div>
                <h2 className="text-sm font-medium">待复核</h2>
                <p className="mt-1 text-sm text-muted-foreground">展开后可查看和处理人工复核记录。</p>
              </div>
            </div>
            <Badge className="shrink-0" variant="outline">{records.length} 条</Badge>
          </summary>
          <div className="border-t">
            {records.length ? (
              <>
                <div className="flex items-center justify-between gap-3 p-4 text-sm text-muted-foreground">
                  <span>
                    显示 {currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, records.length)} / {records.length}
                  </span>
                  {pageCount > 1 ? (
                    <div className="flex gap-2">
                      <Button disabled={currentPage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))} size="sm" type="button" variant="outline">上一页</Button>
                      <Button disabled={currentPage + 1 >= pageCount} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} size="sm" type="button" variant="outline">下一页</Button>
                    </div>
                  ) : null}
                </div>
                <div className="border-t">
                  {visibleRecords.map((record) => {
                    const id = recordId(record);
                    const review = data.reviews[id] ?? { note: "", status: "pending" as const, updated_at: null };
                    return (
                      <ReviewRecord
                        disabled={savingRecordId === id}
                        key={id}
                        onSave={(status, note) => save(record, status, note)}
                        readOnly={data.read_only}
                        record={record}
                        review={review}
                      />
                    );
                  })}
                </div>
              </>
            ) : <div className="p-4"><Empty><EmptyTitle>没有待复核记录</EmptyTitle><EmptyDescription>当前所有人工复核记录均已处理。</EmptyDescription></Empty></div>}
          </div>
        </details>
        <SecondaryRecordList
          description="无需人工复核的合格记录，保留在输出中供审计。"
          label="自动合格"
          records={asObjects(data.qualified_without_manual_review)}
          variant="secondary"
        />
        <SecondaryRecordList
          description="在采集阶段被过滤的记录，完整保留供审计。"
          label="采集阶段已拒绝"
          records={asObjects(data.rejected_records)}
          variant="destructive"
        />
      </div>
    </div>
  );
}
