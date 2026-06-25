import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  ArrowUpRight,
  FolderKanban,
  PlusCircle,
  RefreshCw,
} from "lucide-react";
import {
  createWorkspace,
  getDefaultUserId,
  getUserProfile,
  getWorkspaceDetail,
  listCredentials,
  listUsers,
  listWorkspaces,
  switchWorkspaceDriver,
  updateUserProfile,
  type PortalCredentialSummary,
  type PortalProfileDetail,
  type PortalProfileSummary,
  type PortalWorkspaceDetail,
  type PortalWorkspaceSummary,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Language = "en" | "zh";

type LanguageContextValue = {
  language: Language;
  setLanguage: (value: Language) => void;
  t: (key: string) => string;
};

const COPY: Record<Language, Record<string, string>> = {
  en: {
    app_name: "Polaris",
    select_user: "Select a user",
    switch_user: "Switch user",
    switch_workspace: "Select workspace",
    workspaces: "Workspaces",
    add_workspace: "Add workspace",
    loading_workspaces: "Loading workspaces...",
    no_workspaces: "No workspaces yet.",
    users: "Users",
    select_user_route: "Select a user route to manage workspaces.",
    loading_users: "Loading users...",
    workspaces_title: "Workspaces",
    loading_first_workspace: "Loading first workspace...",
    opening_first_workspace: "Opening the first workspace.",
    no_workspace_for_user: "No workspace exists yet for this user.",
    workspace_name: "Workspace name",
    provisioning: "Provisioning...",
    create_workspace: "Create workspace",
    switch_driver: "Switch driver",
    switch_driver_desc: "Reuse the existing Polaris switch workflow.",
    switching: "Switching...",
    switch_workspace_action: "Switch workspace",
    current_driver: "Current driver",
    loading_workspace: "Loading workspace...",
    workspace_state: "Workspace state",
    daemon_pairing: "Daemon pairing",
    backend: "Backend",
    live_target: "Live target",
    provisioning_title: "Provisioning",
    open_live_target: "Open live target",
    credentials: "Credentials",
    credentials_for_user: "User-owned credentials for this user.",
    loading_credentials: "Loading credentials...",
    no_credentials: "No credentials found.",
    user_profile: "User profile",
    user_profile_desc: "Edit the active user information.",
    loading_profile: "Loading profile...",
    name: "Name",
    email: "Email",
    github_account: "GitHub account",
    ssh_comment: "SSH comment",
    user_id: "User id",
    ssh_mode: "SSH mode",
    tracked_workspaces: "Tracked workspaces",
    purposes: "Purposes",
    workspace_example: "morpheus",
    select_driver: "Select driver",
    create_suffix: "create",
    no_backend_detail: "No backend detail.",
    no_service_detail: "No service detail.",
    no_profile_detail: "No profile detail.",
    workspace_overview: "Workspace overview",
    status_ready: "Ready",
    status_unknown: "Unknown",
    status_error: "Error",
    status_failed: "Failed",
    status_provisioning: "Provisioning",
    status_not_selected: "Not selected",
    none: "none",
    saving: "Saving...",
    save_profile: "Save profile",
    not_selected: "not-selected",
    unknown: "unknown",
    ready: "ready",
    lang_en: "EN",
    lang_zh: "中文",
    language: "Language",
    profile: "Profile",
  },
  zh: {
    app_name: "Polaris",
    select_user: "选择用户",
    switch_user: "切换用户",
    switch_workspace: "选择工作空间",
    workspaces: "工作空间",
    add_workspace: "新增工作空间",
    loading_workspaces: "正在加载工作空间…",
    no_workspaces: "暂无工作空间。",
    users: "用户",
    select_user_route: "选择一个用户以管理其工作空间。",
    loading_users: "正在加载用户…",
    workspaces_title: "工作空间",
    loading_first_workspace: "正在加载首个工作空间…",
    opening_first_workspace: "正在打开首个工作空间。",
    no_workspace_for_user: "该用户还没有工作空间。",
    workspace_name: "工作空间名称",
    provisioning: "正在准备…",
    create_workspace: "创建工作空间",
    switch_driver: "切换驱动",
    switch_driver_desc: "复用现有的 Polaris 切换流程。",
    switching: "切换中…",
    switch_workspace_action: "切换工作空间",
    current_driver: "当前驱动",
    loading_workspace: "正在加载工作空间…",
    workspace_state: "工作空间状态",
    daemon_pairing: "配对状态",
    backend: "后端",
    live_target: "访问入口",
    provisioning_title: "准备进度",
    open_live_target: "打开访问入口",
    credentials: "凭证",
    credentials_for_user: "该用户所属的凭证。",
    loading_credentials: "正在加载凭证…",
    no_credentials: "暂无凭证。",
    user_profile: "用户资料",
    user_profile_desc: "编辑当前用户信息。",
    loading_profile: "正在加载用户资料…",
    name: "名称",
    email: "邮箱",
    github_account: "GitHub 账号",
    ssh_comment: "SSH 注释",
    user_id: "用户 ID",
    ssh_mode: "SSH 模式",
    tracked_workspaces: "已跟踪工作空间",
    purposes: "用途",
    workspace_example: "morpheus",
    select_driver: "选择驱动",
    create_suffix: "创建",
    no_backend_detail: "暂无后端详情。",
    no_service_detail: "暂无服务详情。",
    no_profile_detail: "暂无用户配置详情。",
    workspace_overview: "工作空间概览",
    status_ready: "就绪",
    status_unknown: "未知",
    status_error: "错误",
    status_failed: "失败",
    status_provisioning: "准备中",
    status_not_selected: "未选中",
    none: "无",
    saving: "保存中…",
    save_profile: "保存资料",
    not_selected: "未选中",
    unknown: "未知",
    ready: "就绪",
    lang_en: "EN",
    lang_zh: "中文",
    language: "语言",
    profile: "资料",
  },
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

function useStoredLanguage(): [Language, (value: Language) => void] {
  const [language, setLanguage] = useState<Language>(() => {
    if (typeof window === "undefined") {
      return "zh";
    }
    const stored = window.localStorage.getItem("polaris-language");
    return stored === "en" ? "en" : "zh";
  });

  function updateLanguage(next: Language): void {
    setLanguage(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("polaris-language", next);
    }
  }

  return [language, updateLanguage];
}

function useLanguage(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("Language context is not available");
  }
  return context;
}

function driverLabel(driver: { backend: string; profile?: string } | null): string {
  if (!driver) {
    return "not-selected";
  }
  return driver.backend === "pod" && driver.profile
    ? `pod:${driver.profile}`
    : driver.backend;
}

function translateState(
  value: string | null | undefined,
  t: (key: string) => string,
): string {
  if (!value) {
    return t("status_unknown");
  }
  switch (value) {
    case "ready":
      return t("status_ready");
    case "unknown":
      return t("status_unknown");
    case "error":
      return t("status_error");
    case "failed":
      return t("status_failed");
    case "provisioning":
      return t("status_provisioning");
    case "not-selected":
      return t("status_not_selected");
    default:
      return value;
  }
}

function formatBackendValue(
  data: PortalWorkspaceDetail,
  t: (key: string) => string,
): string {
  const kind = data.status?.backend.kind ?? t("status_unknown");
  const profile = data.status?.backend.profile ?? t("status_unknown");
  return `${kind} / ${profile}`;
}

function statusTone(state?: string): "default" | "secondary" | "destructive" {
  if (state === "ready") {
    return "default";
  }
  if (state === "error" || state === "failed") {
    return "destructive";
  }
  return "secondary";
}

function useAsyncValue<T>(
  factory: () => Promise<T>,
  deps: unknown[],
): { data: T | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void factory()
      .then((value) => {
        if (!cancelled) {
          setData(value);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, deps);

  return { data, error, loading };
}

function PortalShell(props: {
  children: ReactNode;
  users: PortalProfileSummary[];
}) {
  const { language, setLanguage, t } = useLanguage();
  const location = useLocation();
  const navigate = useNavigate();
  const activeUser = props.users.find((user) =>
    location.pathname.includes(`/users/${user.id}/`),
  ) ?? null;
  const activeUserId = activeUser?.id ?? "";
  const {
    data: sidebarWorkspaces,
    loading: sidebarWorkspacesLoading,
  } = useAsyncValue(
    () => activeUserId ? listWorkspaces(activeUserId) : Promise.resolve<PortalWorkspaceSummary[]>([]),
    [activeUserId],
  );
  const currentWorkspaceName = location.pathname.includes("/workspaces/")
    ? decodeURIComponent(location.pathname.split("/workspaces/")[1] ?? "")
    : "";

  function workspaceLink(workspaceName: string): string {
    return `/users/${encodeURIComponent(activeUserId)}/workspaces/${encodeURIComponent(workspaceName)}`;
  }

  function userWorkspaceIndexLink(): string {
    return `/users/${encodeURIComponent(activeUserId)}/workspaces`;
  }

  function onUserChange(nextUserId: string): void {
    if (!nextUserId) {
      return;
    }
    navigate(`/users/${encodeURIComponent(nextUserId)}/workspaces`);
  }

  function onWorkspaceChange(nextWorkspace: string): void {
    if (!nextWorkspace) {
      return;
    }
    navigate(workspaceLink(nextWorkspace));
  }

  return (
    <div className="box-border w-full px-4 py-4 sm:px-6 sm:py-6 lg:h-dvh lg:overflow-hidden">
      <div className="grid w-full grid-cols-1 content-start gap-6 lg:h-full lg:grid-rows-[auto,minmax(0,1fr)]">
        <Card>
          <CardContent className="grid gap-4 p-5 lg:flex lg:items-center lg:justify-between">
            <div className="grid min-w-0 gap-4 lg:flex lg:w-full lg:items-center lg:justify-between">
              <div className="-m-2 min-w-0 rounded-[1rem] p-2">
                <div className="text-lg font-semibold">{t("app_name")}</div>
              </div>
              <div className="grid min-w-0 gap-3 lg:flex lg:min-w-0 lg:items-center">
                <div className="w-full min-w-0 lg:max-w-[22rem]">
                  <Select value={activeUser?.id ?? ""} onValueChange={onUserChange}>
                    <SelectTrigger>
                      <SelectValue placeholder={t("switch_user")} />
                    </SelectTrigger>
                    <SelectContent>
                      {props.users.map((user) => (
                        <SelectItem key={user.id} value={user.id}>
                          {user.name || user.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {activeUser && (
                  <div className="w-full min-w-0 lg:hidden">
                    <Select value={currentWorkspaceName} onValueChange={onWorkspaceChange}>
                      <SelectTrigger>
                        <SelectValue placeholder={t("switch_workspace")} />
                      </SelectTrigger>
                      <SelectContent>
                        {sidebarWorkspaces?.map((workspace) => (
                          <SelectItem key={workspace.name} value={workspace.name}>
                            {workspace.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setLanguage(language === "en" ? "zh" : "en")}
                >
                  {language === "en" ? t("lang_zh") : t("lang_en")}
                </Button>
                {activeUser && (
                  <Link to={`/users/${encodeURIComponent(activeUser.id)}/profile`}>
                    <Button variant="secondary">
                      {activeUser.name || activeUser.id}
                    </Button>
                  </Link>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid w-full min-w-0 grid-cols-1 items-start gap-6 lg:min-h-0 lg:grid-cols-[320px_minmax(0,1fr)] lg:items-stretch">
          <aside className="hidden lg:block lg:min-h-0">
            <div className="h-full min-h-0">
              <Card className="flex h-full min-h-0 flex-col overflow-hidden">
                <CardHeader className="shrink-0 gap-2 pb-4">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                    <FolderKanban className="h-4 w-4" />
                    {t("workspaces")}
                  </div>
                </CardHeader>
                <CardContent className="grid min-h-0 auto-rows-max content-start flex-1 gap-2 overflow-y-auto pr-4">
                      <Link
                        to={`${userWorkspaceIndexLink()}#create-workspace`}
                        className="box-border block w-full min-w-0 rounded-[1.1rem] border border-dashed border-primary/35 bg-primary/5 px-4 py-3 text-sm font-medium text-primary transition hover:bg-primary/10"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <PlusCircle className="h-4 w-4" />
                          <span className="truncate">{t("add_workspace")}</span>
                        </span>
                      </Link>

                      {sidebarWorkspacesLoading && (
                        <div className="box-border w-full min-w-0 rounded-[1.1rem] border border-border bg-white px-4 py-3 text-sm text-muted-foreground">
                          {t("loading_workspaces")}
                        </div>
                      )}

                      {sidebarWorkspaces?.map((workspace) => {
                        const active = location.pathname.includes(
                          `/workspaces/${encodeURIComponent(workspace.name)}`,
                        );
                        return (
                          <Link
                            key={workspace.name}
                            to={workspaceLink(workspace.name)}
                            className={[
                              "box-border block w-full min-w-0 rounded-[1.1rem] border px-4 py-3 transition",
                              active
                                ? "border-primary/30 bg-primary/10 text-foreground"
                                : "border-border bg-white hover:bg-muted/40",
                            ].join(" ")}
                          >
                            <div className="flex min-w-0 items-center justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium">
                                  {workspace.name}
                                </div>
                                <div className="truncate text-xs text-muted-foreground">
                                  {driverLabel(workspace.selectedDriver) || t("not_selected")}
                                </div>
                              </div>
                              <Badge variant={statusTone(workspace.status?.state)}>
                                {translateState(workspace.status?.state, t)}
                              </Badge>
                            </div>
                          </Link>
                        );
                      })}

                      {!sidebarWorkspacesLoading && sidebarWorkspaces?.length === 0 && (
                        <div className="box-border w-full min-w-0 rounded-[1.1rem] border border-border bg-white px-4 py-3 text-sm text-muted-foreground">
                          {t("no_workspaces")}
                        </div>
                      )}
                </CardContent>
              </Card>
            </div>
          </aside>

          <main className="grid w-full min-w-0 grid-cols-1 content-start gap-6 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
            {props.children}
          </main>
        </div>
      </div>
    </div>
  );
}

function OverviewPage() {
  const { t } = useLanguage();
  const { data: users, error, loading } = useAsyncValue(listUsers, []);
  const { data: defaultUserId } = useAsyncValue(getDefaultUserId, []);

  if (defaultUserId) {
    return <Navigate to={`/users/${encodeURIComponent(defaultUserId)}/workspaces`} replace />;
  }

  return (
    <PortalShell users={users ?? []}>
      <Card>
        <CardHeader>
          <CardTitle>{t("users")}</CardTitle>
          <CardDescription>
            {t("select_user_route")}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {loading && <p className="text-sm text-muted-foreground">{t("loading_users")}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {users?.map((user) => (
            <Link
              key={user.id}
              to={`/users/${encodeURIComponent(user.id)}/workspaces`}
              className="rounded-2xl border border-border bg-white p-4 hover:bg-muted/40"
            >
              <div className="font-medium">{user.name || user.id}</div>
              <div className="text-sm text-muted-foreground">{user.email}</div>
            </Link>
          ))}
        </CardContent>
      </Card>
    </PortalShell>
  );
}

function WorkspaceIndexPage() {
  const { t } = useLanguage();
  const { userId = "" } = useParams();
  const navigate = useNavigate();
  const { data: users } = useAsyncValue(listUsers, []);
  const { data: workspaces, error, loading } = useAsyncValue(
    () => listWorkspaces(userId),
    [userId],
  );
  const [workspaceName, setWorkspaceName] = useState("");
  const [creating, setCreating] = useState(false);

  async function handleCreate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!workspaceName.trim()) {
      return;
    }
    setCreating(true);
    try {
      await createWorkspace(userId, workspaceName.trim());
      navigate(`/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspaceName.trim())}`);
    } finally {
      setCreating(false);
    }
  }

  useEffect(() => {
    if (!workspaces?.length) {
      return;
    }
    void navigate(
      `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspaces[0]!.name)}`,
      { replace: true },
    );
  }, [navigate, userId, workspaces]);

  return (
    <PortalShell users={users ?? []}>
        <Card>
        <CardHeader>
            <CardTitle>{t("workspaces_title")}</CardTitle>
          <CardDescription>
            {loading
              ? t("loading_first_workspace")
              : error
                ? error
                : workspaces?.length
                  ? t("opening_first_workspace")
                  : t("no_workspace_for_user")}
          </CardDescription>
        </CardHeader>
        {!workspaces?.length && (
          <CardContent id="create-workspace">
            <form className="grid w-full gap-4" onSubmit={(event) => void handleCreate(event)}>
              <div className="grid gap-2">
                <Label htmlFor="workspace-name">{t("workspace_name")}</Label>
                <Input
                  id="workspace-name"
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  placeholder={t("workspace_example")}
                />
              </div>
              <Button className="justify-self-start" disabled={creating || workspaceName.trim().length === 0}>
                {creating ? t("provisioning") : t("create_workspace")}
              </Button>
            </form>
          </CardContent>
        )}
      </Card>
    </PortalShell>
  );
}

function WorkspaceDetailPage() {
  const { t } = useLanguage();
  const { userId = "", workspaceName = "" } = useParams();
  const { data: users } = useAsyncValue(listUsers, []);
  const { data, error, loading } = useAsyncValue(
    () => getWorkspaceDetail(userId, workspaceName),
    [userId, workspaceName],
  );
  const [driver, setDriver] = useState("");
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (data?.selectedDriver) {
      setDriver(driverLabel(data.selectedDriver));
    }
  }, [data]);

  async function handleSwitch(): Promise<void> {
    if (!driver) {
      return;
    }
    setSwitching(true);
    try {
      await switchWorkspaceDriver(userId, workspaceName, driver);
      window.location.reload();
    } finally {
      setSwitching(false);
    }
  }

  return (
    <PortalShell users={users ?? []}>
      <div className="grid w-full grid-cols-1 content-start gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t("switch_driver")}</CardTitle>
            <CardDescription>
              {t("switch_driver_desc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid w-full gap-4">
            <Select value={driver} onValueChange={setDriver}>
              <SelectTrigger>
                <SelectValue placeholder={t("select_driver")} />
              </SelectTrigger>
              <SelectContent>
                {data?.availableDrivers.map((item) => {
                  const label = driverLabel(item);
                  return (
                    <SelectItem key={label} value={label}>
                      {item.available ? label : `${label} (${t("create_suffix")})`}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <Button className="justify-self-start" onClick={() => void handleSwitch()} disabled={switching || !driver}>
              <RefreshCw className="h-4 w-4" />
              {switching ? t("switching") : t("switch_workspace_action")}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("workspace_overview")}</CardTitle>
            <CardDescription>
              {workspaceName} · {t("current_driver")}:{" "}
              {data ? driverLabel(data.selectedDriver) : t("loading_workspace")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {loading && <p className="text-sm text-muted-foreground">{t("loading_workspace")}</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
            {data && (
              <>
                <div className="grid gap-3 md:grid-cols-2">
                  <MetricCard
                    label={t("workspace_state")}
                    value={translateState(data.status?.state, t)}
                  />
                  <MetricCard
                    label={t("daemon_pairing")}
                    value={translateState(data.status?.daemon?.pairing?.state, t)}
                  />
                  <MetricCard
                    label={t("backend")}
                    value={formatBackendValue(data, t)}
                  />
                  <MetricCard
                    label={t("live_target")}
                    value={data.liveTarget ?? t("status_unknown")}
                  />
                </div>
                {data.progress && (
                  <Card className="border-dashed bg-background/80 shadow-none">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">{t("provisioning_title")}</CardTitle>
                      <CardDescription>{data.progress.message}</CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-2">
                      <div className="flex justify-between text-sm text-muted-foreground">
                        <span>{data.progress.phase}</span>
                        <span>{data.progress.percent}%</span>
                      </div>
                      <Progress value={data.progress.percent} />
                    </CardContent>
                  </Card>
                )}
                <div className="box-border grid w-full min-w-0 gap-2 rounded-[1.25rem] border border-border bg-white p-4 text-sm text-muted-foreground">
                  <div className="min-w-0 break-words">
                    {data.status?.details.backendDetail ?? t("no_backend_detail")}
                  </div>
                  <div className="min-w-0 break-words">
                    {data.status?.details.serviceDetail ?? t("no_service_detail")}
                  </div>
                  <div className="min-w-0 break-words">
                    {data.status?.details.userProfileDetail ?? t("no_profile_detail")}
                  </div>
                </div>
                {data.liveTarget && (
                  <a
                    className="inline-flex min-w-0 items-center gap-2 break-all text-sm font-medium text-primary"
                    href={data.liveTarget}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("open_live_target")}
                    <ArrowUpRight className="h-4 w-4" />
                  </a>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </PortalShell>
  );
}

function MetricCard(props: { label: string; value: string }) {
  return (
    <div className="box-border w-full min-w-0 rounded-[1.25rem] border border-border bg-white p-4">
      <div className="text-sm text-muted-foreground">{props.label}</div>
      <div className="mt-1 min-w-0 break-words font-medium">{props.value}</div>
    </div>
  );
}

function CredentialsPage() {
  const { language, t } = useLanguage();
  const { userId = "" } = useParams();
  const { data: users } = useAsyncValue(listUsers, []);
  const { data, error, loading } = useAsyncValue(() => listCredentials(userId), [userId]);

  return (
    <PortalShell users={users ?? []}>
      <Card>
        <CardHeader>
          <CardTitle>{t("credentials")}</CardTitle>
          <CardDescription>
            {t("credentials_for_user")}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {loading && <p className="text-sm text-muted-foreground">{t("loading_credentials")}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {data?.map((credential) => (
            <CredentialCard key={credential.id} credential={credential} language={language} />
          ))}
        </CardContent>
      </Card>
    </PortalShell>
  );
}

function ProfilePage() {
  const { language, t } = useLanguage();
  const { userId = "" } = useParams();
  const { data: users } = useAsyncValue(listUsers, []);
  const { data: profile, error, loading } = useAsyncValue(() => getUserProfile(userId), [userId]);
  const { data: credentials } = useAsyncValue(() => listCredentials(userId), [userId]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [githubAccount, setGithubAccount] = useState("");
  const [sshComment, setSshComment] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!profile) {
      return;
    }
    setName(profile.name);
    setEmail(profile.email);
    setGithubAccount(profile.githubAccount ?? "");
    setSshComment(profile.sshComment ?? "");
  }, [profile]);

  async function handleSave(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    try {
      const updated = await updateUserProfile(userId, {
        name,
        email,
        githubAccount,
        sshComment,
      });
      setName(updated.name);
      setEmail(updated.email);
      setGithubAccount(updated.githubAccount ?? "");
      setSshComment(updated.sshComment ?? "");
    } finally {
      setSaving(false);
    }
  }

  return (
    <PortalShell users={users ?? []}>
      <div className="grid w-full grid-cols-1 content-start gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t("user_profile")}</CardTitle>
            <CardDescription>
              {t("user_profile_desc")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading && <p className="text-sm text-muted-foreground">{t("loading_profile")}</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
            {profile && (
              <form className="grid gap-4" onSubmit={(event) => void handleSave(event)}>
                <div className="grid gap-2">
                  <Label htmlFor="profile-name">{t("name")}</Label>
                  <Input id="profile-name" value={name} onChange={(event) => setName(event.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="profile-email">{t("email")}</Label>
                  <Input id="profile-email" value={email} onChange={(event) => setEmail(event.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="profile-github">{t("github_account")}</Label>
                  <Input
                    id="profile-github"
                    value={githubAccount}
                    onChange={(event) => setGithubAccount(event.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="profile-ssh-comment">{t("ssh_comment")}</Label>
                  <Input
                    id="profile-ssh-comment"
                    value={sshComment}
                    onChange={(event) => setSshComment(event.target.value)}
                  />
                </div>
                <div className="grid gap-2 text-sm text-muted-foreground">
                  <div>{t("user_id")}: {profile.id}</div>
                  <div>{t("ssh_mode")}: {profile.sshMode ?? t("unknown")}</div>
                  <div>{t("tracked_workspaces")}: {profile.workspaces.join(", ") || t("none")}</div>
                </div>
                <Button className="justify-self-start" disabled={saving}>
                  {saving ? t("saving") : t("save_profile")}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("credentials")}</CardTitle>
            <CardDescription>
              {t("credentials_for_user")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {credentials?.map((credential) => (
              <CredentialCard key={credential.id} credential={credential} language={language} />
            ))}
            {!credentials?.length && (
              <p className="text-sm text-muted-foreground">{t("no_credentials")}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </PortalShell>
  );
}

function CredentialCard(props: {
  credential: PortalCredentialSummary;
  language: Language;
}) {
  const { credential, language } = props;
  const t = (key: string): string => COPY[language][key] ?? key;
  return (
    <div className="box-border grid w-full min-w-0 gap-3 rounded-[1.25rem] border border-border bg-white p-4 md:grid-cols-[1fr_auto]">
      <div className="grid gap-1">
        <div className="flex items-center gap-2">
          <div className="font-medium">{credential.label}</div>
          <Badge variant="outline">{credential.kind}</Badge>
        </div>
        <div className="min-w-0 break-words text-sm text-muted-foreground">{credential.id}</div>
        <div className="min-w-0 break-words text-sm text-muted-foreground">
          {t("purposes")}: {credential.purposes.join(", ") || t("none")}
        </div>
      </div>
      <div className="flex flex-col items-start gap-2 md:items-end">
        <Badge variant={credential.status === "ready" ? "default" : "secondary"}>
          {translateState(credential.status, t)}
        </Badge>
        {credential.paths.map((item) => (
          <div key={item} className="min-w-0 break-words text-xs text-muted-foreground">
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [language, setLanguage] = useStoredLanguage();
  const value: LanguageContextValue = {
    language,
    setLanguage,
    t: (key: string): string => COPY[language][key] ?? key,
  };

  return (
    <LanguageContext.Provider value={value}>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/users/:userId/profile" element={<ProfilePage />} />
        <Route path="/users/:userId/workspaces" element={<WorkspaceIndexPage />} />
        <Route path="/users/:userId/workspaces/:workspaceName" element={<WorkspaceDetailPage />} />
        <Route path="/users/:userId/credentials" element={<CredentialsPage />} />
      </Routes>
    </LanguageContext.Provider>
  );
}
