import { portalBase, portalHref, portalPathname } from "./portal-path.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Check,
  CircleAlert,
  Code2,
  Copy,
  Clock3,
  ExternalLink,
  Eye,
  FileText,
  FolderOpen,
  LayoutDashboard,
  Languages,
  Loader2,
  MonitorPlay,
  Orbit,
  Plus,
  Play,
  RotateCcw,
  Server,
  Sparkles,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
  Wifi,
  Wrench,
  Workflow,
  X,
} from "lucide-react";
import {
  DEFAULT_POLARIS_VAULT_PATH,
  resolveAllowedVaultLines,
  resolveDefaultVaultLine,
  PASEO_WEB_URL,
  resolveShellHostActions,
  resolveWanghaiPortalAction,
  validatePolarisHostName,
  type PolarisVaultLine,
  type ShellHostSummary,
  type ShellWorkspace,
  type WorkflowGraphProjection,
  type WorkflowStepGroupLog,
} from "@polaris/polaris-shell";
import { Button, buttonVariants } from "./components/ui/button.js";
import { Badge } from "./components/ui/badge.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card.js";
import { Input } from "./components/ui/input.js";
import {
  request,
  portalTools,
  workflowGraph,
  type PortalToolStatusReport,
  type PortalCredential,
} from "./portal-client.js";
import { usePortalStore } from "./portal-store.js";
import { cn } from "./lib/utils.js";
import {
  artifactPreviewKind,
  artifactPreviewSource,
  artifactPreviewUrl,
  formatJsonArtifact,
  workspaceFilePreviewUrl,
  type ArtifactPreviewKind,
} from "./artifact-preview.js";
import { formatRunDateTime } from "./formatters.js";
import {
  artifactPreviewPage,
  pathLabelParts,
  timelineAttempts,
  timelineCallBlock,
  workspaceFilePage,
  type TimelineAttempt,
  type TimelineCallBlock,
  type TimelineField,
  type TimelineValue,
} from "./timeline-call.js";
import { layoutWorkflowGraph } from "./workflow-graph-layout.js";
import { useI18n } from "./i18n/index.js";
import type { MessageKey } from "./i18n/messages.js";
import { localizedPackWarning, localizedWorkflowError, localizedWorkflowEvent, LocalizedError } from "./i18n/messages.js";
import { backTo, followPortalLink } from "./portal-navigation.js";
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
  const [path, setPath] = useState(() => portalPathname(window.location.pathname));
  useEffect(() => {
    const onPopState = () => setPath(portalPathname(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const navigate = useCallback((nextPath: string, replace = false) => {
    const state = { from: `${portalPathname(window.location.pathname)}${window.location.search}` };
    if (replace) window.history.replaceState(state, "", portalHref(nextPath));
    else window.history.pushState(state, "", portalHref(nextPath));
    setPath(portalPathname(window.location.pathname));
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
  const { t } = useI18n();
  const workspace = usePortalStore((state) => state.workspace);
  const bootstrapped = usePortalStore((state) => state.bootstrapped);
  const loading = usePortalStore((state) => state.loading);
  const error = usePortalStore((state) => state.error);
  const bootstrap = usePortalStore((state) => state.bootstrap);
  const clearError = usePortalStore((state) => state.clearError);
  const historyStatus = usePortalStore((state) => state.historyStatus);
  const historyError = usePortalStore((state) => state.historyError);
  const loadInitialHistory = usePortalStore((state) => state.loadInitialHistory);
  const needsHistory = /^\/work(?:\/|$)/u.test(path);

  useEffect(() => {
    if (workspace && !loading && needsHistory && historyStatus === "idle") void loadInitialHistory();
  }, [workspace, loading, needsHistory, historyStatus, loadInitialHistory]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (!bootstrapped || (!workspace && loading)) return <LoadingView label={t("common.loadingPortal")} />;
  if (!workspace) return <ErrorView message={error ? errorMessage(error, t) : t("common.workspaceUnavailable")} onRetry={() => void bootstrap()} />;
  if (path === "/") {
    queueMicrotask(() => navigate("/work", true));
    return <LoadingView label={t("common.openingWorkspace")} />;
  }
  if (loading || (needsHistory && historyStatus !== "ready")) {
    const active = path.startsWith("/hosts") ? "hosts" : path.startsWith("/settings/tools") ? "tools" : needsHistory ? "work" : "workflows";
    return <PortalLayout active={active} workspace={workspace} navigate={navigate}>
      {needsHistory && historyStatus === "failed"
        ? <ErrorView message={errorMessage(historyError, t)} onRetry={() => void loadInitialHistory()} />
        : <LoadingView label={t(needsHistory ? "work.loadingRuns" : "common.loadingPortal")} />}
    </PortalLayout>;
  }
  if (path === "/work" || path === "/work/") {
    return <PortalLayout active="work" workspace={workspace} navigate={navigate}><WorkPage navigate={navigate} /></PortalLayout>;
  }
  if (path === "/debug" || path === "/debug/") {
    queueMicrotask(() => navigate("/work", true));
    return <LoadingView label={t("common.openingWorkspace")} />;
  }
  const artifactMatch = path.match(/^\/work\/runs\/([^/]+)\/artifacts\/([^/]+)$/u);
  if (artifactMatch) {
    return <PortalLayout active="work" workspace={workspace} navigate={navigate}><RunPreviewPage runId={decodeURIComponent(artifactMatch[1])} kind="artifact" target={decodeURIComponent(artifactMatch[2])} navigate={navigate} /></PortalLayout>;
  }
  const fileMatch = path.match(/^\/work\/runs\/([^/]+)\/files\/(.+)$/u);
  if (fileMatch) {
    return <PortalLayout active="work" workspace={workspace} navigate={navigate}><RunPreviewPage runId={decodeURIComponent(fileMatch[1])} kind="file" target={decodeURIComponent(fileMatch[2])} navigate={navigate} /></PortalLayout>;
  }
  const runMatch = path.match(/^\/work\/runs\/([^/]+)$/u);
  if (runMatch) {
    return <PortalLayout active="work" workspace={workspace} navigate={navigate}><RunDetailPage runId={decodeURIComponent(runMatch[1])} navigate={navigate} /></PortalLayout>;
  }
  if (path === "/settings" || path === "/settings/workflows" || path === "/settings/workflows/") {
    return <PortalLayout active="workflows" workspace={workspace} navigate={navigate}><WorkflowSettingsPage navigate={navigate} /></PortalLayout>;
  }
  const graphMatch = path.match(/^\/settings\/workflows\/([^/]+)\/([^/]+)\/graph$/u);
  if (graphMatch) {
    return <PortalLayout active="workflows" workspace={workspace} navigate={navigate}>
      <WorkflowGraphPage
        packId={decodeURIComponent(graphMatch[1])}
        flowId={decodeURIComponent(graphMatch[2])}
        navigate={navigate}
      />
    </PortalLayout>;
  }
  if (error) return <ErrorView message={errorMessage(error, t)} onDismiss={clearError} />;
  return <ErrorView message={t("common.notFound")} />;
}

function PortalLayout({
  active,
  workspace,
  navigate,
  children,
}: {
  active: "work" | "hosts" | "workflows" | "tools";
  workspace: ShellWorkspace;
  navigate: (path: string, replace?: boolean) => void;
  children: React.ReactNode;
}) {
  const { t, toggleLanguage } = useI18n();
  const link = (path: string, label: string, Icon: typeof Server, key: "work" | "hosts" | "workflows" | "tools") => (
    <a
      href={portalHref(path)}
      onClick={(event) => followPortalLink(event, () => navigate(path))}
      aria-current={active === key ? "page" : undefined}
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
          <a href={portalHref("/work")} className="brand" onClick={(event) => followPortalLink(event, () => navigate("/work"))}>
            <span className="brand-mark"><Orbit className="h-5 w-5" /></span>
            <span>POLARIS</span>
          </a>
          <nav className="portal-nav" aria-label={t("nav.workflows")}>
            {link("/work", t("nav.work"), LayoutDashboard, "work")}
            {link("/settings/workflows", t("nav.workflows"), Workflow, "workflows")}
          </nav>
          <div className="portal-topbar-actions">
            <Button variant="ghost" size="icon" aria-label={t("nav.language")} title={t("nav.language")} onClick={toggleLanguage}>
              <Languages className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>
      <main className="portal-main">{children}</main>
    </div>
  );
}

const WORKFLOW_STATUS_VARIANTS: Record<WorkflowStatus, "default" | "secondary" | "success" | "warning" | "muted" | "danger"> = {
  queued: "muted",
  running: "default",
  waiting: "warning",
  succeeded: "success",
  failed: "danger",
  cancelled: "muted",
};

const WORKFLOW_PRIORITY_KEYS: Record<WorkflowPriority, "priority.urgent" | "priority.normal" | "priority.low"> = {
  urgent: "priority.urgent",
  normal: "priority.normal",
  low: "priority.low",
};

function WorkflowStatusBadge({ status }: { status: WorkflowStatus }) {
  const { t } = useI18n();
  return <Badge variant={WORKFLOW_STATUS_VARIANTS[status]}>{t(`status.${status}` as const)}</Badge>;
}

function workflowVaultStatusLabel(vault: { canRun: boolean }, t: ReturnType<typeof useI18n>["t"]): string {
  return vault.canRun ? t("status.running") : t("status.failed");
}

function workflowExecutionTargetLabel(
  run: { driver?: "none" | "vault"; vaultName: string },
  t: ReturnType<typeof useI18n>["t"],
): string {
  return run.driver === "none" ? t("common.host") : run.vaultName;
}

function hostDriverStatusLabel(
  status: string | undefined,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (!status) return t("common.notSelected");
  const key = {
    running: "status.running",
    starting: "status.starting",
    stopping: "status.stopping",
    stopped: "status.stopped",
    error: "status.error",
  }[status] as "status.running" | "status.starting" | "status.stopping" | "status.stopped" | "status.error" | undefined;
  return key ? t(key) : status;
}

function errorMessage(reason: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  if (reason instanceof LocalizedError) return t(reason.key, reason.values);
  if (reason && typeof reason === "object" && "code" in reason && typeof reason.code === "string" && "message" in reason && typeof reason.message === "string") {
    return localizedWorkflowError({ code: reason.code, message: reason.message }, t);
  }
  return reason instanceof Error ? reason.message : String(reason);
}

function formatInputSnapshotValue(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
}

function TimelineScalar({ value }: { value: Extract<TimelineValue, { kind: "scalar" }> }) {
  return <span className={cn("timeline-scalar", `timeline-scalar-${value.tone}`)}>{value.text}</span>;
}

function TimelineFileChip({
  runId,
  value,
  navigate,
}: {
  runId: string;
  value: Extract<TimelineValue, { kind: "file" }>;
  navigate: (path: string, replace?: boolean) => void;
}) {
  const { t } = useI18n();
  const href = workspaceFilePage(runId, value.path);
  return (
    <span className="timeline-file">
      <code className="timeline-file-path">{pathLabelParts(value.label).map((part, index) => <span key={`${part}-${index}`}>{index > 0 && <>/<wbr /></>}{part}</span>)}</code>
      <a
        href={portalHref(href)}
        className="timeline-file-open"
        aria-label={t("run.openFile", { name: value.label })}
        title={t("run.openFile", { name: value.label })}
        onClick={(event) => followPortalLink(event, () => navigate(href))}
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </span>
  );
}

function TimelineValueView({
  runId,
  value,
  navigate,
}: {
  runId: string;
  value: TimelineValue;
  navigate: (path: string, replace?: boolean) => void;
}) {
  return value.kind === "file"
    ? <TimelineFileChip runId={runId} value={value} navigate={navigate} />
    : <TimelineScalar value={value} />;
}

function TimelineFieldList({
  runId,
  fields,
  navigate,
}: {
  runId: string;
  fields: TimelineField[];
  navigate: (path: string, replace?: boolean) => void;
}) {
  return (
    <span className="timeline-field-list">
      {fields.map((field, index) => (
        <span className={cn("timeline-field", field.value.kind === "file" && "is-file")} key={field.key}>
          <span className="timeline-assign">
            <span className="timeline-key">{field.key}</span>
            <span className="timeline-eq"> = </span>
          </span>
          <TimelineValueView runId={runId} value={field.value} navigate={navigate} />
          {index < fields.length - 1 && <span className="timeline-sep">, </span>}
        </span>
      ))}
    </span>
  );
}

function TimelineCallView({
  runId,
  block,
  fallback,
  navigate,
}: {
  runId: string;
  block: TimelineCallBlock | null;
  fallback: string;
  navigate: (path: string, replace?: boolean) => void;
}) {
  const { t } = useI18n();
  if (!block) return <p>{fallback}</p>;
  return (
    <p className="timeline-call">
      {block.call && <span className="timeline-call-lead"><span className="timeline-call-label">{t("run.call")}</span> <code className="timeline-call-name">{block.call}</code></span>}
      {block.uses.length > 0 && <> <span className="timeline-call-section"><span className="timeline-call-label">{t("run.callUses")}</span> <span className="timeline-brace">{"{"}</span><TimelineFieldList runId={runId} fields={block.uses} navigate={navigate} /><span className="timeline-brace">{"}"}</span></span></>}
      {block.outputs.length > 0 && <> <span className="timeline-call-section"><span className="timeline-arrow">→</span> <span className="timeline-call-label">{t("run.callOut")}</span> <span className="timeline-brace">{"{"}</span><TimelineFieldList runId={runId} fields={block.outputs} navigate={navigate} /><span className="timeline-brace">{"}"}</span></span></>}
      {block.note && <span className="timeline-note"> · {block.note}</span>}
    </p>
  );
}

/** DSL v2 structured group badge (PRD 3.13.5): parallel branch / choice path /
 * iteration / subflow, localized by kind + values. */
function timelineGroupLabel(
  group: WorkflowStepGroupLog,
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
): string {
  switch (group.kind) {
    case "parallel":
      return t("run.groupParallel", { branch: group.branch ?? "" });
    case "choice":
      return t("run.groupChoice", { when: group.when ?? group.branch ?? "" });
    case "forEach":
      return t("run.groupForEach", { iteration: group.iteration ?? 0 });
    case "while":
      return t("run.groupWhile", { iteration: group.iteration ?? 0 });
    case "subflow":
      return t("run.groupSubflow");
  }
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
  if (!copied) throw new LocalizedError("common.clipboardFailed");
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
    const title = flow.groupTitle || "";
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
  const { t } = useI18n();
  const cards = usePortalStore((state) => state.cards);
  const runs = usePortalStore((state) => state.runs);
  const packs = usePortalStore((state) => state.packs);
  const [filter, setFilter] = useState<"all" | "attention" | "running" | "done">("all");
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const initialWorkflow = useMemo(() => {
    const query = new URLSearchParams(window.location.search);
    return {
      packId: query.get("pack") || undefined,
      flowId: query.get("flow") || undefined,
    };
  }, []);
  const [composerOpen, setComposerOpen] = useState(Boolean(initialWorkflow.packId || initialWorkflow.flowId));
  const visibleCards = useMemo(() => cards
    .filter((card) => {
      if (filter === "attention") return card.status === "waiting";
      if (filter === "running") return ["queued", "running"].includes(card.status);
      if (filter === "done") return ["succeeded", "failed", "cancelled"].includes(card.status);
      return true;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [cards, filter]);
  const counts = useMemo(() => ({
    all: cards.length,
    attention: cards.filter((card) => card.status === "waiting").length,
    running: cards.filter((card) => ["queued", "running"].includes(card.status)).length,
    done: cards.filter((card) => ["succeeded", "failed", "cancelled"].includes(card.status)).length,
  }), [cards]);
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
        <div className="filter-tabs work-filter-tabs" role="tablist" aria-label={t("work.filter")}>
          {([
            ["all", t("work.all")],
            ["attention", t("work.attention")],
            ["running", t("work.running")],
            ["done", t("work.done")],
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
              <span className="filter-tab-count">{counts[value]}</span>
            </button>
          ))}
        </div>

      </div>

      <div className="work-grid-view" aria-live="polite">
        {visibleCards.map((card) => {
          const run = runs[card.runId];
          return run ? <WorkListRow key={card.id} card={card} run={run} packs={packs} navigate={navigate} /> : null;
        })}
        {!visibleCards.length && <div className="empty-state"><FolderOpen className="h-7 w-7" /><strong>{t("work.emptyTitle")}</strong><span>{t("work.emptyDescription")}</span></div>}
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
              {!activeCard && <div className="empty-state deck-empty"><FolderOpen className="h-7 w-7" /><strong>{t("work.emptyTitle")}</strong><span>{t("work.emptyDescription")}</span></div>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function WorkListRow({
  card,
  run,
  packs,
  navigate,
}: {
  card: { priority: WorkflowPriority; status: WorkflowStatus; title: string; summary: string; vaultName: string; updatedAt: string };
  run: MockWorkflowRun;
  packs: MockDomainPack[];
  navigate: (path: string, replace?: boolean) => void;
}) {
  const { t } = useI18n();
  const approve = usePortalStore((state) => state.approveWorkflowRun);
  const cancel = usePortalStore((state) => state.cancelWorkflowRun);
  const retry = usePortalStore((state) => state.retryWorkflowRun);
  const deleteRun = usePortalStore((state) => state.deleteWorkflowRun);
  const [busy, setBusy] = useState(false);
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
  return (
    <div className={cn("work-list-row", card.status === "waiting" && "work-list-row-attention")}>
      <div className="work-list-main">
        <div className="work-list-kind">{pack?.category || t("work.workflow")}<span className="work-card-separator">·</span>{flow?.title || run.flowId}</div>
        <strong>{card.title}</strong>
        <span>{card.summary}</span>
      </div>
      <div className="work-list-meta">
        <span><Server className="h-3.5 w-3.5" />{card.vaultName}</span>
        <span><Clock3 className="h-3.5 w-3.5" />{t("work.updatedAt")} {formatRunDateTime(card.updatedAt)}</span>
      </div>
      <div className="work-list-status">
        <WorkflowStatusBadge status={card.status} />
        {run.status === "running" && <span className="progress-label">{run.progress}%</span>}
      </div>
      <div className="work-list-actions">
        <Button size="sm" variant={card.status === "waiting" ? "ghost" : "outline"} onClick={() => navigate(`/work/runs/${encodeURIComponent(run.id)}`)}>
          {t("work.viewDetails")}<ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
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
  const { t } = useI18n();
  const focus = {
    queued: { label: t("status.queued"), detail: `${workflowExecutionTargetLabel(run, t)} · ${t("status.queued")}`, icon: Clock3, tone: "blue" },
    running: { label: t("status.running"), detail: t("run.timelineDescription"), icon: Loader2, tone: "green" },
    waiting: { label: t("status.waiting"), detail: t("run.needsConfirmation"), icon: CircleAlert, tone: "amber" },
    succeeded: { label: t("status.succeeded"), detail: `${run.artifacts.length || 1} ${t("run.outputs")}`, icon: CheckCircle2, tone: "green" },
    failed: { label: t("status.failed"), detail: t("common.retry"), icon: CircleAlert, tone: "red" },
    cancelled: { label: t("status.cancelled"), detail: t("common.retry"), icon: RotateCcw, tone: "red" },
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
  const { t } = useI18n();
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
        {dragX < 0 ? <><ArrowLeft className="h-4 w-4" />{t("work.swipeSkip")}</> : <><ArrowRight className="h-4 w-4" />{t("work.swipeDetails")}</>}
      </div>}
      <CardHeader className="work-card-header">
        <div className="work-card-topline">
          <div className="work-card-kind"><span className={cn("pack-dot", `pack-dot-${pack?.accent || "green"}`)} />{pack?.category || t("work.workflow")}<span className="work-card-separator">·</span>{flow?.title || run.flowId}</div>
          <WorkflowStatusBadge status={card.status} />
        </div>
        <div className="work-card-title-row"><CardTitle>{card.title}</CardTitle>{card.priority === "urgent" && <span className="attention-label">{t(WORKFLOW_PRIORITY_KEYS[card.priority])}</span>}</div>
        <CardDescription>{card.summary}</CardDescription>
      </CardHeader>
      <CardContent className="work-card-content">
        <div className="work-card-meta"><span><Server className="h-3.5 w-3.5" />{card.vaultName}</span><span><Clock3 className="h-3.5 w-3.5" />{t("work.updatedAt")} {formatRunDateTime(card.updatedAt)}</span>{run.progress > 0 && run.status === "running" && <span className="progress-label">{run.progress}%</span>}</div>
        {run.status === "running" && <div className="run-progress"><span style={{ width: `${run.progress}%` }} /></div>}
        <WorkflowFocus run={run} />
        <div className="card-actions work-card-actions">
          <Button variant={card.status === "waiting" ? "ghost" : "outline"} onClick={() => navigate(`/work/runs/${encodeURIComponent(run.id)}`)}>
            <>{t("work.viewDetails")}<ChevronRight className="h-4 w-4" /></>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function WorkflowSettingsPage({ navigate }: { navigate: (path: string, replace?: boolean) => void }) {
  const { t } = useI18n();
  const packs = usePortalStore((state) => state.packs);
  const setup = usePortalStore((state) => state.setup);
  const toggleWorkflow = usePortalStore((state) => state.toggleWorkflow);
  const settingsQuery = useMemo(() => new URLSearchParams(window.location.search), []);
  const [activeTab, setActiveTab] = useState<"all" | "enabled" | "available">(
    settingsQuery.get("tab") === "enabled" || settingsQuery.get("tab") === "available"
      ? settingsQuery.get("tab") as "enabled" | "available"
      : "all",
  );
  const [activePackId, setActivePackId] = useState(
    settingsQuery.get("pack") || setup.domainPackId || packs[0]?.id || "",
  );
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
      <div className="settings-toolbar">
        <div className="filter-tabs settings-tabs" role="tablist" aria-label={t("settings.settingsTab")}>
          <button type="button" role="tab" aria-selected={activeTab === "all"} className={cn("filter-tab", activeTab === "all" && "is-active")} onClick={() => setActiveTab("all")}>{t("settings.all")}<span className="filter-tab-count">{allWorkflowCount}</span></button>
          <button type="button" role="tab" aria-selected={activeTab === "enabled"} className={cn("filter-tab", activeTab === "enabled" && "is-active")} onClick={() => setActiveTab("enabled")}>{t("settings.enabled")}<span className="filter-tab-count">{enabledWorkflowCount}</span></button>
          <button type="button" role="tab" aria-selected={activeTab === "available"} className={cn("filter-tab", activeTab === "available" && "is-active")} onClick={() => setActiveTab("available")}>{t("settings.available")}<span className="filter-tab-count">{availableWorkflowCount}</span></button>
        </div>
      </div>
      <div className="filter-tabs settings-pack-tabs" role="tablist" aria-label={t("settings.packTab")}>
        {visiblePacks.map((pack) => {
          const count = pack.flows.filter((flow) => enabledWorkflowKeys.has(workflowKey(pack.id, flow.id))).length;
          return <button type="button" role="tab" aria-selected={activePack?.id === pack.id} key={pack.id} className={cn("filter-tab settings-pack-tab", activePack?.id === pack.id && "is-active")} onClick={() => setActivePackId(pack.id)}>{pack.title}<span className="filter-tab-count">{count}/{pack.flows.length}</span></button>;
        })}
      </div>
      {!visiblePacks.length && <div className="empty-state"><FolderOpen className="h-7 w-7" /><strong>{t("public.emptyWorkflows")}</strong></div>}
      {activePack && <Card className="settings-pack-browser">
        <CardHeader>
          <div className="settings-pack-heading"><div><CardTitle>{activePack.title}</CardTitle><CardDescription>{activePack.category} · v{activePack.version} · {t("settings.enabledSummary", { enabled: enabledFlowCount, total: activePack.flows.length })}</CardDescription></div></div>
        </CardHeader>
        <CardContent>
          <p className="settings-pack-description">{activePack.description}</p>
          {activePack.warnings?.length ? <div className="settings-pack-warning" role="status"><CircleAlert className="h-4 w-4" /><span>{localizedPackWarning(activePack.warnings[0], t)}{activePack.warnings.length > 1 ? ` · ${t("settings.moreTools", { count: activePack.warnings.length - 1 })}` : ""}</span></div> : null}
          <div className="settings-flow-list">{groupWorkflowFlows(visibleFlows).map((group) => <section className="workflow-group" key={group.id}>{group.id !== "other" && <WorkflowGroupHeading group={group} />}{group.flows.map((flow) => {
            const enabled = enabledWorkflowKeys.has(workflowKey(activePack.id, flow.id));
            const returnQuery = `tab=${encodeURIComponent(activeTab)}&pack=${encodeURIComponent(activePack.id)}`;
            return <div className="settings-flow-row" key={flow.id}><span><strong>{flow.title}</strong><small>{flow.summary}</small></span><span className="settings-flow-actions"><span>{flow.estimate}{flow.approvalRequired ? ` · ${t("settings.flowApproval")}` : ""}</span><Button variant="ghost" size="icon" aria-label={t("settings.viewFlowDsl", { title: flow.title })} title={t("settings.viewDsl")} onClick={() => navigate(`/settings/workflows/${encodeURIComponent(activePack.id)}/${encodeURIComponent(flow.id)}/graph?${returnQuery}`)}><Eye className="h-4 w-4" /></Button></span></div>;
          })}</section>)}</div>
          {visibleFlows.length === 0 && <div className="empty-state settings-flow-empty">{t("settings.noMatchingFlows")}</div>}
          <div className="capability-list">{activePack.capabilities.map((capability) => <Badge key={capability} variant="outline">{capability}</Badge>)}</div>
        </CardContent>
      </Card>}
      {visiblePacks.length === 0 && <div className="empty-state">{t("settings.noMatchingPacks")}</div>}
    </div>
  );
}

function WorkflowGraphPage({
  packId,
  flowId,
  navigate,
}: {
  packId: string;
  flowId: string;
  navigate: (path: string, replace?: boolean) => void;
}) {
  const { t } = useI18n();
  const packs = usePortalStore((state) => state.packs);
  const pack = packs.find((candidate) => candidate.id === packId);
  const flow = pack?.flows.find((candidate) => candidate.id === flowId);
  const [graph, setGraph] = useState<WorkflowGraphProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const backPath = `/settings/workflows?tab=${encodeURIComponent(query.get("tab") || "all")}&pack=${encodeURIComponent(query.get("pack") || packId)}`;

  useEffect(() => {
    let active = true;
    setError(null);
    void workflowGraph(packId, flowId)
      .then((payload) => { if (active) setGraph(payload.graph); })
      .catch((reason) => { if (active) setError(errorMessage(reason, t)); });
    return () => { active = false; };
  }, [flowId, packId]);

  if (!pack || !flow) {
    return <div className="center-state"><ErrorBanner message={t("settings.graphNotFound")} /><Button variant="outline" onClick={() => backTo(backPath, navigate)}>{t("settings.back")}</Button></div>;
  }
  return (
    <div className="page-stack workflow-graph-page">
      <a href={portalHref(backPath)} className="back-link" onClick={(event) => followPortalLink(event, () => backTo(backPath, navigate))}><ArrowLeft className="h-4 w-4" />{t("settings.back")}</a>
      {Boolean(error) && <ErrorBanner message={errorMessage(error, t)} />}
      {!graph && !error && <LoadingView label={t("settings.loadingGraph")} />}
      {graph && <WorkflowGraphViewer graph={graph} />}
    </div>
  );
}

function WorkflowGraphViewer({ graph }: { graph: WorkflowGraphProjection }) {
  const { t } = useI18n();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const nodes = graph.flow.nodes;
  const edges = graph.flow.edges;
  const layout = useMemo(() => layoutWorkflowGraph(graph), [graph]);
  const selected = nodes.find((node) => node.id === selectedNodeId);
  return <div className="workflow-graph-surface">
    <div className="workflow-graph-canvas">
      <svg className="workflow-graph-svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label={t("settings.graphAria", { title: graph.flowTitle })}>
        <defs><marker id="workflow-graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor" /></marker></defs>
        {layout.edges.map(({ edge, d, fromX, fromY, toX, toY }, edgeIndex) => <g key={`${edge.from}-${edge.to}-${edge.field ?? edge.when ?? edgeIndex}`}><path d={d} markerEnd="url(#workflow-graph-arrow)" />{edge.when && <text x={(fromX + toX) / 2} y={(fromY + toY) / 2 - 4} className="workflow-graph-edge-when">{edge.when}</text>}</g>)}
        {nodes.map((node) => {
          const position = layout.positions.get(node.id);
          if (!position) return null;
          const constructKind = ["parallel", "choice", "forEach", "while", "subflow"].includes(node.kind) ? node.kind : null;
          return <g key={node.id} className={cn("workflow-graph-node", node.kind === "input" && "workflow-graph-node-input", node.kind === "output" && "workflow-graph-node-output", constructKind && `workflow-graph-node-${constructKind}`, node.group?.branch && "workflow-graph-node-branch", selectedNodeId === node.id && "is-selected")} transform={`translate(${position.x} ${position.y})`} onClick={() => setSelectedNodeId(node.id)} onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setSelectedNodeId(node.id);
            }
          }} tabIndex={0} role="button" aria-pressed={selectedNodeId === node.id} aria-label={node.label}>
            <rect width={layout.nodeWidth} height={layout.nodeHeight} rx="6" />
            <text x="14" y="24" className="workflow-graph-node-label">{node.label}</text>
            {node.call && <text x="14" y="44" className="workflow-graph-node-call">{t("run.graphCall", { port: node.call })}</text>}
            {node.group?.when && <text x="14" y={node.call ? 62 : 44} className="workflow-graph-node-when">{node.group.when}</text>}
            <text x="14" y={node.call ? (node.group?.when ? 82 : 66) : (node.group?.when ? 64 : 48)} className="workflow-graph-node-meta">{t("run.graphInputs")} {node.uses.length} · {t("run.graphOutputs")} {node.outputs.length}</text>
          </g>;
        })}
      </svg>
    </div>
    <div className="workflow-graph-footer">
      <div>{t("run.graphSummary", { steps: nodes.length - 2, dependencies: edges.length })}</div>
      <div className={cn("workflow-node-detail", !selected && "is-empty")} aria-live="polite"><strong>{selected?.label ?? t("run.selectNode")}</strong><span>{selected ? t("run.graphInputDetail", { values: selected.uses.join(t("common.listSeparator")) || "—" }) : t("run.selectNodeHint")}</span><span>{selected ? t("run.graphOutputDetail", { values: selected.outputs.join(t("common.listSeparator")) || "—" }) : ""}</span></div>
    </div>
  </div>;
}

function RunDetailPage({ runId, navigate }: { runId: string; navigate: (path: string, replace?: boolean) => void }) {
  const { t } = useI18n();
  const run = usePortalStore((state) => state.runs[runId]);
  const packs = usePortalStore((state) => state.packs);
  const approve = usePortalStore((state) => state.approveWorkflowRun);
  const cancel = usePortalStore((state) => state.cancelWorkflowRun);
  const retry = usePortalStore((state) => state.retryWorkflowRun);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  if (!run) return <div className="center-state"><ErrorBanner message={t("run.notFound")} /><Button variant="outline" onClick={() => backTo("/work", navigate)}>{t("common.backToWork")}</Button></div>;
  const pack = packForRun(packs, run);
  const flow = flowForRun(packs, run);
  const canCancel = ["queued", "running", "waiting"].includes(run.status);
  const canRetry = ["failed", "cancelled"].includes(run.status);
  const timeline = useMemo<Array<{
    id: string;
    timestamp: string;
    sequence: number;
    title: string;
    detail: string;
    tone: "neutral" | "accent" | "warning" | "success";
    call: TimelineCallBlock | null;
    attempts: TimelineAttempt[];
    group: WorkflowStepGroupLog | undefined;
  }>>(() => [
    ...run.events.map((event) => ({
      id: `event-${event.id}`,
      timestamp: event.timestamp,
      sequence: event.sequence,
      title: localizedWorkflowEvent(event, t).title,
      detail: localizedWorkflowEvent(event, t).detail,
      tone: event.tone,
      call: null,
      attempts: [],
      group: undefined,
    })),
    ...run.steps.map((step) => {
      const call = timelineCallBlock({
        runId: run.id,
        call: step.call,
        input: step.input,
        output: step.output,
        outputFields: step.outputFields,
        detail: step.detail,
      });
      // PRD 3.3.5: failed steps keep every attempt receipt expandable.
      const attempts = timelineAttempts(run.receipts, step.stepId);
      return {
        id: `step-${step.id}`,
        timestamp: step.completedAt || step.createdAt,
        sequence: 10_000 + step.sequence,
        title: step.stepLabel,
        detail: step.detail || t("run.stepDefaultDetail", { status: t(`status.${step.status}` as const), count: Object.keys(step.output ?? {}).length }),
        tone: step.status === "failed" ? "warning" as const : "accent" as const,
        call,
        attempts: step.status === "failed" ? attempts : attempts.length > 1 ? attempts : [],
        group: step.group,
      };
    }),
  ].sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.sequence - left.sequence), [run.events, run.id, run.steps, run.receipts, t]);
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
      <a href={portalHref("/work")} className="back-link" onClick={(event) => followPortalLink(event, () => backTo("/work", navigate))}><ArrowLeft className="h-4 w-4" />{t("common.backToWork")}</a>
      <section className="run-detail-heading"><div><div className="run-id-row"><code className="run-id">{run.id}</code><Button variant="ghost" size="icon" className="run-id-copy" aria-label={t("run.copyId")} title={copyStatus === "copied" ? t("run.copied") : t("run.copyId")} onClick={() => void copyRunId()}><Copy className="h-4 w-4" /></Button>{copyStatus !== "idle" && <span className={cn("run-id-copy-status", copyStatus === "error" && "is-error")} role="status">{copyStatus === "copied" ? t("run.copied") : t("run.copyFailed")}</span>}</div><h1>{run.title}</h1><p className="page-subtitle">{pack?.title} · {flow?.title} · {pack?.version}</p></div><div className="run-detail-heading-actions"><WorkflowStatusBadge status={run.status} /></div></section>
      <div className="run-detail-layout">
        <div className="run-detail-main">
          <Card><CardHeader><CardTitle>{t("run.progress")}</CardTitle><CardDescription>{run.summary}</CardDescription></CardHeader><CardContent><div className="run-progress run-progress-large"><span style={{ width: `${run.progress}%` }} /></div><div className="run-progress-meta"><span>{t("run.percentComplete", { percent: run.progress })}</span><span>{workflowExecutionTargetLabel(run, t)}</span></div></CardContent></Card>
          <Card><CardHeader><CardTitle>{t("run.timeline")}</CardTitle><CardDescription>{t("run.timelineDescription")}</CardDescription></CardHeader><CardContent><div className="run-timeline">{timeline.map((item) => <div className="timeline-item" key={item.id}><span className={cn("timeline-dot", `timeline-dot-${item.tone}`)} /><div><div className="timeline-title"><strong>{item.title}</strong>{item.group && <span className="timeline-group">{timelineGroupLabel(item.group, t)}</span>}<time>{item.timestamp.slice(11, 16)}</time></div>{item.call ? <TimelineCallView runId={run.id} block={item.call} fallback={item.detail} navigate={navigate} /> : <p>{item.detail}</p>}{item.attempts.length > 0 && <details className="timeline-attempts"><summary>{t("run.attempts", { count: item.attempts.length })}</summary><ul className="timeline-attempt-list">{item.attempts.map((attempt) => <li className="timeline-attempt" key={attempt.requestId}><span className={cn("timeline-attempt-index", attempt.status !== "completed" && attempt.status !== "succeeded" && "is-failed")}>#{attempt.attempt}/{attempt.attemptCount}</span><code>{attempt.requestId}</code><span className="timeline-attempt-status">{t(attempt.status === "completed" || attempt.status === "succeeded" ? "status.completed" : "status.failed")}</span>{attempt.error && <span className="timeline-attempt-error">{attempt.errorCode ? localizedWorkflowError({ code: attempt.errorCode, message: attempt.error }, t, attempt.values) : attempt.error}</span>}</li>)}</ul></details>}</div></div>)}</div></CardContent></Card>
          {run.error && <Card className="run-error-card"><CardHeader><CardTitle>{t("run.needsAction")}</CardTitle></CardHeader><CardContent><p>{localizedWorkflowError(run.error, t, run.error.values)}</p><code>{run.error.code}</code></CardContent></Card>}
        </div>
        <aside className="run-detail-side"><Card><CardHeader><CardTitle>{t("run.context")}</CardTitle></CardHeader><CardContent><dl className="data-rows compact-data-rows"><div className="data-row"><dt>{t("run.pack")}</dt><dd>{pack?.title || run.packId}</dd></div><div className="data-row"><dt>{t("run.version")}</dt><dd>{pack?.version || "—"}</dd></div><div className="data-row"><dt>{run.driver === "none" ? t("run.executionLocation") : t("run.targetVault")}</dt><dd>{workflowExecutionTargetLabel(run, t)}</dd></div><div className="data-row"><dt>{t("run.strategy")}</dt><dd>{run.approvalRequired ? t("run.needsConfirmation") : t("run.autoComplete")}</dd></div><div className="data-row"><dt>{t("run.created")}</dt><dd>{formatRunDateTime(run.createdAt)}</dd></div></dl></CardContent></Card><Card><CardHeader><CardTitle>{t("run.inputSnapshot")}</CardTitle><CardDescription>{t("run.inputDescription")}</CardDescription></CardHeader><CardContent><dl className="input-snapshot">{Object.entries(run.input).map(([key, value]) => <div key={key}><dt>{key}</dt><dd><code>{formatInputSnapshotValue(value)}</code></dd></div>)}</dl></CardContent></Card>{run.artifacts.length > 0 && <Card><CardHeader><CardTitle>{t("run.artifacts")}</CardTitle><CardDescription>{run.driver === "none" ? t("run.artifactHost") : t("run.artifactVault")}</CardDescription></CardHeader><CardContent><div className="artifact-list">{run.artifacts.map((item) => <a href={portalHref(artifactPreviewPage(run.id, item.id))} className="artifact-row" key={item.id} onClick={(event) => followPortalLink(event, () => navigate(artifactPreviewPage(run.id, item.id)))}><span className="artifact-icon"><FileText className="h-4 w-4" /></span><span><strong>{item.name}</strong><small>{item.summary} · {item.size}</small></span><ExternalLink className="h-4 w-4" /></a>)}</div></CardContent></Card>}</aside>
      </div>
    </div>
  );
}

function RunPreviewPage({
  runId,
  kind,
  target,
  navigate,
}: {
  runId: string;
  kind: "artifact" | "file";
  target: string;
  navigate: (path: string, replace?: boolean) => void;
}) {
  const { t } = useI18n();
  const run = usePortalStore((state) => state.runs[runId]);
  const backHref = `/work/runs/${encodeURIComponent(runId)}`;
  const artifact = kind === "artifact" ? run?.artifacts.find((item) => item.id === target) : undefined;
  const previewKind = artifactPreviewKind(kind === "artifact" ? artifact?.name || target : target);
  const media = ["image", "video", "audio", "pdf"].includes(previewKind);
  const fileUrl = kind === "file" ? workspaceFilePreviewUrl(runId, target) : artifact ? artifactPreviewUrl(runId, artifact.id) : null;
  const initialContent = kind === "artifact" ? artifact?.content ?? "" : "";
  const [text, setText] = useState(initialContent);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (!fileUrl || media || artifact?.redacted) return;
    if (kind === "artifact" && initialContent && !initialContent.startsWith("PDF report:")) {
      setText(initialContent);
      return;
    }
    let cancelled = false;
    void fetch(fileUrl, { credentials: "same-origin" }).then(async (response) => {
      if (!response.ok) throw new Error(t("error.artifactContentUnavailable"));
      const body = await response.text();
      if (!cancelled) {
        setText(body);
        setLoadError(null);
      }
    }).catch((error) => {
      if (!cancelled) setLoadError(error instanceof Error ? error.message : t("error.artifactContentUnavailable"));
    });
    return () => { cancelled = true; };
  }, [artifact?.redacted, fileUrl, initialContent, kind, media, t]);
  if (!run) {
    return <div className="center-state"><ErrorBanner message={t("run.notFound")} /><Button variant="outline" onClick={() => backTo("/work", navigate)}>{t("common.backToWork")}</Button></div>;
  }
  if (kind === "artifact" && !artifact) {
    return <div className="center-state"><ErrorBanner message={t("error.artifactNotFound")} /><Button variant="outline" onClick={() => backTo(backHref, navigate)}>{t("run.backToRun")}</Button></div>;
  }
  const title = kind === "artifact" ? artifact!.name : target.split("/").filter(Boolean).at(-1) || target;
  const summary = kind === "artifact" ? `${artifact!.summary} · ${artifact!.size}` : target;
  const source = kind === "artifact"
    ? artifactPreviewSource(artifact!.content)
    : null;
  return (
    <div className="page-stack preview-page">
      <a href={portalHref(backHref)} className="back-link" onClick={(event) => followPortalLink(event, () => backTo(backHref, navigate))}><ArrowLeft className="h-4 w-4" />{t("run.backToRun")}</a>
      <section className="run-detail-heading">
        <div>
          <p className="eyebrow">{t("artifact.preview")}</p>
          <h1>{title}</h1>
          <p className="page-subtitle">{summary}</p>
        </div>
      </section>
      {loadError && <ErrorBanner message={loadError} />}
      <Card className="preview-card">
        <CardContent className="preview-card-content">
          <ArtifactPreviewContent
            kind={previewKind}
            content={text}
            source={source}
            redacted={kind === "artifact" ? artifact!.redacted : false}
          />
        </CardContent>
      </Card>
    </div>
  );
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
  const { t } = useI18n();
  if (redacted) {
    return <div className="artifact-content artifact-unavailable"><strong>{t("artifact.redacted")}</strong><span>{t("artifact.redactedDescription")}</span><code>{content}</code></div>;
  }
  if (kind === "image" && source) {
    return <div className="artifact-content artifact-media-content"><img src={source} alt={t("artifact.alt")} /></div>;
  }
  if (kind === "video" && source) {
    return <div className="artifact-content artifact-media-content"><video controls preload="metadata" src={source}>{t("artifact.videoUnsupported")}</video></div>;
  }
  if (kind === "audio" && source) {
    return <div className="artifact-content artifact-media-content artifact-audio-content"><audio controls preload="metadata" src={source}>{t("artifact.audioUnsupported")}</audio></div>;
  }
  if (kind === "pdf" && source) {
    return <div className="artifact-content artifact-pdf-content"><iframe src={source} title={t("artifact.pdfTitle")} /></div>;
  }
  if (kind === "image" || kind === "video" || kind === "audio" || kind === "pdf" || kind === "binary") {
    return <div className="artifact-content artifact-unavailable"><strong>{t("artifact.unavailable")}</strong><span>{t("artifact.unavailableDescription")}</span><code>{content}</code></div>;
  }
  const displayContent = kind === "json" ? formatJsonArtifact(content) : content;
  return <pre className={cn("artifact-content", `artifact-content-${kind}`)}><code>{displayContent}</code></pre>;
}

function LoadingView({ label }: { label: string }) { return <div className="center-state"><Loader2 className="h-6 w-6 animate-spin text-primary" /><span>{label}</span></div>; }
function ErrorView({ message, onDismiss, onRetry }: { message: string; onDismiss?: () => void; onRetry?: () => void }) { const { t } = useI18n(); return <div className="center-state"><ErrorBanner message={message} />{onRetry && <Button variant="outline" onClick={onRetry}>{t("common.retry")}</Button>}{onDismiss && <Button variant="ghost" onClick={onDismiss}>{t("common.close")}</Button>}</div>; }
function ErrorBanner({ message }: { message: string }) { return <div className="error-banner"><X className="h-4 w-4" /><span>{message}</span></div>; }
