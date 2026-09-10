import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Activity,
  Bug,
  CheckCircle2,
  ChevronRight,
  Check,
  CircleUserRound,
  CircleAlert,
  Code2,
  Copy,
  Clock3,
  ExternalLink,
  Eye,
  FileText,
  FolderOpen,
  LayoutDashboard,
  Loader2,
  LogOut,
  MonitorPlay,
  Orbit,
  Plus,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  Sparkles,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
  Terminal,
  UserRound,
  Wifi,
  Workflow,
  X,
} from "lucide-react";
import {
  DEFAULT_POLARIS_VAULT_PATH,
  resolveAllowedVaultLines,
  resolveDefaultVaultLine,
  resolveShellHostActions,
  resolveWanghaiPortalAction,
  validatePolarisHostName,
  type PolarisVaultLine,
  type ShellHostSummary,
  type ShellSession,
} from "@polaris/polaris-shell";
import { Button, buttonVariants } from "./components/ui/button.js";
import { Badge } from "./components/ui/badge.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card.js";
import { Input } from "./components/ui/input.js";
import { Separator } from "./components/ui/separator.js";
import {
  authingConfig,
  beginSignIn,
  completeSignIn,
  ensureCurrentUser,
  isRequestError,
  logout,
  request,
  resolvePaseoUrl,
  type AuthingConfig,
  type PortalCredential,
  type PortalCredentialRecord,
  type PortalUserResponse,
} from "./portal-client.js";
import { usePortalStore } from "./portal-store.js";
import { cn } from "./lib/utils.js";
import {
  artifactPreviewKind,
  artifactPreviewSource,
  artifactPreviewUrl,
  formatJsonArtifact,
  type ArtifactPreviewKind,
} from "./artifact-preview.js";
import { formatRunDateTime } from "./formatters.js";
import {
  flowForRun,
  packForRun,
  workflowKey,
  type MockDomainPack,
  type MockWorkflowFlow,
  type MockWorkflowRun,
  type WorkflowPriority,
  type WorkflowStatus,
} from "./workflow-mocks.js";

function usePortalNavigation(): { path: string; navigate: (path: string, replace?: boolean) => void } {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const navigate = useCallback((nextPath: string, replace = false) => {
    if (replace) window.history.replaceState({}, "", nextPath);
    else window.history.pushState({}, "", nextPath);
    setPath(window.location.pathname);
  }, []);
  return { path, navigate };
}

function setupReturnPath(): "/work" | "/settings/workflows" {
  return new URLSearchParams(window.location.search).get("returnTo") === "/settings/workflows"
    ? "/settings/workflows"
    : "/work";
}

export default function App() {
  const { path, navigate } = usePortalNavigation();
  const session = usePortalStore((state) => state.session);
  const bootstrapped = usePortalStore((state) => state.bootstrapped);
  const loading = usePortalStore((state) => state.loading);
  const error = usePortalStore((state) => state.error);
  const bootstrap = usePortalStore((state) => state.bootstrap);
  const clearError = usePortalStore((state) => state.clearError);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (path === "/auth/callback") return <AuthCallbackPage navigate={navigate} />;
  if (path === "/welcome") return <WelcomePage navigate={navigate} session={session} />;
  if (!bootstrapped || loading) return <LoadingView label="正在加载 Polaris Portal" />;
  if (!session?.authenticated) {
    queueMicrotask(() => navigate("/welcome", true));
    return <LoadingView label="正在跳转登录" />;
  }
  if (!session.polarisUserId) return <ErrorView message="当前 Authing 用户尚未配置 Polaris 访问权限" />;
  if (path === "/") {
    queueMicrotask(() => navigate("/work", true));
    return <LoadingView label="正在打开工作台" />;
  }
  if (path === "/setup" || path === "/setup/") {
    return <PortalLayout active="workflows" session={session} navigate={navigate}><ProvisioningPage navigate={navigate} returnPath={setupReturnPath()} /></PortalLayout>;
  }
  if (path === "/work" || path === "/work/") {
    return <PortalLayout active="work" session={session} navigate={navigate}><WorkPage navigate={navigate} /></PortalLayout>;
  }
  if (path === "/debug" || path === "/debug/") {
    return <PortalLayout active="debug" session={session} navigate={navigate}><DebugPage /></PortalLayout>;
  }
  const runMatch = path.match(/^\/work\/runs\/([^/]+)$/u);
  if (runMatch) {
    return <PortalLayout active="work" session={session} navigate={navigate}><RunDetailPage runId={decodeURIComponent(runMatch[1])} navigate={navigate} /></PortalLayout>;
  }
  if (path === "/hosts" || path === "/hosts/") {
    return <PortalLayout active="hosts" session={session} navigate={navigate}><HostsPage session={session} navigate={navigate} /></PortalLayout>;
  }
  if (path === "/settings" || path === "/settings/workflows" || path === "/settings/workflows/") {
    return <PortalLayout active="workflows" session={session} navigate={navigate}><WorkflowSettingsPage navigate={navigate} /></PortalLayout>;
  }
  if (path === "/settings/user") {
    return <PortalLayout active="user" session={session} navigate={navigate}><UserPage session={session} /></PortalLayout>;
  }
  const codingMatch = path.match(/^\/v\/([^/]+)\/coding$/u);
  if (codingMatch) return <SurfacePage kind="coding" id={decodeURIComponent(codingMatch[1])} navigate={navigate} />;
  const wanghaiMatch = path.match(/^\/v\/([^/]+)\/wanghai$/u);
  if (wanghaiMatch) return <SurfacePage kind="wanghai" id={decodeURIComponent(wanghaiMatch[1])} navigate={navigate} />;
  if (error) return <ErrorView message={error} onDismiss={clearError} />;
  return <ErrorView message="页面不存在" />;
}

function PortalLayout({
  active,
  session,
  navigate,
  children,
}: {
  active: "work" | "hosts" | "workflows" | "user" | "debug";
  session: ShellSession;
  navigate: (path: string, replace?: boolean) => void;
  children: React.ReactNode;
}) {
  const signOut = usePortalStore((state) => state.signOut);
  const link = (path: string, label: string, Icon: typeof Server, key: "work" | "hosts" | "workflows" | "user" | "debug") => (
    <a
      href={path}
      onClick={(event) => { event.preventDefault(); navigate(path); }}
      className={cn("nav-link", active === key && "is-active")}
    >
      <Icon className="h-4 w-4" />
      {label}
    </a>
  );
  return (
    <div className="portal-root">
      <header className="portal-topbar">
        <div className="portal-topbar-inner">
          <a href="/work" className="brand" onClick={(event) => { event.preventDefault(); navigate("/work"); }}>
            <span className="brand-mark"><Orbit className="h-5 w-5" /></span>
            <span>POLARIS</span>
          </a>
          <nav className="portal-nav" aria-label="主导航">
            {link("/work", "工作", LayoutDashboard, "work")}
            {link("/hosts", "Vaults", Server, "hosts")}
            {link("/settings/workflows", "工作流", Workflow, "workflows")}
            {link("/debug", "Debug", Bug, "debug")}
            {link("/settings/user", "账户", CircleUserRound, "user")}
          </nav>
          <div className="portal-topbar-actions">
            <span className="user-chip" title={session.authingUsername || session.authingUserId}>
              <UserRound className="h-4 w-4" />
              {session.authingUsername || session.authingUserId}
            </span>
            <Button variant="ghost" size="icon" aria-label="退出登录" title="退出登录" onClick={() => void signOut()}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>
      <main className="portal-main">{children}</main>
    </div>
  );
}

const WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  queued: "排队中",
  running: "运行中",
  waiting: "等你确认",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const WORKFLOW_STATUS_VARIANTS: Record<WorkflowStatus, "default" | "secondary" | "success" | "warning" | "muted" | "danger"> = {
  queued: "muted",
  running: "default",
  waiting: "warning",
  succeeded: "success",
  failed: "danger",
  cancelled: "muted",
};

const WORKFLOW_PRIORITY_LABELS: Record<WorkflowPriority, string> = {
  urgent: "需要你处理",
  normal: "进行中",
  low: "已归档",
};

function WorkflowStatusBadge({ status }: { status: WorkflowStatus }) {
  return <Badge variant={WORKFLOW_STATUS_VARIANTS[status]}>{WORKFLOW_STATUS_LABELS[status]}</Badge>;
}

function workflowVaultStatusLabel(vault: { canRun: boolean }): string {
  return vault.canRun ? "运行中" : "不可用";
}

function workflowExecutionTargetLabel(run: { driver?: "none" | "vault"; vaultName: string }): string {
  return run.driver === "none" ? "Polaris host" : run.vaultName;
}

async function copyTextToClipboard(value: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Public HTTP deployments may expose no usable Clipboard API. Try the
    // browser's same-origin fallback before reporting a copy failure.
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("clipboard copy failed");
}

type WorkflowGroup = {
  id: string;
  title: string;
  flows: MockWorkflowFlow[];
};

function groupWorkflowFlows(flows: MockWorkflowFlow[]): WorkflowGroup[] {
  const groups = new Map<string, WorkflowGroup>();
  for (const flow of flows) {
    const id = flow.groupId || "other";
    const title = flow.groupTitle || "工作流";
    const group = groups.get(id) || { id, title, flows: [] };
    group.flows.push(flow);
    groups.set(id, group);
  }
  return [...groups.values()];
}

function WorkflowGroupHeading({ group }: { group: WorkflowGroup }) {
  return <div className="workflow-group-heading"><strong>{group.title}</strong><span>{group.flows.length}</span></div>;
}

function WorkPage({ navigate }: { navigate: (path: string, replace?: boolean) => void }) {
  const cards = usePortalStore((state) => state.cards);
  const runs = usePortalStore((state) => state.runs);
  const packs = usePortalStore((state) => state.packs);
  const [filter, setFilter] = useState<"all" | "attention" | "running" | "done">("all");
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const visibleCards = useMemo(() => cards
    .filter((card) => {
      if (filter === "attention") return card.status === "waiting";
      if (filter === "running") return ["queued", "running"].includes(card.status);
      if (filter === "done") return ["succeeded", "failed", "cancelled"].includes(card.status);
      return true;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [cards, filter]);
  const attentionCount = cards.filter((card) => card.status === "waiting").length;
  const activeIndex = Math.max(0, visibleCards.findIndex((card) => card.id === activeCardId));
  const activeCard = visibleCards[activeIndex];
  const activeRun = activeCard ? runs[activeCard.runId] : undefined;
  const nextCards = activeCard
    ? [...visibleCards.slice(activeIndex + 1), ...visibleCards.slice(0, activeIndex)].slice(0, 2)
    : [];
  const advanceCard = () => {
    if (!visibleCards.length) return;
    const nextIndex = (activeIndex + 1) % visibleCards.length;
    setActiveCardId(visibleCards[nextIndex]?.id || null);
  };
  const handleSwipe = (direction: "left" | "right") => {
    if (!activeCard || !activeRun) return;
    if (direction === "right") {
      navigate(`/work/runs/${encodeURIComponent(activeRun.id)}`);
      return;
    }
    advanceCard();
  };

  return (
    <div className="page-stack card-work-page">
      <div className="work-filter-toolbar">
        <div className="filter-tabs work-filter-tabs" role="tablist" aria-label="卡片筛选">
          {([
            ["all", "全部"],
            ["attention", "待确认"],
            ["running", "运行中"],
            ["done", "已完成"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              className={cn("filter-tab", filter === value && "is-active")}
              onClick={() => { setFilter(value); setActiveCardId(null); }}
            >
              {label}
              {value === "attention" && <span className="filter-tab-count">{attentionCount}</span>}
            </button>
          ))}
        </div>
        <Button
          type="button"
          className="work-new-button"
          size="icon"
          aria-label="新建工作"
          title="新建工作"
          onClick={() => setComposerOpen(true)}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <div className="work-grid-view" aria-live="polite">
        {visibleCards.map((card) => {
          const run = runs[card.runId];
          return run ? <WorkCardView key={card.id} card={card} run={run} packs={packs} navigate={navigate} layout="grid" /> : null;
        })}
        {!visibleCards.length && <div className="empty-state"><FolderOpen className="h-7 w-7" /><strong>这里暂时没有工作</strong><span>换一个筛选，或从工作流库开始新任务。</span></div>}
      </div>
      <div className="work-deck-view">
        <div className="card-first-layout">
          <section className="card-deck-column">
            <div className="card-deck" aria-live="polite">
              {nextCards.slice().reverse().map((card, index) => {
                const run = runs[card.runId];
                return run ? <DeckPreview key={card.id} card={card} run={run} packs={packs} depth={nextCards.length - index} /> : null;
              })}
              {activeCard && activeRun && <WorkCardView
                card={activeCard}
                run={activeRun}
                packs={packs}
                navigate={navigate}
                layout="deck"
                isActive
                onSwipe={handleSwipe}
              />}
              {!activeCard && <div className="empty-state deck-empty"><FolderOpen className="h-7 w-7" /><strong>这里暂时没有工作</strong><span>换一个筛选，或从工作流库开始新任务。</span></div>}
            </div>
          </section>
        </div>
      </div>
      {composerOpen && <WorkflowComposer navigate={navigate} onClose={() => setComposerOpen(false)} />}
    </div>
  );
}

type DebugRunFilter = "all" | "active" | "waiting" | "terminal";

function DebugPage() {
  const runs = usePortalStore((state) => state.runs);
  const packs = usePortalStore((state) => state.packs);
  const error = usePortalStore((state) => state.error);
  const replayCursor = usePortalStore((state) => state.replayCursor);
  const refreshWorkflowRuns = usePortalStore((state) => state.refreshWorkflowRuns);
  const [filter, setFilter] = useState<DebugRunFilter>("all");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const orderedRuns = useMemo(() => Object.values(runs).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [runs]);
  const counts = useMemo(() => ({
    all: orderedRuns.length,
    active: orderedRuns.filter((run) => ["queued", "running"].includes(run.status)).length,
    waiting: orderedRuns.filter((run) => run.status === "waiting").length,
    terminal: orderedRuns.filter((run) => ["succeeded", "failed", "cancelled"].includes(run.status)).length,
    failed: orderedRuns.filter((run) => run.status === "failed").length,
  }), [orderedRuns]);
  const visibleRuns = useMemo(() => orderedRuns.filter((run) => {
    if (filter === "active") return ["queued", "running"].includes(run.status);
    if (filter === "waiting") return run.status === "waiting";
    if (filter === "terminal") return ["succeeded", "failed", "cancelled"].includes(run.status);
    return true;
  }), [filter, orderedRuns]);
  useEffect(() => {
    if (selectedRunId && visibleRuns.some((run) => run.id === selectedRunId)) return;
    setSelectedRunId(visibleRuns[0]?.id || null);
  }, [selectedRunId, visibleRuns]);
  const selectedRun = visibleRuns.find((run) => run.id === selectedRunId) || visibleRuns[0];
  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshWorkflowRuns();
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <div className="page-stack debug-page">
      <div className="debug-heading">
        <div>
          <p className="eyebrow">RUN INSPECTOR</p>
          <h1>Debug</h1>
        </div>
        <div className="debug-heading-actions">
          <span className="debug-live-indicator"><span />自动更新</span>
          <Button variant="ghost" size="icon" aria-label="刷新运行投影" title="刷新运行投影" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
          </Button>
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      <div className="debug-metrics" aria-label="运行概览">
        <DebugMetric label="运行" value={counts.all} />
        <DebugMetric label="活跃" value={counts.active} tone="accent" />
        <DebugMetric label="待确认" value={counts.waiting} tone="warning" />
        <DebugMetric label="失败" value={counts.failed} tone="danger" />
      </div>
      <div className="debug-filter-row">
        <div className="filter-tabs debug-tabs" role="tablist" aria-label="运行筛选">
          {([
            ["all", "全部", counts.all],
            ["active", "活跃", counts.active],
            ["waiting", "待确认", counts.waiting],
            ["terminal", "结束", counts.terminal],
          ] as const).map(([value, label, count]) => (
            <button key={value} type="button" role="tab" aria-selected={filter === value} className={cn("filter-tab", filter === value && "is-active")} onClick={() => setFilter(value)}>
              {label}<span className="filter-tab-count">{count}</span>
            </button>
          ))}
        </div>
        <span className="debug-cursor"><Terminal className="h-3.5 w-3.5" />cursor {replayCursor}</span>
      </div>
      <div className="debug-layout">
        <section className="debug-run-list" aria-label="工作流运行列表">
          {visibleRuns.map((run) => {
            const pack = packForRun(packs, run);
            return <button type="button" key={run.id} className={cn("debug-run-row", selectedRun?.id === run.id && "is-selected")} onClick={() => setSelectedRunId(run.id)}>
              <span className={cn("debug-run-dot", `debug-run-dot-${run.status}`)} />
              <span className="debug-run-copy"><strong>{run.title}</strong><small>{pack?.title || run.packId} · {run.vaultName}</small></span>
              <span className="debug-run-state"><WorkflowStatusBadge status={run.status} /><small>{run.progress}%</small></span>
            </button>;
          })}
          {visibleRuns.length === 0 && <div className="empty-state debug-empty"><Bug className="h-6 w-6" /><strong>没有匹配的运行</strong></div>}
        </section>
        {selectedRun ? <DebugInspector run={selectedRun} packs={packs} /> : <div className="empty-state debug-inspector-empty"><Activity className="h-7 w-7" /><strong>选择一次运行</strong></div>}
      </div>
    </div>
  );
}

function DebugMetric({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "accent" | "warning" | "danger" }) {
  return <div className={cn("debug-metric", `debug-metric-${tone}`)}><span>{label}</span><strong>{value}</strong></div>;
}

function DebugInspector({ run, packs }: { run: MockWorkflowRun; packs: MockDomainPack[] }) {
  const pack = packForRun(packs, run);
  const flow = flowForRun(packs, run);
  const events = [...run.events].sort((left, right) => left.sequence - right.sequence);
  return (
    <section className="debug-inspector" aria-label={`${run.title} 调试信息`}>
      <Card className="debug-focus-card">
        <CardHeader className="debug-focus-header">
          <div className="debug-focus-title"><span className="debug-focus-icon"><Activity className="h-4 w-4" /></span><div><CardTitle>{run.title}</CardTitle><CardDescription>{pack?.title || run.packId} · {flow?.title || run.flowId}</CardDescription></div></div>
          <WorkflowStatusBadge status={run.status} />
        </CardHeader>
        <CardContent>
          <div className="debug-context-line"><span><Server className="h-3.5 w-3.5" />{run.vaultName}</span><span><Clock3 className="h-3.5 w-3.5" />{run.updatedAt.slice(11, 19)}</span><code>{run.id}</code></div>
          <div className="debug-progress"><div className="debug-progress-bar"><span style={{ width: `${run.progress}%` }} /></div><strong>{run.progress}%</strong></div>
          <div className="debug-flow-rail" aria-label="运行事件轨道">
            {events.length === 0 ? <span className="debug-flow-empty">等待事件</span> : events.map((event, index) => <div className="debug-flow-step" key={event.id}>
              <span className={cn("debug-flow-node", `timeline-dot-${event.tone}`)}>{index + 1}</span>
              <small>{event.title}</small>
            </div>)}
          </div>
          {run.error && <div className="debug-error"><Bug className="h-4 w-4" /><span><strong>{run.error.code}</strong>{run.error.message}</span></div>}
        </CardContent>
      </Card>
      <Card className="debug-log-card">
        <CardHeader className="debug-log-header"><div><CardTitle>事件日志</CardTitle><CardDescription>按 sequence 重放</CardDescription></div><Badge variant="outline">{events.length} events</Badge></CardHeader>
        <CardContent>
          <div className="debug-log-list">
            {[...events].reverse().map((event) => <div className="debug-log-entry" key={event.id}>
              <span className={cn("timeline-dot", `timeline-dot-${event.tone}`)} />
              <div className="debug-log-copy"><div><strong>{event.title}</strong><time>{event.timestamp.slice(11, 19)}</time></div><p>{event.detail}</p><code>#{event.sequence} · {event.kind}</code></div>
            </div>)}
            {events.length === 0 && <p className="empty-copy">暂时没有事件。</p>}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function LayersIcon() {
  return <span className="layers-icon"><span /><span /><span /></span>;
}

function DeckPreview({
  card,
  run,
  packs,
  depth,
}: {
  card: { status: WorkflowStatus; title: string; summary: string; vaultName: string };
  run: MockWorkflowRun;
  packs: MockDomainPack[];
  depth: number;
}) {
  const pack = packForRun(packs, run);
  const flow = flowForRun(packs, run);
  return <div className={cn("deck-preview", `deck-preview-${depth}`)} aria-hidden="true">
    <div className="deck-preview-topline"><span className={cn("pack-dot", `pack-dot-${pack?.accent || "green"}`)} />{flow?.title || run.flowId}<WorkflowStatusBadge status={card.status} /></div>
    <h3>{card.title}</h3>
    <p>{card.summary}</p>
    <span className="deck-preview-vault"><Server className="h-3.5 w-3.5" />{card.vaultName}</span>
  </div>;
}

function WorkflowFocus({ run }: { run: MockWorkflowRun }) {
  const focus = {
    queued: { label: "已排入队列", detail: `即将在 ${workflowExecutionTargetLabel(run)} 中开始`, icon: Clock3, tone: "blue" },
    running: { label: `正在 ${workflowExecutionTargetLabel(run)} 中工作`, detail: "执行状态会持续更新", icon: Loader2, tone: "green" },
    waiting: { label: "等你确认", detail: "确认后继续生成最终产物", icon: CircleAlert, tone: "amber" },
    succeeded: { label: "结果已准备好", detail: `${run.artifacts.length || 1} 个产物可以查看`, icon: CheckCircle2, tone: "green" },
    failed: { label: "运行失败", detail: "可以用原输入重新提交", icon: CircleAlert, tone: "red" },
    cancelled: { label: "运行已取消", detail: "可以再次提交这项工作", icon: RotateCcw, tone: "red" },
  }[run.status];
  const Icon = focus.icon;
  return <div className={cn("work-card-focus", `focus-${focus.tone}`)}>
    <span className="focus-mark"><Icon className={cn("h-5 w-5", run.status === "running" && "animate-spin")} /></span>
    <span className="focus-copy"><strong>{focus.label}</strong><small>{focus.detail}</small></span>
    {run.status === "running" && <strong className="focus-progress-value">{run.progress}%</strong>}
  </div>;
}

function WorkCardView({
  card,
  run,
  packs,
  navigate,
  layout,
  isActive = false,
  onSwipe,
}: {
  card: { priority: WorkflowPriority; status: WorkflowStatus; title: string; summary: string; vaultName: string; updatedAt: string };
  run: MockWorkflowRun;
  packs: MockDomainPack[];
  navigate: (path: string, replace?: boolean) => void;
  layout: "deck" | "grid";
  isActive?: boolean;
  onSwipe?: (direction: "left" | "right") => void;
}) {
  const isDeck = layout === "deck";
  const approve = usePortalStore((state) => state.approveWorkflowRun);
  const cancel = usePortalStore((state) => state.cancelWorkflowRun);
  const retry = usePortalStore((state) => state.retryWorkflowRun);
  const [busy, setBusy] = useState(false);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const pointerStart = useRef<number | null>(null);
  const pack = packForRun(packs, run);
  const flow = flowForRun(packs, run);
  const runAction = async (action: () => Promise<MockWorkflowRun | void | null>) => {
    setBusy(true);
    try {
      const nextRun = await action();
      if (nextRun) navigate(`/work/runs/${encodeURIComponent(nextRun.id)}`);
    } finally {
      setBusy(false);
    }
  };
  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (!isDeck || !isActive || (event.pointerType === "mouse" && event.button !== 0)) return;
    pointerStart.current = event.clientX;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (pointerStart.current === null) return;
    setDragX(event.clientX - pointerStart.current);
  };
  const finishPointer = (event: React.PointerEvent<HTMLElement>) => {
    if (pointerStart.current === null) return;
    const delta = event.clientX - pointerStart.current;
    pointerStart.current = null;
    setDragging(false);
    setDragX(0);
    if (Math.abs(delta) >= 84) onSwipe?.(delta > 0 ? "right" : "left");
  };
  return (
    <Card
      className={cn("work-card", isDeck && "deck-card", layout === "grid" && "grid-work-card", isDeck && isActive && "deck-card-active", isDeck && !isActive && "deck-card-hidden", card.status === "waiting" && "work-card-attention", dragging && "is-dragging")}
      aria-label={isDeck && isActive ? card.title : undefined}
      onPointerDown={isDeck ? handlePointerDown : undefined}
      onPointerMove={isDeck ? handlePointerMove : undefined}
      onPointerUp={isDeck ? finishPointer : undefined}
      onPointerCancel={isDeck ? finishPointer : undefined}
      style={isDeck && isActive ? { transform: `translateX(${dragX}px) rotate(${dragX / 18}deg)` } : undefined}
    >
      {isDeck && isActive && dragging && Math.abs(dragX) >= 12 && <div className={cn("swipe-hint", dragX < 0 ? "swipe-hint-skip" : "swipe-hint-detail")} aria-hidden="true">
        {dragX < 0 ? <><ArrowLeft className="h-4 w-4" />跳过</> : <><ArrowRight className="h-4 w-4" />详情</>}
      </div>}
      <CardHeader className="work-card-header">
        <div className="work-card-topline">
          <div className="work-card-kind"><span className={cn("pack-dot", `pack-dot-${pack?.accent || "green"}`)} />{pack?.category || "Workflow"}<span className="work-card-separator">·</span>{flow?.title || run.flowId}</div>
          <WorkflowStatusBadge status={card.status} />
        </div>
        <div className="work-card-title-row"><CardTitle>{card.title}</CardTitle>{card.priority === "urgent" && <span className="attention-label">{WORKFLOW_PRIORITY_LABELS[card.priority]}</span>}</div>
        <CardDescription>{card.summary}</CardDescription>
      </CardHeader>
      <CardContent className="work-card-content">
        <div className="work-card-meta"><span><Server className="h-3.5 w-3.5" />{card.vaultName}</span><span><Clock3 className="h-3.5 w-3.5" />更新于 {card.updatedAt.slice(11, 16)}</span>{run.progress > 0 && run.status === "running" && <span className="progress-label">{run.progress}%</span>}</div>
        {run.status === "running" && <div className="run-progress"><span style={{ width: `${run.progress}%` }} /></div>}
        <WorkflowFocus run={run} />
        <div className="card-actions work-card-actions">
          {card.status === "waiting" && <Button onClick={() => void runAction(() => approve(run.id))} disabled={busy}><CheckCircle2 className="h-4 w-4" />批准继续</Button>}
          {["queued", "running"].includes(card.status) && <Button variant="outline" onClick={() => void runAction(() => cancel(run.id))} disabled={busy}><Square className="h-4 w-4" />取消运行</Button>}
          {["failed", "cancelled"].includes(card.status) && <Button onClick={() => void runAction(() => retry(run.id))} disabled={busy}><RotateCcw className="h-4 w-4" />重试</Button>}
          <Button variant={card.status === "waiting" ? "ghost" : "outline"} onClick={() => navigate(`/work/runs/${encodeURIComponent(run.id)}`)}>
            {card.status === "succeeded" ? <><FileText className="h-4 w-4" />打开结果</> : <>查看详情<ChevronRight className="h-4 w-4" /></>}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function WorkflowComposer({
  initialPackId,
  navigate,
  onClose,
}: {
  initialPackId?: string;
  navigate: (path: string, replace?: boolean) => void;
  onClose: () => void;
}) {
  const packs = usePortalStore((state) => state.packs);
  const vaults = usePortalStore((state) => state.vaults);
  const setup = usePortalStore((state) => state.setup);
  const startWorkflowRun = usePortalStore((state) => state.startWorkflowRun);
  const refreshWorkflowVaults = usePortalStore((state) => state.refreshWorkflowVaults);
  const enabledWorkflowKeys = new Set(setup.enabledWorkflowKeys);
  const configuredPacks = packs.filter((pack) => pack.flows.some((flow) => enabledWorkflowKeys.has(workflowKey(pack.id, flow.id))));
  // Host execution is intentionally usable before Vault setup. Once a user
  // has configured a work scene, retain that scene as the compact catalog.
  const enabledPacks = configuredPacks.length > 0 ? configuredPacks : packs;
  const setupCatalogActive = configuredPacks.length > 0;
  const defaultPackId = enabledPacks.find((pack) => pack.id === initialPackId)?.id
    || enabledPacks.find((pack) => pack.id === setup.domainPackId)?.id
    || enabledPacks[0]?.id
    || "";
  const [packId, setPackId] = useState(defaultPackId);
  const selectedPack = enabledPacks.find((pack) => pack.id === packId) || enabledPacks[0];
  const enabledFlows = setupCatalogActive
    ? selectedPack?.flows.filter((flow) => enabledWorkflowKeys.has(workflowKey(selectedPack.id, flow.id))) || []
    : selectedPack?.flows || [];
  const [flowId, setFlowId] = useState(enabledFlows[0]?.id || "");
  const selectedFlow = enabledFlows.find((flow) => flow.id === flowId) || enabledFlows[0];
  const [vaultId, setVaultId] = useState(setup.vaultId || vaults.find((vault) => vault.canRun)?.id || vaults[0]?.id || "");
  const [driver, setDriver] = useState<"none" | "vault">("none");
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (driver !== "vault") return;
    void refreshWorkflowVaults().catch(() => undefined);
  }, [driver, refreshWorkflowVaults]);

  useEffect(() => {
    if (packId || !defaultPackId) return;
    setPackId(defaultPackId);
  }, [defaultPackId, packId]);

  const handlePackChange = (nextPackId: string) => {
    setPackId(nextPackId);
    const nextPack = enabledPacks.find((pack) => pack.id === nextPackId);
    const nextFlow = setupCatalogActive
      ? nextPack?.flows.find((flow) => enabledWorkflowKeys.has(workflowKey(nextPack.id, flow.id)))
      : nextPack?.flows[0];
    setFlowId(nextFlow?.id || "");
    setValues({});
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedPack || !selectedFlow) return;
    setBusy(true); setError(null);
    try {
      const run = await startWorkflowRun({
        packId: selectedPack.id,
        flowId: selectedFlow.id,
        driver,
        ...(driver === "vault" ? { vaultId } : {}),
        values,
      });
      onClose();
      navigate(`/work/runs/${encodeURIComponent(run.id)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal workflow-composer" role="dialog" aria-modal="true" aria-labelledby="workflow-composer-title" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div><p className="eyebrow">NEW WORK</p><h2 id="workflow-composer-title">开始一项工作</h2><p>选择能力、输入目标，执行位置由 Polaris 处理。</p></div>
          <Button variant="ghost" size="icon" aria-label="关闭" title="关闭" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
        <form className="form-stack" onSubmit={submit}>
          <div className="composer-grid">
            <div>
              <label className="field-label" htmlFor="workflow-pack">1 · 选择域包</label>
              <select id="workflow-pack" className="select" value={selectedPack?.id || packId} onChange={(event) => handlePackChange(event.target.value)}>
                {enabledPacks.map((pack) => <option key={pack.id} value={pack.id}>{pack.title} · {pack.category}</option>)}
              </select>
              {selectedPack && <div className="composer-context"><span className={cn("pack-dot", `pack-dot-${selectedPack.accent}`)} /><span><strong>{selectedPack.title}</strong><small>{selectedPack.description}</small></span></div>}
              {enabledPacks.length === 0 && <p className="form-error">还没有可用工作流，请先安装 Domain Pack。</p>}
            </div>
            <div>
              <label className="field-label" htmlFor="workflow-flow">2 · 选择工作流</label>
              <select id="workflow-flow" className="select" value={selectedFlow?.id || ""} onChange={(event) => { setFlowId(event.target.value); setValues({}); }} disabled={!selectedPack}>
                {groupWorkflowFlows(enabledFlows).map((group) => (
                  <optgroup key={group.id} label={group.title}>
                    {group.flows.map((flow) => <option key={flow.id} value={flow.id}>{flow.title}</option>)}
                  </optgroup>
                ))}
              </select>
              {selectedFlow && <div className="composer-flow-meta"><span>{selectedFlow.estimate}</span>{selectedFlow.approvalRequired && <Badge variant="warning">完成前需确认</Badge>}</div>}
            </div>
          </div>
          {selectedFlow?.fields.map((field) => (
            <div className="composer-field" key={field.id}>
              <label className="field-label" htmlFor={`workflow-field-${field.id}`}>{field.label}</label>
              {field.type === "textarea" ? <textarea id={`workflow-field-${field.id}`} className="textarea" placeholder={field.placeholder} required={field.required} value={values[field.id] || ""} onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))} /> : <Input id={`workflow-field-${field.id}`} placeholder={field.placeholder} required={field.required} value={values[field.id] || ""} onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))} />}
            </div>
          ))}
          <div>
            <label className="field-label" htmlFor="workflow-driver">3 · 执行位置</label>
            <select id="workflow-driver" className="select" value={driver} onChange={(event) => setDriver(event.target.value as "none" | "vault")}>
              <option value="none">Polaris host（无 Vault）</option>
              <option value="vault">Vault（使用已运行的 Vault）</option>
            </select>
            {driver === "vault" ? <>
              <label className="field-label" htmlFor="workflow-vault">选择执行 Vault</label>
              <select id="workflow-vault" className="select" value={vaultId} onChange={(event) => setVaultId(event.target.value)}>
                {vaults.map((vault) => <option key={vault.id} value={vault.id} disabled={!vault.canRun}>{vault.name} · {vault.profile} · {workflowVaultStatusLabel(vault)}{vault.kind === "disposable" ? " · 一次性" : ""}</option>)}
              </select>
              <p className="field-hint"><ShieldCheck className="h-3.5 w-3.5" />输入和执行产物会留在选定的 Vault 中。</p>
            </> : <p className="field-hint"><ShieldCheck className="h-3.5 w-3.5" />输入和执行产物由 Polaris host 管理。</p>}
          </div>
          {error && <p className="form-error">{error}</p>}
          <div className="composer-footer"><span className="mock-note"><Sparkles className="h-3.5 w-3.5" />{driver === "none" ? "Polaris host executor" : "Vault executor"}</span><div className="card-actions"><Button type="button" variant="ghost" onClick={onClose}>取消</Button><Button type="submit" disabled={busy || !selectedFlow || (driver === "vault" && !vaultId)}>{busy ? <><Loader2 className="h-4 w-4 animate-spin" />提交中</> : <><Play className="h-4 w-4" />提交运行</>}</Button></div></div>
        </form>
      </section>
    </div>
  );
}

function ProvisioningPage({
  navigate,
  returnPath,
}: {
  navigate: (path: string, replace?: boolean) => void;
  returnPath: "/work" | "/settings/workflows";
}) {
  const setup = usePortalStore((state) => state.setup);
  const packs = usePortalStore((state) => state.packs);
  const vaults = usePortalStore((state) => state.vaults);
  const completeProvisioning = usePortalStore((state) => state.completeProvisioning);
  const refreshWorkflowVaults = usePortalStore((state) => state.refreshWorkflowVaults);
  const [step, setStep] = useState(0);
  const [domainPackId, setDomainPackId] = useState(setup.domainPackId || packs[0]?.id || "");
  const [vaultId, setVaultId] = useState(setup.vaultId || "");
  const [enabledWorkflowKeys, setEnabledWorkflowKeys] = useState(setup.enabledWorkflowKeys);
  const [error, setError] = useState<string | null>(null);
  const [flowsInitialized, setFlowsInitialized] = useState(false);
  const selectedPack = packs.find((pack) => pack.id === domainPackId);
  const selectedPackFlowKeys = selectedPack?.flows.map((flow) => workflowKey(selectedPack.id, flow.id)) || [];
  const selectedPackEnabledFlowKeys = enabledWorkflowKeys.filter((key) => selectedPackFlowKeys.includes(key));

  useEffect(() => {
    // Host setup is immediately usable; Vault inventory is loaded only for
    // this page and cannot block the host path in `/work`.
    void refreshWorkflowVaults().catch(() => undefined);
  }, [refreshWorkflowVaults]);

  useEffect(() => {
    if (domainPackId && packs.some((pack) => pack.id === domainPackId)) return;
    const firstPackId = packs[0]?.id;
    if (firstPackId) {
      setDomainPackId(firstPackId);
      setFlowsInitialized(false);
    }
  }, [domainPackId, packs]);

  useEffect(() => {
    if (flowsInitialized || !selectedPack) return;
    const existingKeys = enabledWorkflowKeys.filter((key) => selectedPackFlowKeys.includes(key));
    const firstFlowKey = selectedPack.flows[0] ? workflowKey(selectedPack.id, selectedPack.flows[0].id) : null;
    setEnabledWorkflowKeys(existingKeys.length || !firstFlowKey ? existingKeys : [firstFlowKey]);
    setFlowsInitialized(true);
  }, [enabledWorkflowKeys, flowsInitialized, selectedPack, selectedPackFlowKeys]);

  const chooseDomainPack = (nextPackId: string) => {
    const nextPack = packs.find((pack) => pack.id === nextPackId);
    setDomainPackId(nextPackId);
    setFlowsInitialized(true);
    if (!nextPack) return;
    const nextKeys = nextPack.flows.map((flow) => workflowKey(nextPack.id, flow.id));
    setEnabledWorkflowKeys((current) => {
      const existingNextKeys = current.filter((key) => nextKeys.includes(key));
      return existingNextKeys.length > 0
        ? existingNextKeys
        : nextKeys[0] ? [nextKeys[0]] : [];
    });
    setError(null);
  };

  const toggleFlow = (flowId: string) => {
    if (!selectedPack) return;
    const key = workflowKey(selectedPack.id, flowId);
    setEnabledWorkflowKeys((current) => current.includes(key)
      ? current.filter((currentKey) => currentKey !== key)
      : [...current, key]);
  };

  const next = () => {
    const selectedVault = vaults.find((vault) => vault.id === vaultId);
    if (step === 0 && !selectedPack) {
      setError("请选择一个 Domain Pack 作为工作场景");
      return;
    }
    if (step === 1 && selectedVault && !selectedVault.canRun) {
      setError("请选择一个正在运行的 Vault");
      return;
    }
    setError(null);
    setStep((current) => Math.min(2, current + 1));
  };
  const previous = () => setStep((current) => Math.max(0, current - 1));
  const finish = async () => {
    const selectedVault = vaults.find((vault) => vault.id === vaultId);
    if (!selectedPack || selectedPackEnabledFlowKeys.length === 0) {
      setError("请选择一个 Domain Pack 和至少一个工作流");
      return;
    }
    if (selectedVault && !selectedVault.canRun) {
      setError("请选择一个正在运行的 Vault");
      return;
    }
    try {
      await completeProvisioning({
        domainPackId: selectedPack.id,
        vaultId: vaultId || null,
        enabledWorkflowKeys: selectedPackEnabledFlowKeys,
      });
      navigate(returnPath, true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <div className="page-stack setup-page">
      <div className="setup-progress" aria-label="设置进度">{["工作场景", "执行位置", "启用工作流"].map((label, index) => <div key={label} className={cn("setup-progress-step", index <= step && "is-active", index < step && "is-complete")}><span>{index < step ? <Check className="h-3.5 w-3.5" /> : index + 1}</span><small>{label}</small></div>)}</div>
      <Card className="setup-card">
        <CardHeader><CardTitle>{step === 0 ? "选择一个 Domain Pack 作为工作场景" : step === 1 ? "任务应该在哪里运行？" : `${selectedPack?.title || "这个 Domain Pack"} · 启用工作流`}</CardTitle></CardHeader>
        <CardContent>
          {step === 0 && <div className="setup-pack-list">{packs.map((pack) => <button type="button" key={pack.id} className={cn("setup-pack-option", domainPackId === pack.id && "is-selected")} onClick={() => chooseDomainPack(pack.id)}><span><strong>{pack.title}</strong><small>{pack.category} · v{pack.version}</small><em>{pack.flows.length} 个工作流 · {pack.description}</em></span>{domainPackId === pack.id && <CheckCircle2 className="setup-choice-check h-5 w-5" />}</button>)}</div>}
          {step === 1 && <div className="setup-vault-list">
            <button type="button" className={cn("setup-vault-option", !vaultId && "is-selected")} onClick={() => setVaultId("")}>
              <span className="vault-option-icon"><MonitorPlay className="h-4 w-4" /></span>
              <span><strong>Polaris host</strong><small>不依赖 Vault，直接在 Polaris 主机执行</small><em>driver=none · 适合先验证工作流</em></span>
              <span className="vault-option-status">可用</span>
              {!vaultId && <CheckCircle2 className="setup-choice-check h-5 w-5" />}
            </button>
            {vaults.map((vault) => { const selectable = vault.canRun; return <button type="button" key={vault.id} disabled={!selectable} className={cn("setup-vault-option", vaultId === vault.id && "is-selected")} onClick={() => setVaultId(vault.id)}><span className="vault-option-icon"><Server className="h-4 w-4" /></span><span><strong>{vault.name}</strong><small>{vault.description}</small><em>{vault.profile} · {vault.capacity}</em></span><span className="vault-option-status">{vault.kind === "disposable" ? "一次性" : workflowVaultStatusLabel(vault)}</span>{vaultId === vault.id && <CheckCircle2 className="setup-choice-check h-5 w-5" />}</button>; })}
          </div>}
          {step === 2 && selectedPack && <div className="setup-flow-list">{groupWorkflowFlows(selectedPack.flows).map((group) => <section className="workflow-group" key={group.id}>{group.id !== "other" && <WorkflowGroupHeading group={group} />}{group.flows.map((flow) => { const enabled = enabledWorkflowKeys.includes(workflowKey(selectedPack.id, flow.id)); return <button type="button" key={flow.id} className={cn("setup-pack-option", enabled && "is-selected")} aria-pressed={enabled} onClick={() => toggleFlow(flow.id)}><span><strong>{flow.title}</strong><small>{flow.summary}</small><em>{flow.estimate}{flow.approvalRequired ? " · 完成前需确认" : ""}</em></span><span className={cn("toggle-pill", enabled && "is-on")}>{enabled ? "已启用" : "启用"}</span></button>; })}</section>)}</div>}
          {step === 0 && packs.length === 0 && <div className="empty-state">暂无已安装 Domain Pack</div>}
          {step === 2 && !selectedPack && <div className="empty-state">请先选择 Domain Pack</div>}
          {error && <p className="form-error setup-error">{error}</p>}
          <div className="setup-summary"><span><strong>{selectedPack?.title || "未选择 Domain Pack"}</strong><small>{vaultId ? vaults.find((vault) => vault.id === vaultId)?.name : "Polaris host"} · {selectedPackEnabledFlowKeys.length} / {selectedPack?.flows.length || 0} 个工作流</small></span><span className="mock-note"><Sparkles className="h-3.5 w-3.5" />可随时修改</span></div>
          <div className="setup-footer"><Button variant="ghost" onClick={() => navigate(returnPath)}>稍后设置</Button><div className="card-actions">{step > 0 && <Button variant="outline" onClick={previous}><ArrowLeft className="h-4 w-4" />上一步</Button>}{step < 2 ? <Button onClick={next}>下一步<ArrowRight className="h-4 w-4" /></Button> : <Button onClick={() => void finish()}><Check className="h-4 w-4" />完成设置</Button>}</div></div>
        </CardContent>
      </Card>
    </div>
  );
}

function WorkflowSettingsPage({ navigate }: { navigate: (path: string, replace?: boolean) => void }) {
  const packs = usePortalStore((state) => state.packs);
  const setup = usePortalStore((state) => state.setup);
  const toggleWorkflow = usePortalStore((state) => state.toggleWorkflow);
  const [activeTab, setActiveTab] = useState<"all" | "enabled" | "available">("all");
  const [activePackId, setActivePackId] = useState(setup.domainPackId || packs[0]?.id || "");
  const enabledWorkflowKeys = new Set(setup.enabledWorkflowKeys);
  const allWorkflowCount = packs.reduce((total, pack) => total + pack.flows.length, 0);
  const enabledWorkflowCount = packs.reduce(
    (total, pack) => total + pack.flows.filter((flow) => enabledWorkflowKeys.has(workflowKey(pack.id, flow.id))).length,
    0,
  );
  const availableWorkflowCount = allWorkflowCount - enabledWorkflowCount;
  const packMatchesTab = (pack: typeof packs[number]) => activeTab === "all"
    || (activeTab === "enabled" && pack.flows.some((flow) => enabledWorkflowKeys.has(workflowKey(pack.id, flow.id))))
    || (activeTab === "available" && pack.flows.some((flow) => !enabledWorkflowKeys.has(workflowKey(pack.id, flow.id))));
  const visiblePacks = packs.filter(packMatchesTab);

  useEffect(() => {
    if (visiblePacks.some((pack) => pack.id === activePackId)) return;
    if (visiblePacks[0]) setActivePackId(visiblePacks[0].id);
  }, [activePackId, visiblePacks]);

  const activePack = visiblePacks.find((pack) => pack.id === activePackId) || visiblePacks[0];
  const visibleFlows = activePack?.flows.filter((flow) => activeTab === "all"
    || (activeTab === "enabled" && enabledWorkflowKeys.has(workflowKey(activePack.id, flow.id)))
    || (activeTab === "available" && !enabledWorkflowKeys.has(workflowKey(activePack.id, flow.id)))) || [];
  const enabledFlowCount = activePack?.flows.filter((flow) => enabledWorkflowKeys.has(workflowKey(activePack.id, flow.id))).length || 0;
  return (
    <div className="page-stack settings-page">
      {!setup.completed && <Card className="inline-notice settings-task-card"><CardContent><Sparkles className="h-5 w-5" /><span><strong>完成首次设置</strong></span><Button variant="outline" size="icon" aria-label="完成首次设置" title="完成首次设置" onClick={() => navigate("/setup?returnTo=/settings/workflows")}><ArrowRight className="h-4 w-4" /></Button></CardContent></Card>}
      <div className="settings-toolbar">
        <div className="filter-tabs settings-tabs" role="tablist" aria-label="工作流设置">
          <button type="button" role="tab" aria-selected={activeTab === "all"} className={cn("filter-tab", activeTab === "all" && "is-active")} onClick={() => setActiveTab("all")}>全部<span className="filter-tab-count">{allWorkflowCount}</span></button>
          <button type="button" role="tab" aria-selected={activeTab === "enabled"} className={cn("filter-tab", activeTab === "enabled" && "is-active")} onClick={() => setActiveTab("enabled")}>已启用<span className="filter-tab-count">{enabledWorkflowCount}</span></button>
          <button type="button" role="tab" aria-selected={activeTab === "available"} className={cn("filter-tab", activeTab === "available" && "is-active")} onClick={() => setActiveTab("available")}>可添加<span className="filter-tab-count">{availableWorkflowCount}</span></button>
        </div>
        <Button className="settings-provision-button" variant="outline" size="icon" aria-label={setup.completed ? "调整工作舱设置" : "完成首次设置"} title={setup.completed ? "调整工作舱设置" : "完成首次设置"} onClick={() => navigate("/setup?returnTo=/settings/workflows")}><Settings2 className="h-4 w-4" /></Button>
      </div>
      <div className="filter-tabs settings-pack-tabs" role="tablist" aria-label="Domain Pack">
        {visiblePacks.map((pack) => {
          const count = pack.flows.filter((flow) => enabledWorkflowKeys.has(workflowKey(pack.id, flow.id))).length;
          return <button type="button" role="tab" aria-selected={activePack?.id === pack.id} key={pack.id} className={cn("filter-tab settings-pack-tab", activePack?.id === pack.id && "is-active")} onClick={() => setActivePackId(pack.id)}>{pack.title}<span className="filter-tab-count">{count}/{pack.flows.length}</span></button>;
        })}
      </div>
      {activePack && <Card className="settings-pack-browser">
        <CardHeader>
          <div className="settings-pack-heading"><div><CardTitle>{activePack.title}</CardTitle><CardDescription>{activePack.category} · v{activePack.version} · {enabledFlowCount} / {activePack.flows.length} 个工作流已启用</CardDescription></div></div>
        </CardHeader>
        <CardContent>
          <p className="settings-pack-description">{activePack.description}</p>
          <div className="settings-flow-list">{groupWorkflowFlows(visibleFlows).map((group) => <section className="workflow-group" key={group.id}>{group.id !== "other" && <WorkflowGroupHeading group={group} />}{group.flows.map((flow) => {
            const enabled = enabledWorkflowKeys.has(workflowKey(activePack.id, flow.id));
            return <div className="settings-flow-row" key={flow.id}><span><strong>{flow.title}</strong><small>{flow.summary}</small></span><span className="settings-flow-actions"><span>{flow.estimate}{flow.approvalRequired ? " · 需确认" : ""}</span><button type="button" className={cn("pack-toggle", enabled && "is-enabled")} aria-pressed={enabled} aria-label={enabled ? `停用 ${flow.title}` : `启用 ${flow.title}`} onClick={() => toggleWorkflow(activePack.id, flow.id, !enabled)}>{enabled ? <><Check className="h-3.5 w-3.5" />已启用</> : <><Plus className="h-3.5 w-3.5" />启用</>}</button></span></div>;
          })}</section>)}</div>
          {visibleFlows.length === 0 && <div className="empty-state settings-flow-empty">此 Domain Pack 暂无符合当前筛选的工作流</div>}
          <div className="capability-list">{activePack.capabilities.map((capability) => <Badge key={capability} variant="outline">{capability}</Badge>)}</div>
        </CardContent>
      </Card>}
      {visiblePacks.length === 0 && <div className="empty-state">当前筛选没有匹配的 Domain Pack</div>}
    </div>
  );
}

function RunDetailPage({ runId, navigate }: { runId: string; navigate: (path: string, replace?: boolean) => void }) {
  const run = usePortalStore((state) => state.runs[runId]);
  const packs = usePortalStore((state) => state.packs);
  const approve = usePortalStore((state) => state.approveWorkflowRun);
  const cancel = usePortalStore((state) => state.cancelWorkflowRun);
  const retry = usePortalStore((state) => state.retryWorkflowRun);
  const [artifact, setArtifact] = useState<MockWorkflowRun["artifacts"][number] | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  if (!run) return <div className="center-state"><ErrorBanner message="找不到这次工作运行" /><Button variant="outline" onClick={() => navigate("/work")}>返回工作台</Button></div>;
  const pack = packForRun(packs, run);
  const flow = flowForRun(packs, run);
  const canCancel = ["queued", "running", "waiting"].includes(run.status);
  const canRetry = ["failed", "cancelled"].includes(run.status);
  const copyRunId = async () => {
    try {
      await copyTextToClipboard(run.id);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  };
  const retryAndOpen = async () => {
    const nextRun = await retry(run.id);
    if (nextRun) navigate(`/work/runs/${encodeURIComponent(nextRun.id)}`);
  };
  return (
    <div className="page-stack run-detail-page">
      <a href="/work" className="back-link" onClick={(event) => { event.preventDefault(); navigate("/work"); }}><ArrowLeft className="h-4 w-4" />返回工作台</a>
      <section className="run-detail-heading"><div><div className="run-id-row"><code className="run-id">{run.id}</code><Button variant="ghost" size="icon" className="run-id-copy" aria-label="复制 run-id" title={copyStatus === "copied" ? "已复制" : "复制 run-id"} onClick={() => void copyRunId()}><Copy className="h-4 w-4" /></Button>{copyStatus !== "idle" && <span className={cn("run-id-copy-status", copyStatus === "error" && "is-error")} role="status">{copyStatus === "copied" ? "已复制" : "复制失败"}</span>}</div><h1>{run.title}</h1><p className="page-subtitle">{pack?.title} · {flow?.title} · {pack?.version}</p></div><WorkflowStatusBadge status={run.status} /></section>
      {(canCancel || canRetry) && <div className="run-detail-actions"><div className="card-actions">{run.status === "waiting" && <Button onClick={() => void approve(run.id)}><CheckCircle2 className="h-4 w-4" />批准继续</Button>}{canCancel && <Button variant="outline" onClick={() => void cancel(run.id)}><Square className="h-4 w-4" />取消运行</Button>}{canRetry && <Button onClick={() => void retryAndOpen()}><RotateCcw className="h-4 w-4" />重试</Button>}</div></div>}
      <div className="run-detail-layout">
        <div className="run-detail-main">
          <Card><CardHeader><CardTitle>运行进度</CardTitle><CardDescription>{run.summary}</CardDescription></CardHeader><CardContent><div className="run-progress run-progress-large"><span style={{ width: `${run.progress}%` }} /></div><div className="run-progress-meta"><span>{run.progress}% 完成</span><span>{workflowExecutionTargetLabel(run)}</span></div></CardContent></Card>
          <Card><CardHeader><CardTitle>运行轨迹</CardTitle><CardDescription>每个状态都来自同一个 run projection。</CardDescription></CardHeader><CardContent><div className="run-timeline">{run.events.map((event) => <div className="timeline-item" key={event.id}><span className={cn("timeline-dot", `timeline-dot-${event.tone}`)} /><div><div className="timeline-title"><strong>{event.title}</strong><time>{event.timestamp.slice(11, 16)}</time></div><p>{event.detail}</p></div></div>)}</div></CardContent></Card>
          {run.error && <Card className="run-error-card"><CardHeader><CardTitle>需要处理</CardTitle></CardHeader><CardContent><p>{run.error.message}</p><code>{run.error.code}</code></CardContent></Card>}
          {run.artifacts.length > 0 && <Card><CardHeader><CardTitle>产物</CardTitle><CardDescription>{run.driver === "none" ? "结果由 Polaris host 管理，Portal 只展示受控投影。" : "结果仍属于目标 Vault，Portal 只展示受控投影。"}</CardDescription></CardHeader><CardContent><div className="artifact-list">{run.artifacts.map((item) => <button type="button" className="artifact-row" key={item.id} onClick={() => setArtifact(item)}><span className="artifact-icon"><FileText className="h-4 w-4" /></span><span><strong>{item.name}</strong><small>{item.summary} · {item.size}</small></span><ExternalLink className="h-4 w-4" /></button>)}</div></CardContent></Card>}
        </div>
          <aside className="run-detail-side"><Card><CardHeader><CardTitle>执行上下文</CardTitle></CardHeader><CardContent><dl className="data-rows compact-data-rows"><div className="data-row"><dt>Domain Pack</dt><dd>{pack?.title || run.packId}</dd></div><div className="data-row"><dt>版本</dt><dd>{pack?.version || "—"}</dd></div><div className="data-row"><dt>{run.driver === "none" ? "执行位置" : "目标 Vault"}</dt><dd>{workflowExecutionTargetLabel(run)}</dd></div><div className="data-row"><dt>运行策略</dt><dd>{run.approvalRequired ? "需要确认" : "自动完成"}</dd></div><div className="data-row"><dt>创建时间</dt><dd>{formatRunDateTime(run.createdAt)}</dd></div></dl></CardContent></Card><Card><CardHeader><CardTitle>输入快照</CardTitle><CardDescription>提交时固定，不跟随设置变化。</CardDescription></CardHeader><CardContent><dl className="input-snapshot">{Object.entries(run.input).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></CardContent></Card></aside>
      </div>
      {artifact && <ArtifactPreview runId={run.id} artifact={artifact} onClose={() => setArtifact(null)} />}
    </div>
  );
}

function ArtifactPreview({ runId, artifact, onClose }: { runId: string; artifact: MockWorkflowRun["artifacts"][number]; onClose: () => void }) {
  const previewKind = artifactPreviewKind(artifact.name);
  const source = artifactPreviewSource(artifact.content)
    ?? (!artifact.redacted && ["image", "video", "audio", "pdf"].includes(previewKind)
      ? artifactPreviewUrl(runId, artifact.id)
      : null);
  return <div className="modal-backdrop" role="presentation" onClick={onClose}><section className="modal artifact-modal" role="dialog" aria-modal="true" aria-label={artifact.name} onClick={(event) => event.stopPropagation()}><div className="modal-header"><div><p className="eyebrow">ARTIFACT PREVIEW</p><h2>{artifact.name}</h2><p>{artifact.summary} · {artifact.size}</p></div><Button variant="ghost" size="icon" aria-label="关闭" title="关闭" onClick={onClose}><X className="h-4 w-4" /></Button></div><ArtifactPreviewContent kind={previewKind} content={artifact.content} source={source} redacted={artifact.redacted} /></section></div>;
}

function ArtifactPreviewContent({
  kind,
  content,
  source,
  redacted,
}: {
  kind: ArtifactPreviewKind;
  content: string;
  source: string | null;
  redacted?: boolean;
}) {
  if (redacted) {
    return <div className="artifact-content artifact-unavailable"><strong>此文件已脱敏</strong><span>当前仅提供文件元数据，原始内容不会在 Portal 中展示。</span><code>{content}</code></div>;
  }
  if (kind === "image" && source) {
    return <div className="artifact-content artifact-media-content"><img src={source} alt="产物预览" /></div>;
  }
  if (kind === "video" && source) {
    return <div className="artifact-content artifact-media-content"><video controls preload="metadata" src={source}>当前浏览器不支持视频预览。</video></div>;
  }
  if (kind === "audio" && source) {
    return <div className="artifact-content artifact-media-content artifact-audio-content"><audio controls preload="metadata" src={source}>当前浏览器不支持音频预览。</audio></div>;
  }
  if (kind === "pdf" && source) {
    return <div className="artifact-content artifact-pdf-content"><iframe src={source} title="PDF 产物预览" /></div>;
  }
  if (kind === "image" || kind === "video" || kind === "audio" || kind === "pdf" || kind === "binary") {
    return <div className="artifact-content artifact-unavailable"><strong>暂时无法直接预览此文件</strong><span>当前投影只包含文件元数据，没有可渲染的文件源。</span><code>{content}</code></div>;
  }
  const displayContent = kind === "json" ? formatJsonArtifact(content) : content;
  return <pre className={cn("artifact-content", `artifact-content-${kind}`)}><code>{displayContent}</code></pre>;
}

function HostsPage({ session, navigate }: { session: ShellSession; navigate: (path: string, replace?: boolean) => void }) {
  const hostsByName = usePortalStore((state) => state.hostsByName);
  const error = usePortalStore((state) => state.error);
  const refreshHosts = usePortalStore((state) => state.refreshHosts);
  const connectLiveStream = usePortalStore((state) => state.connectLiveStream);
  const closeLiveStream = usePortalStore((state) => state.closeLiveStream);
  const hosts = useMemo(() => Object.values(hostsByName).sort((left, right) => left.name.localeCompare(right.name)), [hostsByName]);
  const [vaultFilter, setVaultFilter] = useState<"all" | "running" | "observing" | "inactive">("all");
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!session.polarisUserId) return;
    void refreshHosts().catch(() => undefined);
    connectLiveStream(session.polarisUserId);
    return closeLiveStream;
  }, [closeLiveStream, connectLiveStream, refreshHosts, session.polarisUserId]);

  const runningHosts = hosts.filter((host) => host.status?.driver?.status === "running");
  const observingHosts = hosts.filter((host) => ["starting", "stopping"].includes(host.status?.driver?.status || ""));
  const inactiveHosts = hosts.filter((host) => !["running", "starting", "stopping"].includes(host.status?.driver?.status || ""));
  const visibleHosts = vaultFilter === "running" ? runningHosts : vaultFilter === "observing" ? observingHosts : vaultFilter === "inactive" ? inactiveHosts : hosts;
  const vaultTabs = [
    ["all", "全部", hosts.length],
    ["running", "运行中", runningHosts.length],
    ["observing", "处理中", observingHosts.length],
    ["inactive", "未运行", inactiveHosts.length],
  ] as const;
  return (
    <div className="page-stack vaults-page">
      <div className="vaults-toolbar">
        <div className="filter-tabs vault-filter-tabs" role="tablist" aria-label="Vault 筛选">
          {vaultTabs.map(([value, label, count]) => <button key={value} type="button" role="tab" aria-selected={vaultFilter === value} className={cn("filter-tab", vaultFilter === value && "is-active")} onClick={() => setVaultFilter(value)}>{label}<span className="filter-tab-count">{count}</span></button>)}
        </div>
        <Button className="vault-toolbar-button" size="icon" aria-label="新建 Vault" title="新建 Vault" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /></Button>
      </div>
      {error && <ErrorBanner message={error} />}
      <div className="host-grid">
        {visibleHosts.map((host) => <HostCard key={host.name} host={host} session={session} navigate={navigate} />)}
        {visibleHosts.length === 0 && <EmptyState filtered={vaultFilter !== "all"} />}
      </div>
      {createOpen && <CreateHostModal session={session} onClose={() => setCreateOpen(false)} />}
    </div>
  );
}

function CreateHostModal({ session, onClose }: { session: ShellSession; onClose: () => void }) {
  const allowedLines = resolveAllowedVaultLines(session.line);
  const [hostName, setHostName] = useState("");
  const [line, setLine] = useState<PolarisVaultLine>(resolveDefaultVaultLine(session.line));
  const [createDefaultProject, setCreateDefaultProject] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const createHost = usePortalStore((state) => state.createHost);
  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = hostName.trim();
    if (!normalized) return;
    const validation = validatePolarisHostName(normalized);
    if (validation.error) {
      setFormError(validation.error);
      return;
    }
    setBusy(true); setFormError(null);
    try {
      await createHost({ hostName: normalized, line, createDefaultProject });
      setHostName("");
      onClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal create-vault-modal" role="dialog" aria-modal="true" aria-labelledby="create-vault-title" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div><p className="eyebrow">NEW VAULT</p><h2 id="create-vault-title">创建 Vault</h2><p>为当前订阅产品线准备一个隔离运行时。</p></div>
          <Button variant="ghost" size="icon" aria-label="关闭" title="关闭" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
        <form className="form-stack" onSubmit={onSubmit}>
          <label className="field-label" htmlFor="host-name">Vault 名称</label>
          <Input id="host-name" value={hostName} onChange={(event) => setHostName(event.target.value)} placeholder="例如 sample-vault" maxLength={63} required />
          <label className="field-label" htmlFor="host-line">产品线</label>
          <select id="host-line" className="select" value={line} onChange={(event) => setLine(event.target.value as PolarisVaultLine)}>
            {allowedLines.map((item) => <option value={item} key={item}>{item === "vertical" ? "Vertical" : "Coding"}</option>)}
          </select>
          <label className="check-label"><input type="checkbox" checked={createDefaultProject} onChange={(event) => setCreateDefaultProject(event.target.checked)} /><span>创建默认库 <small>{DEFAULT_POLARIS_VAULT_PATH}</small></span></label>
          {formError && <p className="form-error">{formError}</p>}
          <div className="modal-actions"><Button type="button" variant="ghost" onClick={onClose}>取消</Button><Button type="submit" disabled={busy || !hostName.trim()}><Plus className="h-4 w-4" />{busy ? "正在创建" : "创建并启动"}</Button></div>
        </form>
      </section>
    </div>
  );
}

function HostCard({ host, session, navigate }: { host: ShellHostSummary; session: ShellSession; navigate: (path: string) => void }) {
  const pending = usePortalStore((state) => state.pendingHosts[host.name] === true);
  const hostAction = usePortalStore((state) => state.hostAction);
  const deleteHost = usePortalStore((state) => state.deleteHost);
  const status = host.status?.driver?.status || "unknown";
  const actions = resolveShellHostActions({ session, host });
  const isWorking = status === "starting" || status === "stopping";
  const isRunning = status === "running";
  const statusVariant = isRunning ? "success" : isWorking ? "warning" : status === "error" ? "danger" : "muted";
  const statusLabel = { running: "运行中", starting: "启动中", stopping: "停止中", stopped: "已停止", error: "错误" }[status] || "未就绪";
  const surface = host.surfaces.includes("wanghai") ? "Vertical surface" : "Coding surface";
  return (
    <Card className="host-card">
      <CardHeader className="host-card-header">
        <div className="host-card-title-row"><div><CardTitle>{host.name}</CardTitle><CardDescription>{surface}</CardDescription></div><Badge variant={statusVariant}>{statusLabel}</Badge></div>
      </CardHeader>
      <CardContent>
        <div className="host-meta"><span><span className="meta-label">驱动</span>{host.status?.driver?.status || "未选择"}</span><span><span className="meta-label">Paseo</span>{host.status?.paseo?.web || "等待配对"}</span></div>
        <div className="card-actions">
          {actions.map((action) => <Button key={action.kind} variant="outline" onClick={() => navigate(action.href)} disabled={pending || !isRunning}>{action.kind === "open-coding" ? <><Code2 className="h-4 w-4" />Coding</> : <><MonitorPlay className="h-4 w-4" />Vertical</>}</Button>)}
          <Button variant="secondary" onClick={() => void hostAction(host.name, isRunning ? "stop" : "start")} disabled={pending || isWorking}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : isRunning ? <Square className="h-4 w-4" /> : <Wifi className="h-4 w-4" />}
            {isRunning ? "停止" : "启动"}
          </Button>
          <Button variant="ghost" size="icon" aria-label={`删除 ${host.name}`} title="删除主机" onClick={() => { if (window.confirm(`删除主机“${host.name}”？此操作不可撤销。`)) void deleteHost(host.name); }} disabled={pending}><Trash2 className="h-4 w-4 text-destructive" /></Button>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return <div className="empty-state"><FolderOpen className="h-7 w-7" /><strong>{filtered ? "当前没有匹配的 Vault" : "还没有 Vault"}</strong><span>{filtered ? "切换筛选查看其他 Vault。" : "点击右侧“新建”创建第一个隔离运行时。"}</span></div>;
}

function UserPage({ session }: { session: ShellSession }) {
  const user = usePortalStore((state) => state.user);
  const loadUser = usePortalStore((state) => state.loadUser);
  const readCredential = usePortalStore((state) => state.readCredential);
  const signOut = usePortalStore((state) => state.signOut);
  const [record, setRecord] = useState<PortalCredentialRecord | null>(null);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"profile" | "credentials" | "session">("profile");
  useEffect(() => { void loadUser().catch(() => undefined); }, [loadUser]);
  if (!user) return <LoadingView label="正在加载账户" />;
  const profileRows = [["用户名称", user.profile.name || user.session.authingUsername || "未设置"], ["邮箱", user.profile.email || "未设置"], ["用户 ID", user.session.userId], ["Authing ID", user.session.authingUserId], ["角色", user.session.role || "未设置"], ["产品线", user.session.line || "coding"], ["套餐", user.session.plan || "free"]];
  return (
    <div className="page-stack narrow-page">
      <div className="filter-tabs account-tabs" role="tablist" aria-label="账户信息">
        <button type="button" role="tab" aria-selected={activeTab === "profile"} aria-controls="account-profile-panel" className={cn("filter-tab", activeTab === "profile" && "is-active")} onClick={() => setActiveTab("profile")}>基本信息</button>
        <button type="button" role="tab" aria-selected={activeTab === "credentials"} aria-controls="account-credentials-panel" className={cn("filter-tab", activeTab === "credentials" && "is-active")} onClick={() => setActiveTab("credentials")}>凭证</button>
        <button type="button" role="tab" aria-selected={activeTab === "session"} aria-controls="account-session-panel" className={cn("filter-tab", activeTab === "session" && "is-active")} onClick={() => setActiveTab("session")}>会话</button>
      </div>
      {activeTab === "profile" && <section className="account-tab-panel" id="account-profile-panel" role="tabpanel"><Card><CardContent><dl className="data-rows">{profileRows.map(([label, value]) => <div className="data-row" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></CardContent></Card></section>}
      {activeTab === "credentials" && <section className="account-tab-panel" id="account-credentials-panel" role="tabpanel"><Card><CardContent>{user.credentials.length === 0 ? <p className="empty-copy">还没有凭证。</p> : <div className="data-rows">{user.credentials.map((credential) => <CredentialRow key={credential.id} credential={credential} onOpen={async () => { try { setCredentialError(null); setRecord(await readCredential(user.session.userId, credential.id)); } catch (error) { setCredentialError(error instanceof Error ? error.message : String(error)); } }} />)}</div>}{credentialError && <p className="form-error">{credentialError}</p>}</CardContent></Card></section>}
      {activeTab === "session" && <section className="account-tab-panel" id="account-session-panel" role="tabpanel"><Card><CardContent><div className="session-row"><ShieldCheck className="h-5 w-5 text-[var(--portal-accent-bright)]" /><div><strong>{session.authMode === "disabled" ? "本地开发会话" : "Authing 会话"}</strong><p>{session.authMode === "disabled" ? "本地开发模式使用固定默认用户，无需登录或退出。" : "退出当前 Polaris 会话。"}</p></div></div>{session.authMode !== "disabled" && <Button variant="destructive" onClick={() => void signOut()}><LogOut className="h-4 w-4" />退出登录</Button>}</CardContent></Card></section>}
      {record && <CredentialDialog record={record} onClose={() => setRecord(null)} />}
    </div>
  );
}

function CredentialRow({ credential, onOpen }: { credential: PortalCredential; onOpen: () => void }) {
  return <div className="data-row"><dt>{credential.label}</dt><dd><span>{credential.paths.join(" · ") || credential.kind}</span>{credential.status === "ready" && <Button variant="ghost" size="sm" onClick={onOpen}><Eye className="h-4 w-4" />查看</Button>}</dd></div>;
}

function CredentialDialog({ record, onClose }: { record: PortalCredentialRecord; onClose: () => void }) {
  return <div className="modal-backdrop" role="presentation" onClick={onClose}><section className="modal" role="dialog" aria-modal="true" aria-label={record.credential.label} onClick={(event) => event.stopPropagation()}><div className="modal-header"><div><h2>{record.credential.label}</h2><p>受控凭证预览</p></div><Button variant="ghost" size="icon" aria-label="关闭" title="关闭" onClick={onClose}><X className="h-4 w-4" /></Button></div>{record.files.map((file) => <pre key={file.key} className="credential-file"><code>{file.sourcePath}{"\n"}{file.content}</code></pre>)}</section></div>;
}

function WelcomePage({ navigate, session }: { navigate: (path: string, replace?: boolean) => void; session: ShellSession | null }) {
  const [config, setConfig] = useState<AuthingConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void authingConfig().then(setConfig).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }, []);
  useEffect(() => { if (session?.authenticated) navigate("/work", true); }, [navigate, session]);
  const signIn = async () => { if (!config) return; try { await beginSignIn(config, "/work"); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  return <div className="welcome-page"><div className="welcome-panel"><div className="welcome-mark"><Orbit className="h-7 w-7" /></div><p className="eyebrow">POLARIS PORTAL</p><h1>隔离运行时控制台</h1><p className="page-subtitle">每天从工作卡片开始，把每项任务交给正确的 Vault。</p>{error && <ErrorBanner message={error} />}{config?.authMode === "disabled" ? <Button onClick={() => navigate("/work", true)}><ArrowRight className="h-4 w-4" />进入工作台</Button> : <Button onClick={() => void signIn()} disabled={!config}><ArrowRight className="h-4 w-4" />登录</Button>}</div></div>;
}

function AuthCallbackPage({ navigate }: { navigate: (path: string, replace?: boolean) => void }) {
  const bootstrap = usePortalStore((state) => state.bootstrap);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void completeSignIn().then(async (returnPath) => { await bootstrap(); navigate(returnPath === "/welcome" ? "/work" : returnPath, true); }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [bootstrap, navigate]);
  return error ? <div className="center-state"><ErrorBanner message={error} /><Button onClick={() => navigate("/welcome", true)}><ArrowLeft className="h-4 w-4" />返回登录</Button></div> : <LoadingView label="正在完成登录" />;
}

function SurfacePage({ kind, id, navigate }: { kind: "coding" | "wanghai"; id: string; navigate: (path: string, replace?: boolean) => void }) {
  const session = usePortalStore((state) => state.session);
  const refreshHosts = usePortalStore((state) => state.refreshHosts);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void (async () => {
      try {
        await refreshHosts();
        const host = Object.values(usePortalStore.getState().hostsByName).find((item) => kind === "coding" ? item.serverId === id : item.wanghaiId === id);
        if (!host) throw new Error("工作面不存在或当前账户无权访问");
        if (kind === "coding") {
          const url = await resolvePaseoUrl(`/v/${encodeURIComponent(id)}/coding`, host.status?.paseo?.reconnectTarget);
          if (!cancelled) setSource(url);
        } else {
          const action = resolveWanghaiPortalAction({ session, host });
          if (!action) throw new Error("当前账户无权访问 Vertical 工作面");
          const launch = await request<{ portalUrl: string }>(`/g/${encodeURIComponent(id)}/launch`, { method: "POST" });
          if (!cancelled) setSource(launch.portalUrl);
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => { cancelled = true; };
  }, [id, kind, refreshHosts, session]);
  if (error) return <div className="center-state"><ErrorBanner message={error} /><Button variant="outline" onClick={() => navigate("/hosts", true)}><ArrowLeft className="h-4 w-4" />返回主机</Button></div>;
  return <div className="surface-page"><a href="/hosts" className={cn(buttonVariants({ variant: "secondary" }), "surface-back")} onClick={(event) => { event.preventDefault(); navigate("/hosts"); }}><ArrowLeft className="h-4 w-4" />返回主机</a>{source ? <iframe className="surface-frame" title={kind === "coding" ? "Coding 工作面" : "Vertical 工作面"} src={source} allow="clipboard-read; clipboard-write" /> : <LoadingView label="正在打开工作面" />}</div>;
}

function LoadingView({ label }: { label: string }) { return <div className="center-state"><Loader2 className="h-6 w-6 animate-spin text-primary" /><span>{label}</span></div>; }
function ErrorView({ message, onDismiss }: { message: string; onDismiss?: () => void }) { return <div className="center-state"><ErrorBanner message={message} />{onDismiss && <Button variant="ghost" onClick={onDismiss}>关闭</Button>}</div>; }
function ErrorBanner({ message }: { message: string }) { return <div className="error-banner"><X className="h-4 w-4" /><span>{message}</span></div>; }
