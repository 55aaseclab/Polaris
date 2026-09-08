"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, RefreshCw, Send, ShieldOff, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { wanghaiMutationFetch } from "@/lib/mutation-request";
import { wanghaiPath } from "@/lib/paths";

type JsonObject = Record<string, unknown>;

type OutreachTask = {
  task_id?: string;
  kind?: string;
  priority?: number;
  lead_id?: string;
  company_name?: string | null;
  engagement_id?: string | null;
  channel?: string | null;
  title?: string;
  detail?: string | null;
  action?: string;
  recipient?: string;
};

type OutreachSnapshot = {
  source?: { workspace?: string; relative_path?: string; tool?: string };
  status?: JsonObject;
  tasks?: OutreachTask[];
  state?: JsonObject | null;
};

function text(value: unknown, fallback = "-") {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number") return String(value);
  return fallback;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function kindLabel(kind: string | undefined) {
  switch (kind) {
    case "approve_draft":
      return "待审批";
    case "send_engagement":
      return "待发送";
    case "retry_failed":
      return "发送失败";
    case "suggest_first_touch":
      return "建议首触达";
    case "suggest_manual_channel":
      return "建议人工通道";
    case "handle_reply":
      return "客户已回复";
    case "waiting":
      return "冷却中";
    default:
      return kind || "任务";
  }
}

export function OutreachPanel({ workspace, active }: { workspace: string; active: boolean }) {
  const [data, setData] = useState<OutreachSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [manualNote, setManualNote] = useState("");

  const endpoint = `/api/workspaces/${encodeURIComponent(workspace)}/outreach`;

  const load = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(wanghaiPath(endpoint), { cache: "no-store" });
      const payload = (await response.json()) as OutreachSnapshot & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "无法读取触达状态");
      }
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法读取触达状态");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [endpoint, workspace]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const runAction = useCallback(
    async (body: JsonObject, successMessage: string) => {
      setBusy(true);
      try {
        const response = await wanghaiMutationFetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = (await response.json()) as {
          error?: string;
          snapshot?: OutreachSnapshot;
        };
        if (!response.ok) {
          throw new Error(payload.error || "操作失败");
        }
        if (payload.snapshot) setData(payload.snapshot);
        else await load();
        toast.success(successMessage);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "操作失败");
      } finally {
        setBusy(false);
      }
    },
    [endpoint, load],
  );

  const tasks = data?.tasks ?? [];
  const status = objectValue(data?.status);
  const byRelationship = objectValue(status.by_relationship);
  const leads = objectValue(objectValue(data?.state).leads);
  const selectedLead = selectedLeadId ? objectValue(leads[selectedLeadId]) : null;

  const relationshipChips = useMemo(
    () =>
      Object.entries(byRelationship).map(([key, value]) => (
        <Badge key={key} variant="secondary">
          {key}: {text(value, "0")}
        </Badge>
      )),
    [byRelationship],
  );

  if (!active) return null;

  if (loading && !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>客户触达</CardTitle>
          <CardDescription>正在读取 outreach 状态与下一任务…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (error && !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>客户触达不可用</CardTitle>
          <CardDescription>{error}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button type="button" variant="outline" onClick={() => void load()}>
            <RefreshCw data-icon="inline-start" />
            重试
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-lg">客户触达</CardTitle>
            <CardDescription>
              长期运行的下一任务队列 · 线索 {text(status.lead_count, "0")} · 更新{" "}
              {text(status.updated_at)}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void runAction({ action: "import" }, "已导入可触达线索")}
            >
              导入线索
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void runAction({ action: "tick" }, "已生成到期草稿")}
            >
              Tick
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy || loading} onClick={() => void load()}>
              <RefreshCw data-icon="inline-start" />
              刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">{relationshipChips}</CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">下一任务</CardTitle>
          <CardDescription>按优先级排序；完成后自动刷新队列。</CardDescription>
        </CardHeader>
        <CardContent>
          {tasks.length === 0 ? (
            <Empty>
              <EmptyTitle>暂无待办</EmptyTitle>
              <EmptyDescription>可先「导入线索」再「Tick」生成首封草稿。</EmptyDescription>
            </Empty>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>类型</TableHead>
                    <TableHead>公司</TableHead>
                    <TableHead>通道</TableHead>
                    <TableHead>说明</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tasks.map((task) => (
                    <TableRow key={task.task_id || `${task.kind}-${task.lead_id}-${task.engagement_id}`}>
                      <TableCell>
                        <Badge variant="outline">{kindLabel(task.kind)}</Badge>
                      </TableCell>
                      <TableCell className="font-medium">
                        <button
                          type="button"
                          className="text-left underline-offset-2 hover:underline"
                          onClick={() => setSelectedLeadId(task.lead_id || null)}
                        >
                          {text(task.company_name, task.lead_id)}
                        </button>
                      </TableCell>
                      <TableCell>{text(task.channel)}</TableCell>
                      <TableCell className="max-w-xs truncate" title={text(task.detail, text(task.title))}>
                        {text(task.title)} · {text(task.detail, "")}
                      </TableCell>
                      <TableCell className="text-right">
                        <TaskActions task={task} busy={busy} onAction={runAction} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedLead ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{text(selectedLead.company_name, selectedLeadId ?? "-")}</CardTitle>
            <CardDescription>
              {text(selectedLead.lead_id)} · 关系 {text(selectedLead.relationship)} ·{" "}
              {selectedLead.suppression_reason ? `抑制: ${text(selectedLead.suppression_reason)}` : "可跟进"}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div>
              <div className="mb-2 text-sm font-medium">联系通道</div>
              <div className="flex flex-wrap gap-2">
                {(Array.isArray(selectedLead.contact_points) ? selectedLead.contact_points : []).map((point, index) => {
                  const item = objectValue(point);
                  return (
                    <Badge key={`${item.channel}-${item.value}-${index}`} variant="secondary">
                      {text(item.channel)}:{text(item.status)} · {text(item.value)}
                    </Badge>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="mb-2 text-sm font-medium">外联记录</div>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ID</TableHead>
                      <TableHead>通道</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>主题</TableHead>
                      <TableHead>结果</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(Array.isArray(selectedLead.engagements) ? selectedLead.engagements : []).map((raw) => {
                      const eng = objectValue(raw);
                      return (
                        <TableRow key={text(eng.engagement_id)}>
                          <TableCell className="font-mono text-xs">{text(eng.engagement_id)}</TableCell>
                          <TableCell>{text(eng.channel)}</TableCell>
                          <TableCell>{text(eng.status)}</TableCell>
                          <TableCell className="max-w-xs truncate">{text(eng.subject)}</TableCell>
                          <TableCell>{text(eng.outcome)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <div className="text-sm font-medium">人工结果备注（可选）</div>
              <Textarea
                value={manualNote}
                onChange={(event) => setManualNote(event.target.value)}
                placeholder="电话/LinkedIn 沟通纪要"
                rows={3}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || !selectedLeadId}
                  onClick={() =>
                    void runAction(
                      {
                        action: "log",
                        lead_id: selectedLeadId,
                        channel: "linkedin_message",
                        outcome: "connected",
                        note: manualNote || undefined,
                      },
                      "已登记 LinkedIn 触达",
                    )
                  }
                >
                  <UserRound data-icon="inline-start" />
                  记 LinkedIn
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || !selectedLeadId}
                  onClick={() =>
                    void runAction(
                      {
                        action: "log",
                        lead_id: selectedLeadId,
                        channel: "phone",
                        outcome: "no_answer",
                        note: manualNote || undefined,
                      },
                      "已登记电话结果",
                    )
                  }
                >
                  记电话未接
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || !selectedLeadId}
                  onClick={() =>
                    void runAction(
                      {
                        action: "suppress",
                        lead_id: selectedLeadId,
                        reason: "opt_out",
                      },
                      "已抑制线索",
                    )
                  }
                >
                  <ShieldOff data-icon="inline-start" />
                  抑制
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || !selectedLeadId}
                  onClick={() =>
                    void runAction({ action: "customer", lead_id: selectedLeadId }, "已标记为客户")
                  }
                >
                  标为客户
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function TaskActions({
  task,
  busy,
  onAction,
}: {
  task: OutreachTask;
  busy: boolean;
  onAction: (body: JsonObject, message: string) => Promise<void>;
}) {
  if (task.kind === "approve_draft" && task.engagement_id) {
    return (
      <div className="flex justify-end gap-1">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() =>
            void onAction({ action: "approve", engagement_id: task.engagement_id }, "已批准草稿")
          }
        >
          <Check data-icon="inline-start" />
          批准
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void onAction({ action: "reject", engagement_id: task.engagement_id }, "已驳回草稿")
          }
        >
          驳回
        </Button>
      </div>
    );
  }

  if (task.kind === "send_engagement" && task.engagement_id) {
    return (
      <div className="flex justify-end gap-1">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() =>
            void onAction({ action: "send", engagement_id: task.engagement_id }, "已 dry-run 发送")
          }
        >
          <Send data-icon="inline-start" />
          Dry-run
        </Button>
      </div>
    );
  }

  if (task.kind === "suggest_first_touch" && task.lead_id) {
    return (
      <Button
        type="button"
        size="sm"
        disabled={busy}
        onClick={() =>
          void onAction(
            { action: "draft", lead_id: task.lead_id, channel: task.channel || "email" },
            "已创建草稿",
          )
        }
      >
        建草稿
      </Button>
    );
  }

  if (task.kind === "handle_reply" && task.engagement_id) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() =>
          void onAction({ action: "reply", engagement_id: task.engagement_id }, "已确认回复状态")
        }
      >
        确认
      </Button>
    );
  }

  if (task.kind === "suggest_manual_channel" && task.lead_id) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() =>
          void onAction(
            {
              action: "log",
              lead_id: task.lead_id,
              channel: task.channel || "linkedin_message",
              outcome: "attempted",
            },
            "已登记人工触达",
          )
        }
      >
        记一次
      </Button>
    );
  }

  return <span className="text-xs text-muted-foreground">{text(task.action)}</span>;
}
