import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleUserRound,
  Code2,
  Copy,
  ExternalLink,
  Eye,
  FolderOpen,
  Loader2,
  LogOut,
  MonitorPlay,
  Orbit,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
  UserRound,
  Wifi,
  WifiOff,
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
  if (path === "/" || path === "/settings") {
    queueMicrotask(() => navigate("/hosts", true));
    return <LoadingView label="正在打开主机目录" />;
  }
  if (path === "/hosts" || path === "/hosts/") {
    return <PortalLayout active="hosts" session={session} navigate={navigate}><HostsPage session={session} navigate={navigate} /></PortalLayout>;
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
  active: "hosts" | "user";
  session: ShellSession;
  navigate: (path: string, replace?: boolean) => void;
  children: React.ReactNode;
}) {
  const streamStatus = usePortalStore((state) => state.streamStatus);
  const signOut = usePortalStore((state) => state.signOut);
  const streamConnected = streamStatus === "connected";
  const link = (path: string, label: string, Icon: typeof Server) => (
    <a
      href={path}
      onClick={(event) => { event.preventDefault(); navigate(path); }}
      className={cn("nav-link", active === (path === "/hosts" ? "hosts" : "user") && "is-active")}
    >
      <Icon className="h-4 w-4" />
      {label}
    </a>
  );
  return (
    <div className="portal-root">
      <header className="portal-topbar">
        <div className="portal-topbar-inner">
          <a href="/hosts" className="brand" onClick={(event) => { event.preventDefault(); navigate("/hosts"); }}>
            <span className="brand-mark"><Orbit className="h-5 w-5" /></span>
            <span>POLARIS</span>
            <span className="brand-caption">PORTAL</span>
          </a>
          <nav className="portal-nav" aria-label="主导航">
            {link("/hosts", "主机", Server)}
            {link("/settings/user", "账户", CircleUserRound)}
          </nav>
          <div className="portal-topbar-actions">
            <Badge variant={streamConnected ? "success" : "muted"} className="connection-badge">
              {streamConnected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
              {streamStatus === "reconnecting" ? "重连中" : streamConnected ? "实时" : "离线"}
            </Badge>
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

function HostsPage({ session, navigate }: { session: ShellSession; navigate: (path: string, replace?: boolean) => void }) {
  const hostsByName = usePortalStore((state) => state.hostsByName);
  const error = usePortalStore((state) => state.error);
  const refreshHosts = usePortalStore((state) => state.refreshHosts);
  const connectLiveStream = usePortalStore((state) => state.connectLiveStream);
  const closeLiveStream = usePortalStore((state) => state.closeLiveStream);
  const streamStatus = usePortalStore((state) => state.streamStatus);
  const hosts = useMemo(() => Object.values(hostsByName).sort((left, right) => left.name.localeCompare(right.name)), [hostsByName]);

  useEffect(() => {
    if (!session.polarisUserId) return;
    void refreshHosts().catch(() => undefined);
    connectLiveStream(session.polarisUserId);
    return closeLiveStream;
  }, [closeLiveStream, connectLiveStream, refreshHosts, session.polarisUserId]);

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">VAULT DIRECTORY</p>
          <h1>主机</h1>
          <p className="page-subtitle">管理当前账户拥有的隔离运行时，并进入已授权的工作面。</p>
        </div>
        <Button variant="outline" onClick={() => void refreshHosts()} disabled={streamStatus === "connecting"}>
          <RefreshCw className="h-4 w-4" />
          刷新
        </Button>
      </section>
      {error && <ErrorBanner message={error} />}
      <div className="metric-strip" aria-label="主机统计">
        <Metric label="已拥有主机" value={String(hosts.length)} icon={Server} />
        <Metric label="运行中" value={String(hosts.filter((host) => host.status?.driver?.status === "running").length)} icon={Wifi} tone="green" />
        <Metric label="等待观察" value={String(hosts.filter((host) => ["starting", "stopping"].includes(host.status?.driver?.status || "")).length)} icon={RefreshCw} tone="amber" />
      </div>
      <div className="host-grid">
        <CreateHostCard session={session} />
        {hosts.map((host) => <HostCard key={host.name} host={host} session={session} navigate={navigate} />)}
        {hosts.length === 0 && <EmptyState />}
      </div>
    </div>
  );
}

function Metric({ label, value, icon: Icon, tone = "blue" }: { label: string; value: string; icon: typeof Server; tone?: "blue" | "green" | "amber" }) {
  return <div className={cn("metric", `metric-${tone}`)}><span className="metric-icon"><Icon className="h-4 w-4" /></span><span><strong>{value}</strong><small>{label}</small></span></div>;
}

function CreateHostCard({ session }: { session: ShellSession }) {
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
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="create-card">
      <CardHeader>
        <div className="card-icon"><Plus className="h-4 w-4" /></div>
        <CardTitle>创建主机</CardTitle>
        <CardDescription>为当前订阅产品线准备一个隔离运行时。</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="form-stack" onSubmit={onSubmit}>
          <label className="field-label" htmlFor="host-name">主机名称</label>
          <Input id="host-name" value={hostName} onChange={(event) => setHostName(event.target.value)} placeholder="例如 sample-vault" maxLength={63} required />
          <label className="field-label" htmlFor="host-line">产品线</label>
          <select id="host-line" className="select" value={line} onChange={(event) => setLine(event.target.value as PolarisVaultLine)}>
            {allowedLines.map((item) => <option value={item} key={item}>{item === "vertical" ? "Vertical" : "Coding"}</option>)}
          </select>
          <label className="check-label"><input type="checkbox" checked={createDefaultProject} onChange={(event) => setCreateDefaultProject(event.target.checked)} /><span>创建默认库 <small>{DEFAULT_POLARIS_VAULT_PATH}</small></span></label>
          {formError && <p className="form-error">{formError}</p>}
          <Button type="submit" disabled={busy || !hostName.trim()}><Plus className="h-4 w-4" />{busy ? "正在创建" : "创建并启动"}</Button>
        </form>
      </CardContent>
    </Card>
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

function EmptyState() {
  return <div className="empty-state"><FolderOpen className="h-7 w-7" /><strong>还没有主机</strong><span>使用左侧表单创建第一个隔离运行时。</span></div>;
}

function UserPage({ session }: { session: ShellSession }) {
  const user = usePortalStore((state) => state.user);
  const loadUser = usePortalStore((state) => state.loadUser);
  const readCredential = usePortalStore((state) => state.readCredential);
  const signOut = usePortalStore((state) => state.signOut);
  const [record, setRecord] = useState<PortalCredentialRecord | null>(null);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  useEffect(() => { void loadUser().catch(() => undefined); }, [loadUser]);
  if (!user) return <LoadingView label="正在加载账户" />;
  const profileRows = [["用户名称", user.profile.name || user.session.authingUsername || "未设置"], ["邮箱", user.profile.email || "未设置"], ["用户 ID", user.session.userId], ["Authing ID", user.session.authingUserId], ["角色", user.session.role || "未设置"], ["产品线", user.session.line || "coding"], ["套餐", user.session.plan || "free"]];
  return (
    <div className="page-stack narrow-page">
      <section className="page-heading"><div><p className="eyebrow">ACCOUNT</p><h1>账户</h1><p className="page-subtitle">身份、凭证和当前会话。</p></div></section>
      <section className="peer-section"><h2>基本信息</h2><Card><CardContent><dl className="data-rows">{profileRows.map(([label, value]) => <div className="data-row" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></CardContent></Card></section>
      <section className="peer-section"><h2>凭证</h2><Card><CardContent>{user.credentials.length === 0 ? <p className="empty-copy">还没有凭证。</p> : <div className="data-rows">{user.credentials.map((credential) => <CredentialRow key={credential.id} credential={credential} onOpen={async () => { try { setCredentialError(null); setRecord(await readCredential(user.session.userId, credential.id)); } catch (error) { setCredentialError(error instanceof Error ? error.message : String(error)); } }} />)}</div>}{credentialError && <p className="form-error">{credentialError}</p>}</CardContent></Card></section>
      <section className="peer-section"><h2>会话</h2><Card><CardContent><div className="session-row"><ShieldCheck className="h-5 w-5 text-[var(--portal-accent-bright)]" /><div><strong>{session.authMode === "disabled" ? "本地开发会话" : "Authing 会话"}</strong><p>{session.authMode === "disabled" ? "本地开发模式使用固定默认用户，无需登录或退出。" : "退出当前 Polaris 会话。"}</p></div></div>{session.authMode !== "disabled" && <Button variant="destructive" onClick={() => void signOut()}><LogOut className="h-4 w-4" />退出登录</Button>}</CardContent></Card></section>
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
  useEffect(() => { if (session?.authenticated) navigate("/hosts", true); }, [navigate, session]);
  const signIn = async () => { if (!config) return; try { await beginSignIn(config, "/hosts"); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  return <div className="welcome-page"><div className="welcome-panel"><div className="welcome-mark"><Orbit className="h-7 w-7" /></div><p className="eyebrow">POLARIS PORTAL</p><h1>隔离运行时控制台</h1><p className="page-subtitle">从一个账户管理主机、工作面和凭证。</p>{error && <ErrorBanner message={error} />}{config?.authMode === "disabled" ? <Button onClick={() => navigate("/hosts", true)}><ArrowRight className="h-4 w-4" />进入 Portal</Button> : <Button onClick={() => void signIn()} disabled={!config}><ArrowRight className="h-4 w-4" />登录</Button>}</div></div>;
}

function AuthCallbackPage({ navigate }: { navigate: (path: string, replace?: boolean) => void }) {
  const bootstrap = usePortalStore((state) => state.bootstrap);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void completeSignIn().then(async (returnPath) => { await bootstrap(); navigate(returnPath === "/welcome" ? "/hosts" : returnPath, true); }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
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
