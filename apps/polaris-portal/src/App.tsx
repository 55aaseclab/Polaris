import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
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
  Languages,
  Loader2,
  LogOut,
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
  UserRound,
  Wifi,
  Wrench,
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
  type WorkflowGraphProjection,
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
  portalTools,
  workflowGraph,
  type AuthingConfig,
  type PortalToolStatusReport,
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
  workspaceFilePreviewUrl,
  type ArtifactPreviewKind,
} from "./artifact-preview.js";
import { formatRunDateTime } from "./formatters.js";
import {
  artifactPreviewPage,
  pathLabelParts,
  timelineCallBlock,
  workspaceFilePage,
  type TimelineCallBlock,
  type TimelineField,
  type TimelineValue,
} from "./timeline-call.js";
import { layoutWorkflowGraph } from "./workflow-graph-layout.js";
import { useI18n } from "./i18n/index.js";
import { localizedPackWarning, localizedWorkflowError, localizedWorkflowEvent, LocalizedError } from "./i18n/messages.js";
import { backTo } from "./portal-navigation.js";
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
    const state = { from: `${window.location.pathname}${window.location.search}` };
    if (replace) window.history.replaceState(state, "", nextPath);
    else window.history.pushState(state, "", nextPath);
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
  const { t } = useI18n();
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
  if (!bootstrapped || loading) return <LoadingView label={t("common.loadingPortal")} />;
  if (!session?.authenticated) {
    queueMicrotask(() => navigate("/welcome", true));
    return <LoadingView label={t("common.redirectingLogin")} />;
  }
  if (!session.polarisUserId) return <ErrorView message={t("auth.noAccess")} />;
  if (path === "/") {
    queueMicrotask(() => navigate("/work", true));
    return <LoadingView label={t("common.openingWorkspace")} />;
  }
  if (path === "/setup" || path === "/setup/") {
    return <PortalLayout active="workflows" session={session} navigate={navigate}><ProvisioningPage navigate={navigate} returnPath={setupReturnPath()} /></PortalLayout>;
  }
  if (path === "/work" || path === "/work/") {
    return <PortalLayout active="work" session={session} navigate={navigate}><WorkPage navigate={navigate} /></PortalLayout>;
  }
  if (path === "/debug" || path === "/debug/") {
    queueMicrotask(() => navigate("/work", true));
    return <LoadingView label={t("common.openingWorkspace")} />;
  }
  const artifactMatch = path.match(/^\/work\/runs\/([^/]+)\/artifacts\/([^/]+)$/u);
  if (artifactMatch) {
    return <PortalLayout active="work" session={session} navigate={navigate}><RunPreviewPage runId={decodeURIComponent(artifactMatch[1])} kind="artifact" target={decodeURIComponent(artifactMatch[2])} navigate={navigate} /></PortalLayout>;
  }
  const fileMatch = path.match(/^\/work\/runs\/([^/]+)\/files\/(.+)$/u);
  if (fileMatch) {
    return <PortalLayout active="work" session={session} navigate={navigate}><RunPreviewPage runId={decodeURIComponent(fileMatch[1])} kind="file" target={decodeURIComponent(fileMatch[2])} navigate={navigate} /></PortalLayout>;
  }
  const runMatch = path.match(/^\/work\/runs\/([^/]+)$/u);
  if (runMatch) {
    return <PortalLayout active="work" session={session} navigate={navigate}><RunDetailPage runId={decodeURIComponent(runMatch[1])} navigate={navigate} /></PortalLayout>;
  }
  if (path === "/hosts" || path === "/hosts/") {
    if (session.vaultMode === "host") {
      queueMicrotask(() => navigate("/work", true));
      return <LoadingView label={t("common.openingWorkspace")} />;
    }
    return <PortalLayout active="hosts" session={session} navigate={navigate}><HostsPage session={session} navigate={navigate} /></PortalLayout>;
  }
  if (path === "/settings" || path === "/settings/workflows" || path === "/settings/workflows/") {
    return <PortalLayout active="workflows" session={session} navigate={navigate}><WorkflowSettingsPage navigate={navigate} /></PortalLayout>;
  }
  if (path === "/settings/tools" || path === "/settings/tools/") {
    return <PortalLayout active="tools" session={session} navigate={navigate}><ToolsPage /></PortalLayout>;
  }
  const graphMatch = path.match(/^\/settings\/workflows\/([^/]+)\/([^/]+)\/graph$/u);
  if (graphMatch) {
    return <PortalLayout active="workflows" session={session} navigate={navigate}>
      <WorkflowGraphPage
        packId={decodeURIComponent(graphMatch[1])}
        flowId={decodeURIComponent(graphMatch[2])}
        navigate={navigate}
      />
    </PortalLayout>;
  }
  if (path === "/settings/user") {
    return <PortalLayout active="user" session={session} navigate={navigate}><UserPage session={session} /></PortalLayout>;
  }
  const codingMatch = path.match(/^\/v\/([^/]+)\/coding$/u);
  if (codingMatch) return <SurfacePage kind="coding" id={decodeURIComponent(codingMatch[1])} navigate={navigate} />;
  const wanghaiMatch = path.match(/^\/v\/([^/]+)\/wanghai$/u);
  if (wanghaiMatch) return <SurfacePage kind="wanghai" id={decodeURIComponent(wanghaiMatch[1])} navigate={navigate} />;
  if (error) return <ErrorView message={errorMessage(error, t)} onDismiss={clearError} />;
  return <ErrorView message={t("common.notFound")} />;
}

function PortalLayout({
  active,
  session,
  navigate,
  children,
}: {
  active: "work" | "hosts" | "workflows" | "tools" | "user";
  session: ShellSession;
  navigate: (path: string, replace?: boolean) => void;
  children: React.ReactNode;
}) {
  const { t, toggleLanguage } = useI18n();
  const signOut = usePortalStore((state) => state.signOut);
  const link = (path: string, label: string, Icon: typeof Server, key: "work" | "hosts" | "workflows" | "tools" | "user") => (
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
          <nav className="portal-nav" aria-label={t("nav.workflows")}>
            {link("/work", t("nav.work"), LayoutDashboard, "work")}
            {session.vaultMode !== "host" && link("/hosts", t("nav.hosts"), Server, "hosts")}
            {link("/settings/workflows", t("nav.workflows"), Workflow, "workflows")}
            {link("/settings/tools", t("nav.tools"), Wrench, "tools")}
            {link("/settings/user", t("nav.account"), CircleUserRound, "user")}
          </nav>
          <div className="portal-topbar-actions">
            <Button variant="ghost" size="icon" aria-label={t("nav.language")} title={t("nav.language")} onClick={toggleLanguage}>
              <Languages className="h-4 w-4" />
            </Button>
            <span className="user-chip" title={session.authingUsername || session.authingUserId}>
              <UserRound className="h-4 w-4" />
              {session.authingUsername || session.authingUserId}
            </span>
            <Button variant="ghost" size="icon" aria-label={t("nav.signOut")} title={t("nav.signOut")} onClick={() => void signOut()}>
              <LogOut className="h-4 w-4" />
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
        href={href}
        className="timeline-file-open"
        aria-label={t("run.openFile", { name: value.label })}
        title={t("run.openFile", { name: value.label })}
        onClick={(event) => { event.preventDefault(); navigate(href); }}
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
      {block.call && <span className="timeline-call-lead"><span className="timeline-call-label">call</span> <code className="timeline-call-name">{block.call}</code></span>}
      {block.uses.length > 0 && <> <span className="timeline-call-section"><span className="timeline-call-label">{t("run.callUses")}</span> <span className="timeline-brace">{"{"}</span><TimelineFieldList runId={runId} fields={block.uses} navigate={navigate} /><span className="timeline-brace">{"}"}</span></span></>}
      {block.outputs.length > 0 && <> <span className="timeline-call-section"><span className="timeline-arrow">→</span> <span className="timeline-call-label">{t("run.callOut")}</span> <span className="timeline-brace">{"{"}</span><TimelineFieldList runId={runId} fields={block.outputs} navigate={navigate} /><span className="timeline-brace">{"}"}</span></span></>}
      {block.note && <span className="timeline-note"> · {block.note}</span>}
    </p>
  );
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
        <Button
          type="button"
          className="work-new-button"
          size="icon"
          aria-label={t("work.new")}
          title={t("work.new")}
          onClick={() => setComposerOpen(true)}
        >
          <Plus className="h-4 w-4" />
        </Button>
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
      {composerOpen && <WorkflowComposer initialPackId={initialWorkflow.packId} initialFlowId={initialWorkflow.flowId} navigate={navigate} onClose={() => setComposerOpen(false)} />}
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
        {card.status === "waiting" && <Button size="sm" onClick={() => void runAction(() => approve(run.id))} disabled={busy}><CheckCircle2 className="h-4 w-4" />{t("work.approve")}</Button>}
        {["queued", "running"].includes(card.status) && <Button size="sm" variant="outline" onClick={() => void runAction(() => cancel(run.id))} disabled={busy}><Square className="h-4 w-4" />{t("work.cancel")}</Button>}
        {["failed", "cancelled"].includes(card.status) && <Button size="sm" onClick={() => void runAction(() => retry(run.id))} disabled={busy}><RotateCcw className="h-4 w-4" />{t("common.retry")}</Button>}
        {["succeeded", "failed", "cancelled"].includes(card.status) && <Button size="sm" variant="ghost" aria-label={t("work.deleteLabel", { title: card.title })} title={t("work.delete")} onClick={() => { if (window.confirm(t("work.deleteConfirm", { title: card.title }))) void runAction(() => deleteRun(run.id)); }} disabled={busy}><Trash2 className="h-4 w-4" /></Button>}
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
          {card.status === "waiting" && <Button onClick={() => void runAction(() => approve(run.id))} disabled={busy}><CheckCircle2 className="h-4 w-4" />{t("work.approve")}</Button>}
          {["queued", "running"].includes(card.status) && <Button variant="outline" onClick={() => void runAction(() => cancel(run.id))} disabled={busy}><Square className="h-4 w-4" />{t("work.cancel")}</Button>}
          {["failed", "cancelled"].includes(card.status) && <Button onClick={() => void runAction(() => retry(run.id))} disabled={busy}><RotateCcw className="h-4 w-4" />{t("common.retry")}</Button>}
          <Button variant={card.status === "waiting" ? "ghost" : "outline"} onClick={() => navigate(`/work/runs/${encodeURIComponent(run.id)}`)}>
            <>{t("work.viewDetails")}<ChevronRight className="h-4 w-4" /></>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function WorkflowComposer({
  initialPackId,
  initialFlowId,
  navigate,
  onClose,
}: {
  initialPackId?: string;
  initialFlowId?: string;
  navigate: (path: string, replace?: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
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
  const [flowId, setFlowId] = useState(
    enabledFlows.find((flow) => flow.id === initialFlowId)?.id || enabledFlows[0]?.id || "",
  );
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
      setError(errorMessage(reason, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal workflow-composer" role="dialog" aria-modal="true" aria-labelledby="workflow-composer-title" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div><p className="eyebrow">{t("work.startTitle")}</p><h2 id="workflow-composer-title">{t("work.startTitle")}</h2><p>{t("work.startDescription")}</p></div>
          <Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")} onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
        <form className="form-stack" onSubmit={submit}>
          <div className="composer-grid">
            <div>
              <label className="field-label" htmlFor="workflow-pack">{t("work.stepPack")}</label>
              <select id="workflow-pack" className="select" value={selectedPack?.id || packId} onChange={(event) => handlePackChange(event.target.value)}>
                {enabledPacks.map((pack) => <option key={pack.id} value={pack.id}>{pack.title} · {pack.category}</option>)}
              </select>
              {selectedPack && <div className="composer-context"><span className={cn("pack-dot", `pack-dot-${selectedPack.accent}`)} /><span><strong>{selectedPack.title}</strong><small>{selectedPack.description}</small></span></div>}
              {enabledPacks.length === 0 && <p className="form-error">{t("work.noWorkflows")}</p>}
            </div>
            <div>
              <label className="field-label" htmlFor="workflow-flow">{t("work.stepFlow")}</label>
              <select id="workflow-flow" className="select" value={selectedFlow?.id || ""} onChange={(event) => { setFlowId(event.target.value); setValues({}); }} disabled={!selectedPack}>
                {groupWorkflowFlows(enabledFlows).map((group) => (
                  <optgroup key={group.id} label={group.title}>
                    {group.flows.map((flow) => <option key={flow.id} value={flow.id}>{flow.title}</option>)}
                  </optgroup>
                ))}
              </select>
              {selectedFlow && <div className="composer-flow-meta"><span>{selectedFlow.estimate}</span>{selectedFlow.approvalRequired && <Badge variant="warning">{t("work.approvalRequired")}</Badge>}</div>}
            </div>
          </div>
          {selectedFlow?.fields.map((field) => (
            <div className="composer-field" key={field.id}>
              <label className="field-label" htmlFor={`workflow-field-${field.id}`}>{field.label}</label>
              {field.type === "textarea" ? <textarea id={`workflow-field-${field.id}`} className="textarea" placeholder={field.placeholder} required={field.required} value={values[field.id] || ""} onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))} /> : <Input id={`workflow-field-${field.id}`} placeholder={field.placeholder} required={field.required} value={values[field.id] || ""} onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))} />}
            </div>
          ))}
          <div>
            <label className="field-label" htmlFor="workflow-driver">{t("work.stepExecution")}</label>
            <select id="workflow-driver" className="select" value={driver} onChange={(event) => setDriver(event.target.value as "none" | "vault")}>
              <option value="none">{t("work.hostOption")}</option>
              <option value="vault">{t("work.vaultOption")}</option>
            </select>
            {driver === "vault" ? <>
              <label className="field-label" htmlFor="workflow-vault">{t("work.selectVault")}</label>
              <select id="workflow-vault" className="select" value={vaultId} onChange={(event) => setVaultId(event.target.value)}>
                {vaults.map((vault) => <option key={vault.id} value={vault.id} disabled={!vault.canRun}>{vault.name} · {vault.profile} · {workflowVaultStatusLabel(vault, t)}{vault.kind === "disposable" ? ` · ${t("work.disposable")}` : ""}</option>)}
              </select>
              <p className="field-hint"><ShieldCheck className="h-3.5 w-3.5" />{t("work.vaultDescription")}</p>
            </> : <p className="field-hint"><ShieldCheck className="h-3.5 w-3.5" />{t("work.hostDescription")}</p>}
          </div>
          {error && <p className="form-error">{errorMessage(error, t)}</p>}
          <div className="composer-footer"><span className="mock-note"><Sparkles className="h-3.5 w-3.5" />{driver === "none" ? t("work.executorHost") : t("work.executorVault")}</span><div className="card-actions"><Button type="button" variant="ghost" onClick={onClose}>{t("common.cancel")}</Button><Button type="submit" disabled={busy || !selectedFlow || (driver === "vault" && !vaultId)}>{busy ? <><Loader2 className="h-4 w-4 animate-spin" />{t("common.submitting")}</> : <><Play className="h-4 w-4" />{t("work.submit")}</>}</Button></div></div>
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
  const { t } = useI18n();
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
      setError(t("settings.selectPack"));
      return;
    }
    if (step === 1 && selectedVault && !selectedVault.canRun) {
      setError(t("settings.selectVault"));
      return;
    }
    setError(null);
    setStep((current) => Math.min(2, current + 1));
  };
  const previous = () => setStep((current) => Math.max(0, current - 1));
  const finish = async () => {
    const selectedVault = vaults.find((vault) => vault.id === vaultId);
    if (!selectedPack || selectedPackEnabledFlowKeys.length === 0) {
      setError(t("settings.selectFlow"));
      return;
    }
    if (selectedVault && !selectedVault.canRun) {
      setError(t("settings.selectVault"));
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
      setError(errorMessage(reason, t));
    }
  };
  return (
    <div className="page-stack setup-page">
      <div className="setup-progress" aria-label={t("work.setupProgress")}>{[t("settings.stepScene"), t("settings.stepLocation"), t("settings.stepFlows")].map((label, index) => <div key={label} className={cn("setup-progress-step", index <= step && "is-active", index < step && "is-complete")}><span>{index < step ? <Check className="h-3.5 w-3.5" /> : index + 1}</span><small>{label}</small></div>)}</div>
      <Card className="setup-card">
        <CardHeader><CardTitle>{step === 0 ? t("settings.choosePackTitle") : step === 1 ? t("settings.locationTitle") : t("settings.enableFlowsTitle", { title: selectedPack?.title || t("common.domainPack") })}</CardTitle></CardHeader>
        <CardContent>
          {step === 0 && <div className="setup-pack-list">{packs.map((pack) => <button type="button" key={pack.id} className={cn("setup-pack-option", domainPackId === pack.id && "is-selected")} onClick={() => chooseDomainPack(pack.id)}><span><strong>{pack.title}</strong><small>{pack.category} · v{pack.version}</small><em>{t("work.flowCount", { count: pack.flows.length })} · {pack.description}</em></span>{domainPackId === pack.id && <CheckCircle2 className="setup-choice-check h-5 w-5" />}</button>)}</div>}
          {step === 1 && <div className="setup-vault-list">
            <button type="button" className={cn("setup-vault-option", !vaultId && "is-selected")} onClick={() => setVaultId("")}>
              <span className="vault-option-icon"><MonitorPlay className="h-4 w-4" /></span>
              <span><strong>{t("settings.hostName")}</strong><small>{t("settings.hostDescription")}</small><em>{t("common.driverNone")} · {t("settings.hostHint")}</em></span>
              <span className="vault-option-status">{t("settings.availableLabel")}</span>
              {!vaultId && <CheckCircle2 className="setup-choice-check h-5 w-5" />}
            </button>
            {vaults.map((vault) => { const selectable = vault.canRun; return <button type="button" key={vault.id} disabled={!selectable} className={cn("setup-vault-option", vaultId === vault.id && "is-selected")} onClick={() => setVaultId(vault.id)}><span className="vault-option-icon"><Server className="h-4 w-4" /></span><span><strong>{vault.name}</strong><small>{vault.description}</small><em>{vault.profile} · {vault.capacity}</em></span><span className="vault-option-status">{vault.kind === "disposable" ? t("settings.disposable") : workflowVaultStatusLabel(vault, t)}</span>{vaultId === vault.id && <CheckCircle2 className="setup-choice-check h-5 w-5" />}</button>; })}
          </div>}
          {step === 2 && selectedPack && <div className="setup-flow-list">{groupWorkflowFlows(selectedPack.flows).map((group) => <section className="workflow-group" key={group.id}>{group.id !== "other" && <WorkflowGroupHeading group={group} />}{group.flows.map((flow) => { const enabled = enabledWorkflowKeys.includes(workflowKey(selectedPack.id, flow.id)); return <button type="button" key={flow.id} className={cn("setup-pack-option", enabled && "is-selected")} aria-pressed={enabled} onClick={() => toggleFlow(flow.id)}><span><strong>{flow.title}</strong><small>{flow.summary}</small><em>{flow.estimate}{flow.approvalRequired ? ` · ${t("settings.flowApproval")}` : ""}</em></span><span className={cn("toggle-pill", enabled && "is-on")}>{enabled ? t("settings.enabledLabel") : t("settings.enableLabel")}</span></button>; })}</section>)}</div>}
          {step === 0 && packs.length === 0 && <div className="empty-state">{t("settings.emptyPacks")}</div>}
          {step === 2 && !selectedPack && <div className="empty-state">{t("settings.choosePackFirst")}</div>}
          {error && <p className="form-error setup-error">{errorMessage(error, t)}</p>}
          <div className="setup-summary"><span><strong>{selectedPack?.title || t("settings.summaryUnselected")}</strong><small>{vaultId ? vaults.find((vault) => vault.id === vaultId)?.name : t("settings.hostName")} · {t("settings.summaryFlows", { selected: selectedPackEnabledFlowKeys.length, total: selectedPack?.flows.length || 0 })}</small></span><span className="mock-note"><Sparkles className="h-3.5 w-3.5" />{t("settings.changeAnytime")}</span></div>
          <div className="setup-footer"><Button variant="ghost" onClick={() => navigate(returnPath)}>{t("settings.setupLater")}</Button><div className="card-actions">{step > 0 && <Button variant="outline" onClick={previous}><ArrowLeft className="h-4 w-4" />{t("settings.previous")}</Button>}{step < 2 ? <Button onClick={next}>{t("settings.next")}<ArrowRight className="h-4 w-4" /></Button> : <Button onClick={() => void finish()}><Check className="h-4 w-4" />{t("settings.finish")}</Button>}</div></div>
        </CardContent>
      </Card>
    </div>
  );
}

function ToolsPage() {
  const { t } = useI18n();
  const [report, setReport] = useState<PortalToolStatusReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [filter, setFilter] = useState<"all" | "ready" | "warning" | "blocked">("all");

  const loadTools = useCallback((cancelled?: { current: boolean }) => {
    setRechecking(true);
    return portalTools()
      .then((next) => {
        if (cancelled?.current) return;
        setReport(next);
        setError(null);
      })
      .catch((reason) => {
        if (!cancelled?.current) setError(errorMessage(reason, t));
      })
      .finally(() => {
        if (!cancelled?.current) setRechecking(false);
      });
  }, [t]);

  useEffect(() => {
    const cancelled = { current: false };
    void loadTools(cancelled);
    return () => {
      cancelled.current = true;
    };
  }, [loadTools]);

  if (error && !report) return <ErrorView message={error} />;
  if (!report) return <LoadingView label={t("tools.loading")} />;
  const visible = report.tools.filter((tool) => filter === "all" || tool.readiness === filter);
  return (
    <div className="page-stack settings-page tools-page">
      <div className="settings-toolbar">
        <div className="filter-tabs settings-tabs" role="tablist" aria-label={t("tools.filter")}>
          <button type="button" role="tab" aria-selected={filter === "all"} className={cn("filter-tab", filter === "all" && "is-active")} onClick={() => setFilter("all")}>{t("tools.all")}<span className="filter-tab-count">{report.tools.length}</span></button>
          <button type="button" role="tab" aria-selected={filter === "ready"} className={cn("filter-tab", filter === "ready" && "is-active")} onClick={() => setFilter("ready")}>{t("tools.ready")}<span className="filter-tab-count">{report.ready}</span></button>
          <button type="button" role="tab" aria-selected={filter === "warning"} className={cn("filter-tab", filter === "warning" && "is-active")} onClick={() => setFilter("warning")}>{t("tools.warning")}<span className="filter-tab-count">{report.warning}</span></button>
          <button type="button" role="tab" aria-selected={filter === "blocked"} className={cn("filter-tab", filter === "blocked" && "is-active")} onClick={() => setFilter("blocked")}>{t("tools.blocked")}<span className="filter-tab-count">{report.blocked}</span></button>
        </div>
        <Button className="settings-provision-button" variant="outline" size="icon" aria-label={t("tools.recheck")} title={t("tools.recheck")} disabled={rechecking} aria-busy={rechecking} onClick={() => void loadTools()}>
          {rechecking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
        </Button>
      </div>
      {error && <p className="form-error setup-error" role="alert">{error}</p>}
      <div className="tools-list" aria-busy={rechecking}>
        {visible.map((tool) => (
          <Card className={cn("tool-card", `is-${tool.readiness}`)} key={tool.id}>
            <CardHeader>
              <div className="tool-card-heading">
                <div>
                  <CardTitle>{tool.id}</CardTitle>
                  <CardDescription>{t("tools.entrypoint")} · {tool.entrypoint}</CardDescription>
                </div>
                <Badge variant={tool.readiness === "ready" ? "success" : tool.readiness === "warning" ? "warning" : "danger"}>
                  {tool.readiness === "ready" ? t("tools.ready") : tool.readiness === "warning" ? t("tools.warning") : t("tools.blocked")}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <p className="tool-lock">{t("tools.lock")} · {tool.lockPath}</p>
              <p className="tool-commands">{t("tools.commands")} · {tool.commands.join(t("common.listSeparator"))}</p>
              {tool.prerequisites.python && (
                <p className="tool-python">
                  {t("tools.python", { version: tool.prerequisites.python.minimum_version })}
                  {" · "}
                  {tool.prerequisites.python.requirements.length > 0
                    ? t("tools.packages", { packages: tool.prerequisites.python.requirements.join(t("common.listSeparator")) })
                    : t("tools.noPythonPackages")}
                </p>
              )}
              {tool.capabilities.length > 0 && (
                <div className="capability-list">{tool.capabilities.map((capability) => <Badge key={capability} variant="outline">{capability}</Badge>)}</div>
              )}
              <div className={cn("tool-check-setup", `is-${tool.readiness}`)} role="status">
                <strong>{t("tools.checkSetup")} · {tool.checkSetupPath}</strong>
                <ul className="tool-check-setup-list">
                  {((tool.checkSetup.checked ?? []).length > 0
                    ? tool.checkSetup.checked
                    : [...tool.missingRequired, ...tool.missingRecommended]
                  ).map((item) => {
                    const ok = item.status === "ok";
                    return (
                      <li className={cn("tool-check-setup-item", ok ? "is-ok" : "is-missing")} key={`${item.type}:${item.key}`}>
                        <code>{item.key}</code>
                        <span>{ok ? t("tools.checkSetupOk") : item.reason}</span>
                        {!ok && item.next && item.next !== item.reason && <span>{item.next}</span>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {visible.length === 0 && <div className="empty-state">{t("tools.empty")}</div>}
    </div>
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
      {!setup.completed && <Card className="inline-notice settings-task-card"><CardContent><Sparkles className="h-5 w-5" /><span><strong>{t("settings.complete")}</strong></span><Button variant="outline" size="icon" aria-label={t("settings.complete")} title={t("settings.complete")} onClick={() => navigate("/setup?returnTo=/settings/workflows")}><ArrowRight className="h-4 w-4" /></Button></CardContent></Card>}
      <div className="settings-toolbar">
        <div className="filter-tabs settings-tabs" role="tablist" aria-label={t("settings.settingsTab")}>
          <button type="button" role="tab" aria-selected={activeTab === "all"} className={cn("filter-tab", activeTab === "all" && "is-active")} onClick={() => setActiveTab("all")}>{t("settings.all")}<span className="filter-tab-count">{allWorkflowCount}</span></button>
          <button type="button" role="tab" aria-selected={activeTab === "enabled"} className={cn("filter-tab", activeTab === "enabled" && "is-active")} onClick={() => setActiveTab("enabled")}>{t("settings.enabled")}<span className="filter-tab-count">{enabledWorkflowCount}</span></button>
          <button type="button" role="tab" aria-selected={activeTab === "available"} className={cn("filter-tab", activeTab === "available" && "is-active")} onClick={() => setActiveTab("available")}>{t("settings.available")}<span className="filter-tab-count">{availableWorkflowCount}</span></button>
        </div>
        <Button className="settings-provision-button" variant="outline" size="icon" aria-label={setup.completed ? t("settings.adjust") : t("settings.complete")} title={setup.completed ? t("settings.adjust") : t("settings.complete")} onClick={() => navigate("/setup?returnTo=/settings/workflows")}><Settings2 className="h-4 w-4" /></Button>
      </div>
      <div className="filter-tabs settings-pack-tabs" role="tablist" aria-label={t("settings.packTab")}>
        {visiblePacks.map((pack) => {
          const count = pack.flows.filter((flow) => enabledWorkflowKeys.has(workflowKey(pack.id, flow.id))).length;
          return <button type="button" role="tab" aria-selected={activePack?.id === pack.id} key={pack.id} className={cn("filter-tab settings-pack-tab", activePack?.id === pack.id && "is-active")} onClick={() => setActivePackId(pack.id)}>{pack.title}<span className="filter-tab-count">{count}/{pack.flows.length}</span></button>;
        })}
      </div>
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
            return <div className="settings-flow-row" key={flow.id}><span><strong>{flow.title}</strong><small>{flow.summary}</small></span><span className="settings-flow-actions"><span>{flow.estimate}{flow.approvalRequired ? ` · ${t("settings.flowApproval")}` : ""}</span><Button variant="ghost" size="icon" aria-label={t("settings.viewFlowDsl", { title: flow.title })} title={t("settings.viewDsl")} onClick={() => navigate(`/settings/workflows/${encodeURIComponent(activePack.id)}/${encodeURIComponent(flow.id)}/graph?${returnQuery}`)}><Eye className="h-4 w-4" /></Button><button type="button" className={cn("pack-toggle", enabled && "is-enabled")} aria-pressed={enabled} aria-label={enabled ? t("settings.disable", { title: flow.title }) : t("settings.enable", { title: flow.title })} onClick={() => toggleWorkflow(activePack.id, flow.id, !enabled)}>{enabled ? <><Check className="h-3.5 w-3.5" />{t("settings.enabledLabel")}</> : <><Plus className="h-3.5 w-3.5" />{t("settings.enableLabel")}</>}</button></span></div>;
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
      <a href={backPath} className="back-link" onClick={(event) => { event.preventDefault(); backTo(backPath, navigate); }}><ArrowLeft className="h-4 w-4" />{t("settings.back")}</a>
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
      <svg className="workflow-graph-svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={t("settings.graphAria", { title: graph.flowTitle })}>
        <defs><marker id="workflow-graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor" /></marker></defs>
        {layout.edges.map(({ edge, d }, edgeIndex) => <path key={`${edge.from}-${edge.to}-${edge.field ?? edgeIndex}`} d={d} markerEnd="url(#workflow-graph-arrow)" />)}
        {nodes.map((node) => {
          const position = layout.positions.get(node.id);
          if (!position) return null;
          return <g key={node.id} className={cn("workflow-graph-node", node.kind === "input" && "workflow-graph-node-input", node.kind === "output" && "workflow-graph-node-output", selectedNodeId === node.id && "is-selected")} transform={`translate(${position.x} ${position.y})`} onClick={() => setSelectedNodeId(node.id)} tabIndex={0} role="button" aria-label={node.label}>
            <rect width={layout.nodeWidth} height={layout.nodeHeight} rx="6" />
            <text x="14" y="24" className="workflow-graph-node-label">{node.label}</text>
            <text x="14" y="48" className="workflow-graph-node-meta">{t("run.graphInputs")} {node.uses.length} · {t("run.graphOutputs")} {node.outputs.length}</text>
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
  }>>(() => [
    ...run.events.map((event) => ({
      id: `event-${event.id}`,
      timestamp: event.timestamp,
      sequence: event.sequence,
      title: localizedWorkflowEvent(event, t).title,
      detail: localizedWorkflowEvent(event, t).detail,
      tone: event.tone,
      call: null,
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
      return {
        id: `step-${step.id}`,
        timestamp: step.completedAt || step.createdAt,
        sequence: 10_000 + step.sequence,
        title: step.stepLabel,
        detail: step.detail || t("run.stepDefaultDetail", { status: t(`status.${step.status}` as const), count: Object.keys(step.output ?? {}).length }),
        tone: step.status === "failed" ? "warning" as const : "accent" as const,
        call,
      };
    }),
  ].sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.sequence - left.sequence), [run.events, run.id, run.steps, t]);
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
      <a href="/work" className="back-link" onClick={(event) => { event.preventDefault(); backTo("/work", navigate); }}><ArrowLeft className="h-4 w-4" />{t("common.backToWork")}</a>
      <section className="run-detail-heading"><div><div className="run-id-row"><code className="run-id">{run.id}</code><Button variant="ghost" size="icon" className="run-id-copy" aria-label={t("run.copyId")} title={copyStatus === "copied" ? t("run.copied") : t("run.copyId")} onClick={() => void copyRunId()}><Copy className="h-4 w-4" /></Button>{copyStatus !== "idle" && <span className={cn("run-id-copy-status", copyStatus === "error" && "is-error")} role="status">{copyStatus === "copied" ? t("run.copied") : t("run.copyFailed")}</span>}</div><h1>{run.title}</h1><p className="page-subtitle">{pack?.title} · {flow?.title} · {pack?.version}</p></div><div className="run-detail-heading-actions"><WorkflowStatusBadge status={run.status} /></div></section>
      {(canCancel || canRetry) && <div className="run-detail-actions"><div className="card-actions">{run.status === "waiting" && <Button onClick={() => void approve(run.id)}><CheckCircle2 className="h-4 w-4" />{t("work.approve")}</Button>}{canCancel && <Button variant="outline" onClick={() => void cancel(run.id)}><Square className="h-4 w-4" />{t("work.cancel")}</Button>}{canRetry && <Button onClick={() => void retryAndOpen()}><RotateCcw className="h-4 w-4" />{t("common.retry")}</Button>}</div></div>}
      <div className="run-detail-layout">
        <div className="run-detail-main">
          <Card><CardHeader><CardTitle>{t("run.progress")}</CardTitle><CardDescription>{run.summary}</CardDescription></CardHeader><CardContent><div className="run-progress run-progress-large"><span style={{ width: `${run.progress}%` }} /></div><div className="run-progress-meta"><span>{t("run.percentComplete", { percent: run.progress })}</span><span>{workflowExecutionTargetLabel(run, t)}</span></div></CardContent></Card>
          <Card><CardHeader><CardTitle>{t("run.timeline")}</CardTitle><CardDescription>{t("run.timelineDescription")}</CardDescription></CardHeader><CardContent><div className="run-timeline">{timeline.map((item) => <div className="timeline-item" key={item.id}><span className={cn("timeline-dot", `timeline-dot-${item.tone}`)} /><div><div className="timeline-title"><strong>{item.title}</strong><time>{item.timestamp.slice(11, 16)}</time></div>{item.call ? <TimelineCallView runId={run.id} block={item.call} fallback={item.detail} navigate={navigate} /> : <p>{item.detail}</p>}</div></div>)}</div></CardContent></Card>
          {run.error && <Card className="run-error-card"><CardHeader><CardTitle>{t("run.needsAction")}</CardTitle></CardHeader><CardContent><p>{localizedWorkflowError(run.error, t)}</p><code>{run.error.code}</code></CardContent></Card>}
        </div>
        <aside className="run-detail-side"><Card><CardHeader><CardTitle>{t("run.context")}</CardTitle></CardHeader><CardContent><dl className="data-rows compact-data-rows"><div className="data-row"><dt>{t("run.pack")}</dt><dd>{pack?.title || run.packId}</dd></div><div className="data-row"><dt>{t("run.version")}</dt><dd>{pack?.version || "—"}</dd></div><div className="data-row"><dt>{run.driver === "none" ? t("run.executionLocation") : t("run.targetVault")}</dt><dd>{workflowExecutionTargetLabel(run, t)}</dd></div><div className="data-row"><dt>{t("run.strategy")}</dt><dd>{run.approvalRequired ? t("run.needsConfirmation") : t("run.autoComplete")}</dd></div><div className="data-row"><dt>{t("run.created")}</dt><dd>{formatRunDateTime(run.createdAt)}</dd></div></dl></CardContent></Card><Card><CardHeader><CardTitle>{t("run.inputSnapshot")}</CardTitle><CardDescription>{t("run.inputDescription")}</CardDescription></CardHeader><CardContent><dl className="input-snapshot">{Object.entries(run.input).map(([key, value]) => <div key={key}><dt>{key}</dt><dd><code>{formatInputSnapshotValue(value)}</code></dd></div>)}</dl></CardContent></Card>{run.artifacts.length > 0 && <Card><CardHeader><CardTitle>{t("run.artifacts")}</CardTitle><CardDescription>{run.driver === "none" ? t("run.artifactHost") : t("run.artifactVault")}</CardDescription></CardHeader><CardContent><div className="artifact-list">{run.artifacts.map((item) => <a href={artifactPreviewPage(run.id, item.id)} className="artifact-row" key={item.id} onClick={(event) => { event.preventDefault(); navigate(artifactPreviewPage(run.id, item.id)); }}><span className="artifact-icon"><FileText className="h-4 w-4" /></span><span><strong>{item.name}</strong><small>{item.summary} · {item.size}</small></span><ExternalLink className="h-4 w-4" /></a>)}</div></CardContent></Card>}</aside>
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
    ? artifactPreviewSource(artifact!.content) ?? (media && !artifact!.redacted ? fileUrl : null)
    : (media ? fileUrl : null);
  return (
    <div className="page-stack preview-page">
      <a href={backHref} className="back-link" onClick={(event) => { event.preventDefault(); backTo(backHref, navigate); }}><ArrowLeft className="h-4 w-4" />{t("run.backToRun")}</a>
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

function HostsPage({ session, navigate }: { session: ShellSession; navigate: (path: string, replace?: boolean) => void }) {
  const { t } = useI18n();
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
    ["all", t("hosts.all"), hosts.length],
    ["running", t("hosts.running"), runningHosts.length],
    ["observing", t("hosts.observing"), observingHosts.length],
    ["inactive", t("hosts.inactive"), inactiveHosts.length],
  ] as const;
  return (
    <div className="page-stack vaults-page">
      <div className="vaults-toolbar">
        <div className="filter-tabs vault-filter-tabs" role="tablist" aria-label={t("hosts.filter")}>
          {vaultTabs.map(([value, label, count]) => <button key={value} type="button" role="tab" aria-selected={vaultFilter === value} className={cn("filter-tab", vaultFilter === value && "is-active")} onClick={() => setVaultFilter(value)}>{label}<span className="filter-tab-count">{count}</span></button>)}
        </div>
        <Button className="vault-toolbar-button" size="icon" aria-label={t("hosts.new")} title={t("hosts.new")} onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /></Button>
      </div>
      {Boolean(error) && <ErrorBanner message={errorMessage(error, t)} />}
      <div className="host-grid">
        {visibleHosts.map((host) => <HostCard key={host.name} host={host} session={session} navigate={navigate} />)}
        {visibleHosts.length === 0 && <EmptyState filtered={vaultFilter !== "all"} />}
      </div>
      {createOpen && <CreateHostModal session={session} onClose={() => setCreateOpen(false)} />}
    </div>
  );
}

function CreateHostModal({ session, onClose }: { session: ShellSession; onClose: () => void }) {
  const { t } = useI18n();
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
      setFormError(errorMessage(error, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal create-vault-modal" role="dialog" aria-modal="true" aria-labelledby="create-vault-title" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div><p className="eyebrow">{t("hosts.newEyebrow")}</p><h2 id="create-vault-title">{t("hosts.createTitle")}</h2><p>{t("hosts.createDescription")}</p></div>
          <Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")} onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
        <form className="form-stack" onSubmit={onSubmit}>
          <label className="field-label" htmlFor="host-name">{t("hosts.name")}</label>
          <Input id="host-name" value={hostName} onChange={(event) => setHostName(event.target.value)} placeholder={t("common.exampleVault")} maxLength={63} required />
          <label className="field-label" htmlFor="host-line">{t("hosts.line")}</label>
          <select id="host-line" className="select" value={line} onChange={(event) => setLine(event.target.value as PolarisVaultLine)}>
            {allowedLines.map((item) => <option value={item} key={item}>{item === "vertical" ? t("common.lineVertical") : t("common.lineCoding")}</option>)}
          </select>
          <label className="check-label"><input type="checkbox" checked={createDefaultProject} onChange={(event) => setCreateDefaultProject(event.target.checked)} /><span>{t("common.defaultLibrary")} <small>{DEFAULT_POLARIS_VAULT_PATH}</small></span></label>
          {formError && <p className="form-error">{formError}</p>}
          <div className="modal-actions"><Button type="button" variant="ghost" onClick={onClose}>{t("common.cancel")}</Button><Button type="submit" disabled={busy || !hostName.trim()}><Plus className="h-4 w-4" />{busy ? t("hosts.creating") : t("common.createAndStart")}</Button></div>
        </form>
      </section>
    </div>
  );
}

function HostCard({ host, session, navigate }: { host: ShellHostSummary; session: ShellSession; navigate: (path: string) => void }) {
  const { t } = useI18n();
  const pending = usePortalStore((state) => state.pendingHosts[host.name] === true);
  const hostAction = usePortalStore((state) => state.hostAction);
  const deleteHost = usePortalStore((state) => state.deleteHost);
  const status = host.status?.driver?.status || "unknown";
  const actions = resolveShellHostActions({ session, host });
  const isWorking = status === "starting" || status === "stopping";
  const isRunning = status === "running";
  const statusVariant = isRunning ? "success" : isWorking ? "warning" : status === "error" ? "danger" : "muted";
  const statusLabel = { running: t("status.running"), starting: t("status.starting"), stopping: t("status.stopping"), stopped: t("status.stopped"), error: t("status.error") }[status] || t("common.notReady");
  const surface = host.surfaces.includes("wanghai") ? t("hosts.surfaceVertical") : t("hosts.surfaceCoding");
  return (
    <Card className="host-card">
      <CardHeader className="host-card-header">
        <div className="host-card-title-row"><div><CardTitle>{host.name}</CardTitle><CardDescription>{surface}</CardDescription></div><Badge variant={statusVariant}>{statusLabel}</Badge></div>
      </CardHeader>
      <CardContent>
        <div className="host-meta"><span><span className="meta-label">{t("common.driver")}</span>{hostDriverStatusLabel(host.status?.driver?.status, t)}</span><span><span className="meta-label">Paseo</span>{host.status?.paseo?.web || t("common.pairing")}</span></div>
        <div className="card-actions">
          {actions.map((action) => <Button key={action.kind} variant="outline" onClick={() => navigate(action.href)} disabled={pending || !isRunning}>{action.kind === "open-coding" ? <><Code2 className="h-4 w-4" />{t("common.coding")}</> : <><MonitorPlay className="h-4 w-4" />{t("common.vertical")}</>}</Button>)}
          <Button variant="secondary" onClick={() => void hostAction(host.name, isRunning ? "stop" : "start")} disabled={pending || isWorking}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : isRunning ? <Square className="h-4 w-4" /> : <Wifi className="h-4 w-4" />}
            {isRunning ? t("hosts.stop") : t("hosts.start")}
          </Button>
          <Button variant="ghost" size="icon" aria-label={t("hosts.deleteLabel", { name: host.name })} title={t("hosts.delete")} onClick={() => { if (window.confirm(t("hosts.deleteConfirm", { name: host.name }))) void deleteHost(host.name); }} disabled={pending}><Trash2 className="h-4 w-4 text-destructive" /></Button>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  const { t } = useI18n();
  return <div className="empty-state"><FolderOpen className="h-7 w-7" /><strong>{filtered ? t("hosts.noMatch") : t("hosts.empty")}</strong><span>{filtered ? t("hosts.switchFilter") : t("hosts.createFirst")}</span></div>;
}

function UserPage({ session }: { session: ShellSession }) {
  const { t } = useI18n();
  const user = usePortalStore((state) => state.user);
  const loadUser = usePortalStore((state) => state.loadUser);
  const readCredential = usePortalStore((state) => state.readCredential);
  const signOut = usePortalStore((state) => state.signOut);
  const [record, setRecord] = useState<PortalCredentialRecord | null>(null);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"profile" | "credentials" | "session">("profile");
  useEffect(() => { void loadUser().catch(() => undefined); }, [loadUser]);
  if (!user) return <LoadingView label={t("account.loading")} />;
  const profileRows = [[t("account.userName"), user.profile.name || user.session.authingUsername || t("account.unset")], [t("account.email"), user.profile.email || t("account.unset")], [t("account.userId"), user.session.userId], [t("account.authingId"), user.session.authingUserId], [t("account.role"), user.session.role || t("account.unset")], [t("account.line"), user.session.line || "coding"], [t("account.plan"), user.session.plan || "free"]];
  return (
    <div className="page-stack narrow-page">
      <div className="filter-tabs account-tabs" role="tablist" aria-label={t("account.info")}>
        <button type="button" role="tab" aria-selected={activeTab === "profile"} aria-controls="account-profile-panel" className={cn("filter-tab", activeTab === "profile" && "is-active")} onClick={() => setActiveTab("profile")}>{t("account.profile")}</button>
        <button type="button" role="tab" aria-selected={activeTab === "credentials"} aria-controls="account-credentials-panel" className={cn("filter-tab", activeTab === "credentials" && "is-active")} onClick={() => setActiveTab("credentials")}>{t("account.credentials")}</button>
        <button type="button" role="tab" aria-selected={activeTab === "session"} aria-controls="account-session-panel" className={cn("filter-tab", activeTab === "session" && "is-active")} onClick={() => setActiveTab("session")}>{t("account.session")}</button>
      </div>
      {activeTab === "profile" && <section className="account-tab-panel" id="account-profile-panel" role="tabpanel"><Card><CardContent><dl className="data-rows">{profileRows.map(([label, value]) => <div className="data-row" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></CardContent></Card></section>}
      {activeTab === "credentials" && <section className="account-tab-panel" id="account-credentials-panel" role="tabpanel"><Card><CardContent>{user.credentials.length === 0 ? <p className="empty-copy">{t("account.noCredentials")}</p> : <div className="data-rows">{user.credentials.map((credential) => <CredentialRow key={credential.id} credential={credential} onOpen={async () => { try { setCredentialError(null); setRecord(await readCredential(user.session.userId, credential.id)); } catch (error) { setCredentialError(errorMessage(error, t)); } }} />)}</div>}{credentialError && <p className="form-error">{credentialError}</p>}</CardContent></Card></section>}
      {activeTab === "session" && <section className="account-tab-panel" id="account-session-panel" role="tabpanel"><Card><CardContent><div className="session-row"><ShieldCheck className="h-5 w-5 text-[var(--portal-accent-bright)]" /><div><strong>{session.authMode === "disabled" ? t("account.localSession") : t("account.authingSession")}</strong><p>{session.authMode === "disabled" ? t("account.localDescription") : t("account.sessionDescription")}</p></div></div>{session.authMode !== "disabled" && <Button variant="destructive" onClick={() => void signOut()}><LogOut className="h-4 w-4" />{t("nav.signOut")}</Button>}</CardContent></Card></section>}
      {record && <CredentialDialog record={record} onClose={() => setRecord(null)} />}
    </div>
  );
}

function CredentialRow({ credential, onOpen }: { credential: PortalCredential; onOpen: () => void }) {
  const { t } = useI18n();
  return <div className="data-row"><dt>{credential.label}</dt><dd><span>{credential.paths.join(" · ") || credential.kind}</span>{credential.status === "ready" && <Button variant="ghost" size="sm" onClick={onOpen}><Eye className="h-4 w-4" />{t("account.view")}</Button>}</dd></div>;
}

function CredentialDialog({ record, onClose }: { record: PortalCredentialRecord; onClose: () => void }) {
  const { t } = useI18n();
  return <div className="modal-backdrop" role="presentation" onClick={onClose}><section className="modal" role="dialog" aria-modal="true" aria-label={record.credential.label} onClick={(event) => event.stopPropagation()}><div className="modal-header"><div><h2>{record.credential.label}</h2><p>{t("account.credentialPreview")}</p></div><Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")} onClick={onClose}><X className="h-4 w-4" /></Button></div>{record.files.map((file) => <pre key={file.key} className="credential-file"><code>{file.sourcePath}{"\n"}{file.content}</code></pre>)}</section></div>;
}

function WelcomePage({ navigate, session }: { navigate: (path: string, replace?: boolean) => void; session: ShellSession | null }) {
  const { t, toggleLanguage } = useI18n();
  const [config, setConfig] = useState<AuthingConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void authingConfig().then(setConfig).catch((reason) => setError(errorMessage(reason, t))); }, [t]);
  useEffect(() => { if (session?.authenticated) navigate("/work", true); }, [navigate, session]);
  const signIn = async () => { if (!config) return; try { await beginSignIn(config, "/work"); } catch (reason) { setError(errorMessage(reason, t)); } };
  return <div className="welcome-page"><Button className="welcome-language-toggle" variant="ghost" size="icon" aria-label={t("nav.language")} title={t("nav.language")} onClick={toggleLanguage}><Languages className="h-4 w-4" /></Button><div className="welcome-panel"><div className="welcome-mark"><Orbit className="h-7 w-7" /></div><p className="eyebrow">POLARIS PORTAL</p><h1>{t("welcome.title")}</h1><p className="page-subtitle">{t("welcome.description")}</p>{error && <ErrorBanner message={error} />}{config?.authMode === "disabled" ? <Button onClick={() => navigate("/work", true)}><ArrowRight className="h-4 w-4" />{t("welcome.enter")}</Button> : <Button onClick={() => void signIn()} disabled={!config}><ArrowRight className="h-4 w-4" />{t("welcome.signIn")}</Button>}</div></div>;
}

function AuthCallbackPage({ navigate }: { navigate: (path: string, replace?: boolean) => void }) {
  const { t } = useI18n();
  const bootstrap = usePortalStore((state) => state.bootstrap);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void completeSignIn().then(async (returnPath) => { await bootstrap(); navigate(returnPath === "/welcome" ? "/work" : returnPath, true); }).catch((reason) => setError(errorMessage(reason, t)));
  }, [bootstrap, navigate]);
  return error ? <div className="center-state"><ErrorBanner message={error} /><Button onClick={() => navigate("/welcome", true)}><ArrowLeft className="h-4 w-4" />{t("welcome.signIn")}</Button></div> : <LoadingView label={t("auth.completing")} />;
}

function SurfacePage({ kind, id, navigate }: { kind: "coding" | "wanghai"; id: string; navigate: (path: string, replace?: boolean) => void }) {
  const { t } = useI18n();
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
        if (!host) throw new Error(t("surface.notFound"));
        if (kind === "coding") {
          const url = await resolvePaseoUrl(`/v/${encodeURIComponent(id)}/coding`, host.status?.paseo?.reconnectTarget);
          if (!cancelled) setSource(url);
        } else {
          const action = resolveWanghaiPortalAction({ session, host });
          if (!action) throw new Error(t("surface.noAccess"));
          const launch = await request<{ portalUrl: string }>(`/g/${encodeURIComponent(id)}/launch`, { method: "POST" });
          if (!cancelled) setSource(launch.portalUrl);
        }
      } catch (reason) {
        if (!cancelled) setError(errorMessage(reason, t));
      }
    })();
    return () => { cancelled = true; };
  }, [id, kind, refreshHosts, session]);
  if (error) return <div className="center-state"><ErrorBanner message={error} /><Button variant="outline" onClick={() => navigate("/hosts", true)}><ArrowLeft className="h-4 w-4" />{t("surface.back")}</Button></div>;
  return <div className="surface-page"><a href="/hosts" className={cn(buttonVariants({ variant: "secondary" }), "surface-back")} onClick={(event) => { event.preventDefault(); navigate("/hosts"); }}><ArrowLeft className="h-4 w-4" />{t("surface.back")}</a>{source ? <iframe className="surface-frame" title={kind === "coding" ? t("surface.codingTitle") : t("surface.verticalTitle")} src={source} allow="clipboard-read; clipboard-write" /> : <LoadingView label={t("surface.opening")} />}</div>;
}

function LoadingView({ label }: { label: string }) { return <div className="center-state"><Loader2 className="h-6 w-6 animate-spin text-primary" /><span>{label}</span></div>; }
function ErrorView({ message, onDismiss }: { message: string; onDismiss?: () => void }) { const { t } = useI18n(); return <div className="center-state"><ErrorBanner message={message} />{onDismiss && <Button variant="ghost" onClick={onDismiss}>{t("common.close")}</Button>}</div>; }
function ErrorBanner({ message }: { message: string }) { return <div className="error-banner"><X className="h-4 w-4" /><span>{message}</span></div>; }
