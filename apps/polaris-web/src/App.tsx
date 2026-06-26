import * as React from "react";
import { SignIn, SignUp, useAuth, useClerk, useUser } from "@clerk/react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
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
  ChevronRight,
  CircleUser,
  Eye,
  EyeOff,
  FolderKanban,
  Info,
  CreditCard,
  PlusCircle,
  RefreshCw,
  Link2,
  LogOut,
  Settings2,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  bindWorkspacePaseoCredential,
  createCodexCredential,
  createWorkspace,
  createPortalUser,
  deleteCredential,
  deletePortalUser,
  deleteWorkspace,
  getCredentialPreview,
  getWorkspaceAssetPreview,
  getWorkspaceDetail,
  listCredentials,
  listUsers,
  resolvePortalUserMapping,
  listWorkspaces,
  stopWorkspace,
  switchWorkspaceDriver,
  type PortalCredentialSummary,
  type PortalCredentialPreview,
  type PortalProfileSummary,
  type PortalUserMapping,
  type PortalWorkspaceAssetPreview,
  type PortalWorkspaceDetail,
  type PortalWorkspaceSummary,
  unbindWorkspacePaseoCredential,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarFooter,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type Language, writeStoredLanguage } from "@/lib/language";

function basenameForDisplay(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || filePath;
}

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
    add_workspace_desc: "Create a new workspace for this user.",
    start_after_create_option: "Create and start",
    docker_only_option: "Default docker only",
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
    stop_workspace: "Stop workspace",
    remove_workspace: "Delete workspace",
    remove_workspace_confirm_title: "Delete workspace?",
    remove_workspace_confirm_description: "This removes the workspace definition and its saved runtime data. Running workspaces must be stopped before deletion.",
    deleting: "Deleting...",
    stopping: "Stopping...",
    cancel: "Cancel",
    current_driver: "Current driver",
    loading_workspace: "Loading workspace...",
    workspace_state: "Workspace state",
    daemon_pairing: "Daemon pairing",
    backend: "Backend",
    live_target: "Live target",
    provisioning_title: "Provisioning",
    base_dockerfile: "Base Dockerfile",
    workspace_specs: "Workspace specs",
    generated_manifests: "Generated manifests",
    image_tags: "Image tags",
    evolution_assets: "Evolution assets",
    persistent_volumes: "Persistent volumes",
    asset_type: "Type",
    asset_name: "Name",
    asset_path: "Path / Tag",
    asset_status: "Status",
    asset_details: "Details",
    no_assets: "No asset metadata yet.",
    credentials: "Credentials",
    credentials_for_user: "User-owned credentials for this user.",
    loading_credentials: "Loading credentials...",
    no_credentials: "No credentials found.",
    add_credential: "Add credential",
    add_credential_desc: "Create a harness credential for this user.",
    credential_type: "Credential type",
    credential_label: "Credential label",
    credential_provider_name: "Provider name",
    credential_base_url: "Base URL",
    credential_api_key: "API key",
    credential_codex_option: "Codex",
    create_credential: "Create credential",
    creating_credential: "Creating credential...",
    delete_credential: "Delete credential",
    delete_credential_confirm_title: "Delete credential?",
    delete_credential_confirm_description: "This removes the credential registry entry and its generated auth files.",
    deleting_credential: "Deleting credential...",
    credential_paths: "Credential files",
    user_profile: "User profile",
    user_profile_desc: "Edit the active user information.",
    administration: "Administration",
    administration_desc: "Switch users and manage portal-level actions.",
    settings_title: "Settings",
    settings_desc: "Choose the language used across the portal.",
    danger_zone: "Danger zone",
    danger_zone_desc: "Delete this Polaris user, local credentials, and Clerk mapping.",
    workspace_danger_zone_desc: "Stop or delete this workspace.",
    danger_zone_tooltip: "This permanently deletes the Polaris user profile, user-scoped secrets, default credentials, and Clerk username mapping.",
    delete_user: "Delete user",
    delete_user_confirm_title: "Delete this user?",
    delete_user_confirm_description: "This deletes the Polaris user profile, user-scoped secrets, and Clerk username mapping. This action cannot be undone.",
    deleting_user: "Deleting user...",
    paseo_credential: "Paseo credential",
    paseo_credential_desc: "Bind an agent-auth credential to enable Paseo for this driver.",
    loading_paseo_credentials: "Loading agent credentials...",
    no_paseo_credentials: "No agent-auth credential found.",
    current_paseo_credential: "Current Paseo credential",
    bind_paseo: "Bind and start Paseo",
    binding_paseo: "Binding Paseo...",
    unbind_paseo: "Unbind Paseo",
    unbinding_paseo: "Unbinding Paseo...",
    select_submenu: "Select a workspace submenu.",
    sidebar_tier: "Free",
    menu_upgrade: "Upgrade to Pro",
    menu_account: "Account",
    menu_billing: "Billing",
    menu_logout: "Log out",
    loading_profile: "Loading profile...",
    name: "Name",
    email: "Email",
    github_account: "GitHub account",
    ssh_comment: "SSH comment",
    user_id: "User id",
    ssh_mode: "SSH mode",
    tracked_workspaces: "Tracked workspaces",
    purposes: "Purposes",
    workspace_example: "my-workspace",
    select_driver: "Select driver",
    create_suffix: "create",
    no_backend_detail: "No backend detail.",
    no_service_detail: "No service detail.",
    no_profile_detail: "No profile detail.",
    workspace_overview: "Workspace overview",
    paseo_status: "Paseo status",
    isolated_dev_env: "Isolated development environment",
    evolution_memory: "Evolution memory",
    daemon_address: "Daemon address",
    supported_harnesses: "Supported harnesses",
    status_ready: "Ready to pair",
    status_unknown: "Unknown",
    status_error: "Error",
    status_failed: "Failed",
    status_provisioning: "Provisioning",
    status_not_selected: "Not selected",
    workspace_not_started: "Not started",
    workspace_stopped: "Stopped",
    workspace_ready: "Driver ready",
    workspace_attention: "Needs attention",
    workspace_unknown: "Unknown",
    runtime_not_started: "Not started",
    runtime_stopped: "Stopped",
    runtime_starting: "Starting",
    runtime_backend_ready: "Backend ready",
    runtime_daemon_ready: "Daemon ready",
    runtime_ready_to_pair: "Ready to pair",
    runtime_ready: "Ready",
    runtime_attention: "Needs attention",
    pairing_ready: "Ready",
    pairing_unknown: "Pairing unknown",
    pairing_error: "Pairing error",
    pairing_failed: "Pairing failed",
    paseo_starting: "Starting",
    paseo_daemon_ready: "Daemon ready",
    paseo_ready_to_pair: "Ready to pair",
    paseo_attention: "Needs attention",
    paseo_unknown: "Unknown",
    none: "none",
    saving: "Saving...",
    save_profile: "Save profile",
    not_selected: "not-selected",
    unknown: "unknown",
    ready: "ready",
    settings: "Settings",
    lang_en: "EN",
    lang_zh: "中文",
    language: "Language",
    profile: "Profile",
    empty_pane: "Empty pane",
    global_error_title: "Something went wrong",
    global_error_description: "The page could not be loaded.",
    global_error_unresolved_access: "Your access could not be verified.",
    creating_account: "Creating account...",
  },
  zh: {
    app_name: "Polaris",
    select_user: "选择用户",
    switch_user: "切换用户",
    switch_workspace: "选择工作空间",
    workspaces: "工作空间",
    add_workspace: "新增工作空间",
    add_workspace_desc: "为当前用户创建一个新的工作空间。",
    start_after_create_option: "创建并启动",
    docker_only_option: "仅默认 docker",
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
    stop_workspace: "停止工作空间",
    remove_workspace: "删除工作空间",
    remove_workspace_confirm_title: "删除这个工作空间？",
    remove_workspace_confirm_description: "这会删除工作空间定义及其已保存的运行时数据。运行中的工作空间必须先停止，才能删除。",
    deleting: "删除中…",
    stopping: "停止中…",
    cancel: "取消",
    current_driver: "当前驱动",
    loading_workspace: "正在加载工作空间…",
    workspace_state: "工作空间状态",
    daemon_pairing: "配对状态",
    backend: "后端",
    live_target: "访问入口",
    provisioning_title: "准备进度",
    base_dockerfile: "基础 Dockerfile",
    workspace_specs: "工作空间规格",
    generated_manifests: "生成的清单",
    image_tags: "镜像标签",
    evolution_assets: "演进资产",
    persistent_volumes: "持久卷",
    asset_type: "类型",
    asset_name: "名称",
    asset_path: "路径 / 标签",
    asset_status: "状态",
    asset_details: "详情",
    no_assets: "暂无资产元数据。",
    credentials: "凭证",
    credentials_for_user: "该用户所属的凭证。",
    loading_credentials: "正在加载凭证…",
    no_credentials: "暂无凭证。",
    add_credential: "新增凭证",
    add_credential_desc: "为当前用户创建 agent harness 凭证。",
    credential_type: "凭证类型",
    credential_label: "Credential label",
    credential_provider_name: "提供方名称",
    credential_base_url: "Base URL",
    credential_api_key: "API Key",
    credential_codex_option: "Codex",
    create_credential: "创建凭证",
    creating_credential: "正在创建凭证…",
    delete_credential: "删除凭证",
    delete_credential_confirm_title: "删除这个凭证？",
    delete_credential_confirm_description: "这会删除凭证注册文件以及生成出的鉴权文件。",
    deleting_credential: "正在删除凭证…",
    credential_paths: "凭证文件",
    user_profile: "用户资料",
    user_profile_desc: "编辑当前用户信息。",
    administration: "管理",
    administration_desc: "切换用户并管理门户级操作。",
    settings_title: "设置",
    settings_desc: "选择整个门户使用的语言。",
    danger_zone: "危险操作",
    danger_zone_desc: "删除这个 Polaris 用户、本地凭据和 Clerk 映射。",
    workspace_danger_zone_desc: "停止或删除这个工作空间。",
    danger_zone_tooltip: "这会永久删除 Polaris 用户资料、用户级 secrets、默认凭据，以及 Clerk 用户名映射。",
    delete_user: "删除用户",
    delete_user_confirm_title: "删除这个用户？",
    delete_user_confirm_description: "这会删除 Polaris 用户资料、用户级 secrets，以及 Clerk 用户名映射。此操作不可恢复。",
    deleting_user: "正在删除用户…",
    paseo_credential: "Paseo 凭证",
    paseo_credential_desc: "为当前 driver 绑定一个 agent-auth credential，并启用 Paseo。",
    loading_paseo_credentials: "正在加载 agent 凭证…",
    no_paseo_credentials: "没有可用的 agent-auth credential。",
    current_paseo_credential: "当前 Paseo 凭证",
    bind_paseo: "绑定并启动 Paseo",
    binding_paseo: "正在绑定 Paseo…",
    unbind_paseo: "解除 Paseo 绑定",
    unbinding_paseo: "正在解除 Paseo 绑定…",
    select_submenu: "请选择工作空间子页面。",
    sidebar_tier: "免费版",
    menu_upgrade: "升级到 Pro",
    menu_account: "账号",
    menu_billing: "账单",
    menu_logout: "退出登录",
    loading_profile: "正在加载用户资料…",
    name: "名称",
    email: "邮箱",
    github_account: "GitHub 账号",
    ssh_comment: "SSH 注释",
    user_id: "用户 ID",
    ssh_mode: "SSH 模式",
    tracked_workspaces: "已跟踪工作空间",
    purposes: "用途",
    workspace_example: "my-workspace",
    select_driver: "选择驱动",
    create_suffix: "创建",
    no_backend_detail: "暂无后端详情。",
    no_service_detail: "暂无服务详情。",
    no_profile_detail: "暂无用户配置详情。",
    workspace_overview: "工作空间概览",
    paseo_status: "Paseo 状态",
    isolated_dev_env: "隔离开发环境",
    evolution_memory: "演进记忆",
    daemon_address: "守护进程地址",
    supported_harnesses: "支持的协作者",
    status_ready: "可配对",
    status_unknown: "未知",
    status_error: "错误",
    status_failed: "失败",
    status_provisioning: "准备中",
    status_not_selected: "未选中",
    workspace_not_started: "未启动",
    workspace_stopped: "已停止",
    workspace_ready: "驱动就绪",
    workspace_attention: "需要处理",
    workspace_unknown: "未知",
    runtime_not_started: "未启动",
    runtime_stopped: "已停止",
    runtime_starting: "启动中",
    runtime_backend_ready: "后端就绪",
    runtime_daemon_ready: "守护进程就绪",
    runtime_ready_to_pair: "可配对",
    runtime_ready: "就绪",
    runtime_attention: "需要处理",
    pairing_ready: "就绪",
    pairing_unknown: "配对状态未知",
    pairing_error: "配对异常",
    pairing_failed: "配对失败",
    paseo_starting: "启动中",
    paseo_daemon_ready: "守护进程就绪",
    paseo_ready_to_pair: "可配对",
    paseo_attention: "需要处理",
    paseo_unknown: "未知",
    none: "无",
    saving: "保存中…",
    save_profile: "保存资料",
    not_selected: "未选中",
    unknown: "未知",
    ready: "就绪",
    settings: "设置",
    lang_en: "EN",
    lang_zh: "中文",
    language: "语言",
    profile: "资料",
    empty_pane: "空白页",
    global_error_title: "出错了",
    global_error_description: "页面无法加载。",
    global_error_unresolved_access: "无法验证当前访问权限。",
    creating_account: "正在创建账号…",
  },
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

function useLanguage(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("Language context is not available");
  }
  return context;
}

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return <div className="p-6 text-sm text-destructive">App error.</div>;
    }
    return this.props.children;
  }
}

function portalSignInUrl(): string {
  if (typeof window === "undefined") {
    return "/sign-in";
  }
  const target = new URL("/sign-in", window.location.origin);
  target.searchParams.set("redirect_url", window.location.href);
  return target.pathname + target.search;
}

const REGISTRATION_INTENT_KEY = "polaris-pending-registration";
const REGISTRATION_QUERY_KEY = "registered";

function setRegistrationIntent(active: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  if (active) {
    window.sessionStorage.setItem(REGISTRATION_INTENT_KEY, "1");
    return;
  }
  window.sessionStorage.removeItem(REGISTRATION_INTENT_KEY);
}

function hasRegistrationIntent(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.sessionStorage.getItem(REGISTRATION_INTENT_KEY) === "1";
}

function hasRegistrationQuery(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get(REGISTRATION_QUERY_KEY) === "1";
}

function clearRegistrationQuery(
  navigate: ReturnType<typeof useNavigate>,
  pathname: string,
  search: string,
): void {
  const params = new URLSearchParams(search);
  if (!params.has(REGISTRATION_QUERY_KEY)) {
    return;
  }
  params.delete(REGISTRATION_QUERY_KEY);
  const nextSearch = params.toString();
  navigate(`${pathname}${nextSearch ? `?${nextSearch}` : ""}`, { replace: true });
}

function AuthGate(props: { children: ReactNode }) {
  const { isLoaded, userId } = useAuth();

  useEffect(() => {
    if (!isLoaded || userId) {
      return;
    }
    window.location.assign(portalSignInUrl());
  }, [isLoaded, userId]);

  if (!isLoaded || !userId) {
    return <div className="p-6 text-sm text-muted-foreground">Redirecting to sign in...</div>;
  }
  return <>{props.children}</>;
}

function normalizeClerkUsername(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function useCurrentUserMapping() {
  const { user } = useUser();
  const clerkUsername = normalizeClerkUsername(
    user?.username
      ?? user?.primaryEmailAddress?.emailAddress?.split("@")[0]
      ?? null,
  );
  const { data, error, loading } = useAsyncValue<PortalUserMapping | null>(
    () => clerkUsername ? resolvePortalUserMapping(clerkUsername) : Promise.resolve(null),
    [clerkUsername],
  );
  return { clerkUsername, mapping: data, mappingError: error, mappingLoading: loading };
}

function SignInPage() {
  const { isLoaded, userId } = useAuth();
  const { language } = useLanguage();
  useEffect(() => {
    setRegistrationIntent(false);
  }, []);
  if (isLoaded && userId) {
    return <Navigate to="/" replace />;
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <SignIn
        key={`sign-in-${language}`}
        path="/sign-in"
        routing="path"
        signUpUrl="/sign-up"
      />
    </div>
  );
}

function SignUpPage() {
  const { isLoaded, userId } = useAuth();
  const navigate = useNavigate();
  const { language } = useLanguage();

  useEffect(() => {
    setRegistrationIntent(true);
  }, []);

  useEffect(() => {
    if (isLoaded && userId) {
      navigate("/?registered=1", { replace: true });
    }
  }, [isLoaded, navigate, userId]);

  if (isLoaded && userId) {
    return <div className="p-6 text-sm text-muted-foreground">Finishing registration...</div>;
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <SignUp
        key={`sign-up-${language}`}
        path="/sign-up"
        routing="path"
        signInUrl="/sign-in"
      />
    </div>
  );
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

function translatePairingState(
  value: string | null | undefined,
  t: (key: string) => string,
): string {
  if (!value) {
    return t("pairing_unknown");
  }
  switch (value) {
    case "ok":
    case "ready":
      return t("pairing_ready");
    case "unknown":
      return t("pairing_unknown");
    case "error":
    case "warning":
      return t("pairing_error");
    case "failed":
      return t("pairing_failed");
    default:
      return value;
  }
}

function translateWorkspaceRuntimeState(
  value: string | null | undefined,
  t: (key: string) => string,
): string {
  if (!value) {
    return t("workspace_unknown");
  }
  switch (value) {
    case "not-applied":
      return t("workspace_not_started");
    case "saved":
      return t("workspace_stopped");
    case "ready":
      return t("workspace_ready");
    case "degraded":
      return t("workspace_attention");
    default:
      return value;
  }
}

function translatePaseoState(
  daemon: PortalWorkspaceDetail["status"] extends infer T
    ? T extends { daemon?: infer D }
      ? D | undefined
      : undefined
    : undefined,
  t: (key: string) => string,
): string {
  const pairingState = daemon?.pairing?.state;
  const managerState = daemon?.manager?.state;
  if (pairingState === "ok" || pairingState === "ready") {
    return t("paseo_ready_to_pair");
  }
  if (managerState === "ok" || managerState === "ready") {
    return t("paseo_daemon_ready");
  }
  if (managerState === "missing" || managerState === "unknown" || !managerState) {
    return t("paseo_starting");
  }
  if (managerState === "error" || managerState === "failed" || managerState === "warning") {
    return t("paseo_attention");
  }
  return t("paseo_unknown");
}

function extractOfferFragment(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const fragment = "#offer=";
  const index = trimmed.indexOf(fragment);
  if (index === -1) {
    return null;
  }
  const encoded = trimmed.slice(index + fragment.length).trim();
  return encoded || null;
}

function configuredPaseoAppBaseUrl(): string | null {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const configured = env?.VITE_PASEO_APP_BASE_URL?.trim();
  if (configured) {
    if (typeof window === "undefined") {
      return configured.replace(/\/$/, "");
    }
    const current = new URL(window.location.href);
    const url = new URL(configured, current.href);
    if (current.protocol === "https:" && url.protocol === "http:" && url.host === current.host) {
      url.protocol = "https:";
    }
    return url.toString().replace(/\/$/, "");
  }
  if (typeof window === "undefined") {
    return null;
  }
  const url = new URL(window.location.href);
  url.pathname = "/paseo/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizePaseoPortalUrl(input: string | null | undefined): string | null {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const offer = extractOfferFragment(trimmed);
  if (!offer) {
    return trimmed;
  }
  const appBaseUrl = configuredPaseoAppBaseUrl();
  if (!appBaseUrl) {
    return trimmed;
  }
  return `${appBaseUrl}/#offer=${offer}`;
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

type AssetRow = {
  name: string;
  path: string;
  displayPath?: string;
  detail?: string;
  detailLines?: string[];
  status?: string;
  previewPath?: string;
  previewScope?: "credential" | "workspace";
  previewOpen?: boolean;
};

type AssetSection = {
  label: string;
  labelLines?: string[];
  rows: AssetRow[];
  action?: ReactNode;
};

function WorkspaceAssetTable(props: {
  t: (key: string) => string;
  sections: AssetSection[];
  emptyLabel: string;
  userId?: string;
  workspaceName?: string;
  hideDetailsColumn?: boolean;
}) {
  const visibleSections = props.sections.filter((section) => section.rows.length > 0);
  const hasStatusOrNotes = visibleSections.some((section) =>
    section.rows.some((row) => row.status),
  );
  const hasActions = visibleSections.some((section) => Boolean(section.action));
  const showDetailsColumn = !hasStatusOrNotes && !props.hideDetailsColumn;
  if (visibleSections.length === 0) {
    return <p className="text-sm text-muted-foreground">{props.emptyLabel}</p>;
  }

  return (
    <div className="overflow-hidden rounded-[1.25rem] border border-border bg-background shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] table-auto text-sm">
          <thead className="bg-muted/30 text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
            <tr className="border-b border-border/70">
              <th className="w-0 px-4 py-3 text-right font-medium whitespace-nowrap">{props.t("asset_type")}</th>
              {hasActions ? (
                <th className="w-0 px-4 py-3 text-right font-medium whitespace-nowrap">Action</th>
              ) : null}
              <th className="w-0 px-4 py-3 text-right font-medium whitespace-nowrap">{props.t("asset_name")}</th>
              <th className="w-full px-4 py-3 font-medium">{props.t("asset_path")}</th>
              {hasStatusOrNotes ? (
                <th className="w-0 px-4 py-3 text-right font-medium whitespace-nowrap">{props.t("asset_status")}</th>
              ) : showDetailsColumn ? (
                <th className="w-0 px-4 py-3 text-right font-medium whitespace-nowrap">{props.t("asset_details")}</th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {visibleSections.map((section) =>
              section.rows.map((row, index) => (
                <tr key={`${section.label}:${row.name}:${row.path}`} className="align-middle">
                  {index === 0 && (
                    <td className="w-0 whitespace-nowrap px-4 py-4 align-middle text-right text-muted-foreground" rowSpan={section.rows.length}>
                      {section.labelLines && section.labelLines.length === section.rows.length ? (
                        <div
                          className="grid min-w-[10rem] whitespace-normal text-right"
                          style={{ gridTemplateRows: `repeat(${section.rows.length}, minmax(0, 1fr))` }}
                        >
                          {section.labelLines.map((line, lineIndex) => (
                            <div
                              key={`${section.label}:${line}`}
                              className={[
                                "flex items-center justify-end py-4",
                                lineIndex > 0 ? "border-t border-border/70" : "",
                              ].join(" ")}
                            >
                              {line}
                            </div>
                          ))}
                        </div>
                      ) : section.labelLines && section.labelLines.length > 1 ? (
                        <div className="grid min-w-[10rem] gap-2 whitespace-normal text-right">
                          {section.labelLines.map((line, lineIndex) => (
                            <React.Fragment key={`${section.label}:${line}`}>
                              {lineIndex > 0 ? <div className="h-px w-full bg-border/70" /> : null}
                              <div>{line}</div>
                            </React.Fragment>
                          ))}
                        </div>
                      ) : (
                        section.label
                      )}
                    </td>
                  )}
                  {hasActions ? (
                    index === 0 ? (
                      <td
                        className="w-0 whitespace-nowrap px-4 py-4 align-middle text-right"
                        rowSpan={section.rows.length}
                      >
                        {section.action ?? <span className="text-muted-foreground">-</span>}
                      </td>
                    ) : null
                  ) : null}
                  <td className="w-0 whitespace-nowrap px-4 py-4 text-right font-medium">{row.name}</td>
                  <td className="w-full px-4 py-4">
                    <CredentialPathCell
                      path={row.displayPath ?? row.path}
                      userId={props.userId}
                      previewPath={row.previewPath}
                      previewScope={row.previewScope}
                      workspaceName={props.workspaceName}
                    />
                  </td>
                  {hasStatusOrNotes ? (
                    <td className="w-0 whitespace-nowrap px-4 py-4 text-right text-muted-foreground">
                      {row.status ?? "-"}
                    </td>
                  ) : showDetailsColumn ? (
                    <td className="w-0 whitespace-nowrap px-4 py-4 text-right text-muted-foreground">
                      {row.detailLines && row.detailLines.length > 0 ? (
                        <div className="grid max-w-[18rem] gap-1 text-sm whitespace-normal">
                          {row.detailLines.map((line) => (
                            <span key={line} className="block break-words" title={line}>
                              {line}
                            </span>
                          ))}
                        </div>
                      ) : row.detail ? (
                        <span className="block max-w-[18rem] truncate text-sm" title={row.detail}>
                          {row.detail}
                        </span>
                      ) : "-"}
                    </td>
                  ) : null}
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
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
  return (
    <SidebarProvider defaultOpen>
      <PortalShellLayout users={props.users}>{props.children}</PortalShellLayout>
    </SidebarProvider>
  );
}

function PortalShellLayout(props: {
  children: ReactNode;
  users: PortalProfileSummary[];
}) {
  const { t } = useLanguage();
  const clerk = useClerk();
  const { mapping } = useCurrentUserMapping();
  const location = useLocation();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const isAdmin = mapping?.role === "admin";
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
  const pathParts = location.pathname.split("/").filter(Boolean);
  const currentWorkspaceName = pathParts[3] ? decodeURIComponent(pathParts[3]) : "";
  const currentWorkspacePane = pathParts[4] ?? "";
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<string[]>([]);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [startAfterCreate, setStartAfterCreate] = useState(true);
  const [defaultDockerOnly, setDefaultDockerOnly] = useState(true);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [createWorkspaceError, setCreateWorkspaceError] = useState<string | null>(null);
  const [createWorkspaceProgress, setCreateWorkspaceProgress] = useState(12);

  function closeMobileSidebar(): void {
    if (isMobile) {
      setOpenMobile(false);
    }
  }

  function handleSidebarNavigate(): void {
    closeMobileSidebar();
  }

  function workspaceLink(workspaceName: string): string {
    return `/users/${encodeURIComponent(activeUserId)}/workspaces/${encodeURIComponent(workspaceName)}`;
  }

  function workspacePaneLink(workspaceName: string, pane?: string): string {
    return pane ? `${workspaceLink(workspaceName)}/${pane}` : workspaceLink(workspaceName);
  }

  function userWorkspaceIndexLink(): string {
    return `/users/${encodeURIComponent(activeUserId)}/workspaces`;
  }

  useEffect(() => {
    if (!creatingWorkspace) {
      setCreateWorkspaceProgress(12);
      return;
    }
    const timer = window.setInterval(() => {
      setCreateWorkspaceProgress((current) => Math.min(current + 11, 88));
    }, 350);
    return () => {
      window.clearInterval(timer);
    };
  }, [creatingWorkspace]);

  async function handleCreateWorkspace(event?: React.FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    const trimmedName = newWorkspaceName.trim();
    if (!activeUserId || !trimmedName || creatingWorkspace) {
      return;
    }
    setCreatingWorkspace(true);
    setCreateWorkspaceError(null);
    try {
      await createWorkspace(activeUserId, trimmedName, {
        defaultDockerOnly,
        startAfterCreate,
      });
      setCreateWorkspaceProgress(100);
      setCreateWorkspaceOpen(false);
      setNewWorkspaceName("");
      setStartAfterCreate(true);
      setDefaultDockerOnly(true);
      window.location.assign(
        `/users/${encodeURIComponent(activeUserId)}/workspaces/${encodeURIComponent(trimmedName)}`,
      );
    } catch (cause: unknown) {
      setCreateWorkspaceError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreatingWorkspace(false);
    }
  }

  const activeUserInitial = (activeUser?.name || activeUser?.id || "?")
    .trim()
    .charAt(0)
    .toUpperCase();
  const activeUserName = activeUser?.name || activeUser?.id || t("switch_user");
  const currentPaneTitle = location.pathname.includes("/admin")
    ? t("administration")
    : currentWorkspacePane === "paseo"
    ? t("paseo_status")
    : currentWorkspacePane === "dev-env"
      ? t("isolated_dev_env")
      : currentWorkspacePane === "memory"
        ? t("evolution_memory")
        : location.pathname.includes("/workspaces/") && currentWorkspacePane === ""
            ? currentWorkspaceName || t("empty_pane")
            : location.pathname.includes("/workspaces/")
              ? t("workspace_overview")
            : t("app_name");

  return (
    <>
      <Sidebar collapsible="offcanvas">
        <SidebarHeader className="p-4">
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
              P
            </div>
            <div className="grid min-w-0 gap-0.5">
              <div className="truncate text-sm font-medium leading-none">{t("app_name")}</div>
              <div className="truncate text-xs text-muted-foreground">{t("sidebar_tier")}</div>
            </div>
          </div>
        </SidebarHeader>
        <SidebarContent className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <SidebarGroup>
              <SidebarGroupLabel>
                {t("workspaces")}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <AlertDialog
                      open={createWorkspaceOpen}
                      onOpenChange={(open) => {
                        setCreateWorkspaceOpen(open);
                        if (!open) {
                          setNewWorkspaceName("");
                          setStartAfterCreate(true);
                          setDefaultDockerOnly(true);
                          setCreateWorkspaceError(null);
                          setCreatingWorkspace(false);
                        }
                      }}
                    >
                      <AlertDialogTrigger asChild>
                        <SidebarMenuButton>
                          <PlusCircle />
                          <span>{t("add_workspace")}</span>
                        </SidebarMenuButton>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t("add_workspace")}</AlertDialogTitle>
                          <AlertDialogDescription>
                            {t("add_workspace_desc")}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <form className="grid gap-4" onSubmit={(event) => void handleCreateWorkspace(event)}>
                          <div className="grid gap-2">
                            <Label htmlFor="new-workspace-name">{t("workspace_name")}</Label>
                            <Input
                              id="new-workspace-name"
                              value={newWorkspaceName}
                              onChange={(event) => setNewWorkspaceName(event.target.value)}
                              placeholder={t("workspace_example")}
                              autoComplete="off"
                              disabled={creatingWorkspace}
                            />
                          </div>
                          <label className="flex items-center gap-3 text-sm text-muted-foreground">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-border"
                              checked={startAfterCreate}
                              onChange={(event) => setStartAfterCreate(event.target.checked)}
                              disabled={creatingWorkspace}
                            />
                            <span>{t("start_after_create_option")}</span>
                          </label>
                          <label className="flex items-center gap-3 text-sm text-muted-foreground">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-border"
                              checked={defaultDockerOnly}
                              onChange={(event) => setDefaultDockerOnly(event.target.checked)}
                              disabled={creatingWorkspace}
                            />
                            <span>{t("docker_only_option")}</span>
                          </label>
                          {creatingWorkspace && (
                            <div className="grid gap-2">
                              <div className="flex justify-between text-sm text-muted-foreground">
                                <span>{t("provisioning")}</span>
                                <span>{createWorkspaceProgress}%</span>
                              </div>
                              <Progress value={createWorkspaceProgress} />
                            </div>
                          )}
                          {createWorkspaceError && (
                            <p className="text-sm text-destructive">{createWorkspaceError}</p>
                          )}
                          <AlertDialogFooter>
                            <AlertDialogCancel disabled={creatingWorkspace}>
                              {t("cancel")}
                            </AlertDialogCancel>
                            <Button type="submit" disabled={creatingWorkspace || !newWorkspaceName.trim()}>
                              {creatingWorkspace ? t("provisioning") : t("create_workspace")}
                            </Button>
                          </AlertDialogFooter>
                        </form>
                      </AlertDialogContent>
                    </AlertDialog>
                  </SidebarMenuItem>
                  {sidebarWorkspacesLoading && (
                    <div className="px-2 py-3 text-sm text-muted-foreground">
                      {t("loading_workspaces")}
                    </div>
                  )}
                  {sidebarWorkspaces?.map((workspace) => {
                    const active = location.pathname.includes(
                      `/workspaces/${encodeURIComponent(workspace.name)}`,
                    );
                    const expanded = expandedWorkspaces.includes(workspace.name);
                    return (
                      <SidebarMenuItem key={workspace.name}>
                        <SidebarMenuButton asChild isActive={active} tooltip={workspace.name}>
                          <Link to={workspaceLink(workspace.name)} onClick={handleSidebarNavigate}>
                            <FolderKanban />
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">{workspace.name}</span>
                            </span>
                          </Link>
                        </SidebarMenuButton>
                        <SidebarMenuAction
                          onClick={() => {
                            setExpandedWorkspaces((current) =>
                              current.includes(workspace.name)
                                ? current.filter((value) => value !== workspace.name)
                                : [...current, workspace.name],
                            );
                          }}
                          aria-label={expanded ? `Collapse ${workspace.name}` : `Expand ${workspace.name}`}
                        >
                          <ChevronRight className={[
                            "h-4 w-4 transition-transform",
                            expanded ? "rotate-90" : "",
                          ].join(" ")} />
                        </SidebarMenuAction>
                        {expanded && (
                          <SidebarMenuSub>
                            <SidebarMenuSubItem>
                              <SidebarMenuSubButton asChild>
                                <Link to={workspacePaneLink(workspace.name, "paseo")} onClick={handleSidebarNavigate}>
                                  {t("paseo_status")}
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                            <SidebarMenuSubItem>
                              <SidebarMenuSubButton asChild>
                                <Link to={workspacePaneLink(workspace.name, "dev-env")} onClick={handleSidebarNavigate}>
                                  {t("isolated_dev_env")}
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                            <SidebarMenuSubItem>
                              <SidebarMenuSubButton asChild>
                                <Link to={workspacePaneLink(workspace.name, "memory")} onClick={handleSidebarNavigate}>
                                  {t("evolution_memory")}
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          </SidebarMenuSub>
                        )}
                      </SidebarMenuItem>
                    );
                  })}
                  {!sidebarWorkspacesLoading && sidebarWorkspaces?.length === 0 && (
                    <div className="px-2 py-3 text-sm text-muted-foreground">
                      {t("no_workspaces")}
                    </div>
                  )}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </div>
          {activeUser && isAdmin && (
            <SidebarGroup className="shrink-0 pt-4">
              <SidebarGroupLabel>
                {t("administration")}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location.pathname.includes("/admin")}>
                      <Link to={`/users/${encodeURIComponent(activeUser.id)}/admin`}>
                        <CircleUser />
                        <span>{t("switch_user")}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
        </SidebarContent>
        {activeUser && (
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <SidebarMenuButton
                      size="lg"
                      className="data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground"
                    >
                      <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                        {activeUserInitial}
                      </div>
                      <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                        <span className="truncate font-medium">
                          {activeUserName}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {activeUser.email}
                        </span>
                      </div>
                      <ChevronRight className="ml-auto h-4 w-4" />
                    </SidebarMenuButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    side={isMobile ? "top" : "right"}
                    align={isMobile ? "start" : "end"}
                    sideOffset={8}
                    collisionPadding={16}
                    className="w-64 max-w-[calc(100vw-2rem)]"
                  >
                    <DropdownMenuLabel className="flex items-center gap-2">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                        {activeUserInitial}
                      </div>
                      <div className="grid min-w-0 gap-0.5">
                        <div className="truncate">{activeUserName}</div>
                        <div className="truncate text-xs font-normal text-muted-foreground">
                          {activeUser.email}
                        </div>
                      </div>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled>
                      <Sparkles className="mr-2 h-4 w-4" />
                      {t("menu_upgrade")}
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link to={`/users/${encodeURIComponent(activeUser.id)}/profile`}>
                        <CircleUser className="mr-2 h-4 w-4" />
                        {t("menu_account")}
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled>
                      <CreditCard className="mr-2 h-4 w-4" />
                      {t("menu_billing")}
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link to={`/users/${encodeURIComponent(activeUser.id)}/settings`}>
                        <Settings2 className="mr-2 h-4 w-4" />
                        {t("settings")}
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => {
                        void clerk.signOut({ redirectUrl: "/sign-in" });
                      }}
                    >
                      <LogOut className="mr-2 h-4 w-4" />
                      {t("menu_logout")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        )}
      </Sidebar>
      <SidebarInset className="overflow-hidden">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b bg-background px-4">
          <SidebarTrigger />
          <div className="min-w-0 flex-1 truncate text-sm font-semibold">
            {currentPaneTitle}
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6">
          {props.children}
        </div>
      </SidebarInset>
    </>
  );
}

function GlobalErrorPage(props: {
  title: string;
  description: string;
  detail?: string | null;
}) {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background px-4 py-8">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>{props.title}</CardTitle>
          <CardDescription>{props.description}</CardDescription>
        </CardHeader>
        {props.detail && (
          <CardContent>
            <p className="text-sm text-destructive">{props.detail}</p>
          </CardContent>
        )}
      </Card>
    </div>
  );
}

function OverviewPage() {
  const { t } = useLanguage();
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useUser();
  const {
    clerkUsername,
    mapping,
    mappingError,
    mappingLoading,
  } = useCurrentUserMapping();
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const registrationStartedRef = useRef(false);

  const explicitMappedUserId = mapping?.polarisUserId ?? null;

  useEffect(() => {
    if (
      (!hasRegistrationIntent() && !hasRegistrationQuery(location.search))
      || !clerkUsername
      || mappingLoading
      || Boolean(mappingError)
      || Boolean(explicitMappedUserId)
      || registrationStartedRef.current
    ) {
      return;
    }

    registrationStartedRef.current = true;
    setRegistering(true);
    setRegistrationError(null);
    void createPortalUser({
      userProfileId: clerkUsername,
      clerkUsername,
      ...(user?.primaryEmailAddress?.emailAddress?.trim()
        ? { email: user.primaryEmailAddress.emailAddress.trim() }
        : {}),
      name: user?.fullName?.trim() || user?.username?.trim() || clerkUsername,
      role: "user",
      plan: "free",
    })
      .then((created) => {
        setRegistrationIntent(false);
        clearRegistrationQuery(navigate, location.pathname, location.search);
        navigate(`/users/${encodeURIComponent(created.id)}/workspaces`, { replace: true });
      })
      .catch((cause: unknown) => {
        registrationStartedRef.current = false;
        setRegistrationIntent(false);
        clearRegistrationQuery(navigate, location.pathname, location.search);
        setRegistrationError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        setRegistering(false);
      });
  }, [
    clerkUsername,
    explicitMappedUserId,
    location.pathname,
    location.search,
    mappingError,
    mappingLoading,
    navigate,
    user,
  ]);

  if (explicitMappedUserId) {
    return <Navigate to={`/users/${encodeURIComponent(explicitMappedUserId)}/workspaces`} replace />;
  }

  return (
    <GlobalErrorPage
      title={t("global_error_title")}
      description={t("global_error_description")}
      detail={
        registering
          ? t("creating_account")
          : mappingError
            || registrationError
            || (!mappingLoading && !explicitMappedUserId
              ? t("global_error_unresolved_access")
              : null)
      }
    />
  );
}

function WorkspaceIndexPage() {
  const { data: users } = useAsyncValue(listUsers, []);

  return (
    <PortalShell users={users ?? []}>
      <div className="min-h-[40dvh]" />
    </PortalShell>
  );
}

function AdminPage() {
  const { t } = useLanguage();
  const { userId = "" } = useParams();
  const navigate = useNavigate();
  const { data: users } = useAsyncValue(listUsers, []);
  const { mapping } = useCurrentUserMapping();

  if (mapping?.role !== "admin") {
    return <Navigate to={`/users/${encodeURIComponent(userId)}/workspaces`} replace />;
  }

  return (
    <PortalShell users={users ?? []}>
      <div className="grid w-full gap-6">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t("administration")}</div>
          <div className="text-sm text-muted-foreground">{t("administration_desc")}</div>
        </div>
        <Separator />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium">{t("switch_user")}</div>
            <div className="text-sm text-muted-foreground">{t("administration_desc")}</div>
          </div>
          <div className="w-full min-w-0 sm:w-[18rem]">
            <Select
              value={userId}
              onValueChange={(value) => {
                if (!value) {
                  return;
                }
                navigate(`/users/${encodeURIComponent(value)}/admin`);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder={t("switch_user")} />
              </SelectTrigger>
              <SelectContent>
                {(users ?? []).map((user) => (
                  <SelectItem key={user.id} value={user.id}>
                    {user.name || user.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </PortalShell>
  );
}

function EmptyPane(props: { title: string; description: string }) {
  return (
    <div className="flex min-h-[40dvh] w-full items-center justify-center">
      <div className="grid gap-2 text-center">
        <div className="text-lg font-medium">{props.title}</div>
        <div className="text-sm text-muted-foreground">{props.description}</div>
      </div>
    </div>
  );
}

function WorkspaceDetailPage() {
  const { t } = useLanguage();
  const { userId = "", workspaceName = "" } = useParams();
  const location = useLocation();
  const { data: users } = useAsyncValue(listUsers, []);
  const { data, error, loading } = useAsyncValue(
    () => getWorkspaceDetail(userId, workspaceName),
    [userId, workspaceName],
  );
  const {
    data: credentials,
    error: credentialsError,
    loading: credentialsLoading,
  } = useAsyncValue(
    () => listCredentials(userId),
    [userId],
  );
  const [driver, setDriver] = useState("");
  const [paseoCredentialId, setPaseoCredentialId] = useState("");
  const [switching, setSwitching] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [bindingPaseo, setBindingPaseo] = useState(false);
  const [unbindingPaseo, setUnbindingPaseo] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const pathParts = location.pathname.split("/").filter(Boolean);
  const currentPane = pathParts[4] ?? "";
  const assets = data?.status?.assets;
  const agentCredentials = (credentials ?? []).filter((credential) =>
    credential.purposes.includes("agent-auth")
  );
  const rawCurrentPaseoCredentialId = data?.credentialBindings.find((binding) =>
    binding.purpose === "agent-auth"
  )?.credentialId ?? "";
  const currentPaseoCredentialId = agentCredentials.some((credential) =>
    credential.id === rawCurrentPaseoCredentialId
  )
    ? rawCurrentPaseoCredentialId
    : "";
  const embeddedPortalUrl = normalizePaseoPortalUrl(
    data?.liveTarget ?? data?.status?.paseo?.liveTarget,
  );
  const developmentSections: AssetSection[] = assets
    ? [
        {
          label: t("base_dockerfile"),
          rows: assets.dockerfile && assets.dockerfile.exists !== false
            ? [{
                name: assets.dockerfile.file,
                path: assets.dockerfile.path,
                displayPath: trimUserAssetPath(assets.dockerfile.path, userId),
                previewPath: assets.dockerfile.path,
                previewScope: "workspace",
              }]
            : [],
        },
        {
          label: t("workspace_specs"),
          rows: (assets.specs ?? [])
            .filter((item) => item.exists !== false)
            .map((item) => ({
              name: `${item.driver} · ${item.file}`,
              path: item.path,
              displayPath: trimUserAssetPath(item.path, userId),
              previewPath: item.path,
              previewScope: "workspace",
            })),
        },
        {
          label: t("generated_manifests"),
          rows: (assets.generatedManifests ?? [])
            .filter((item) => item.exists !== false)
            .map((item) => ({
              name: `${item.driver} · ${item.file}`,
              path: item.path,
              displayPath: trimUserAssetPath(item.path, userId),
              previewPath: item.path,
              previewScope: "workspace",
            })),
        },
        {
          label: t("image_tags"),
          rows: (assets.imageTags ?? []).map((item) => ({
            name: item.name,
            path: item.tag,
          })),
        },
        {
          label: t("persistent_volumes"),
          rows: (assets.persistentVolumes ?? []).map((item) => ({
            name: item.name,
            path: item.mountRoot,
            detail: [item.sourceRef ?? item.sourceKind, ...item.durablePaths].join(" | "),
          })),
        },
      ]
    : [];
  const evolutionSections: AssetSection[] = assets?.evolutionFiles
    ? [
        {
          label: t("evolution_assets"),
          rows: assets.evolutionFiles
            .filter((item) => item.exists !== false)
            .map((item) => ({
              name: `${item.scope} · ${item.name}`,
              path: item.path,
              displayPath: item.path.startsWith(`config/users/${userId}/`)
                ? trimUserAssetPath(item.path, userId)
                : item.path,
              previewPath: item.path.startsWith(`config/users/${userId}/`) && item.exists !== false
                ? item.path
                : undefined,
              previewScope: "workspace",
            })),
        },
      ]
    : [];

  useEffect(() => {
    if (data?.selectedDriver) {
      setDriver(driverLabel(data.selectedDriver));
    }
  }, [data]);

  useEffect(() => {
    if (currentPaseoCredentialId) {
      setPaseoCredentialId(currentPaseoCredentialId);
      return;
    }
    if (!paseoCredentialId && agentCredentials.length > 0) {
      setPaseoCredentialId(agentCredentials[0]?.id ?? "");
    }
  }, [agentCredentials, currentPaseoCredentialId, paseoCredentialId]);

  async function handleSwitch(): Promise<void> {
    if (!driver) {
      return;
    }
    setActionError(null);
    setSwitching(true);
    try {
      await switchWorkspaceDriver(userId, workspaceName, driver);
      window.location.reload();
    } finally {
      setSwitching(false);
    }
  }

  async function handleDelete(): Promise<void> {
    setActionError(null);
    setDeleting(true);
    try {
      await deleteWorkspace(userId, workspaceName);
      window.location.assign(`/users/${encodeURIComponent(userId)}/workspaces`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  }

  async function handleStop(): Promise<void> {
    setActionError(null);
    setStopping(true);
    try {
      await stopWorkspace(userId, workspaceName);
      window.location.reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setStopping(false);
    }
  }

  async function handleBindPaseo(): Promise<void> {
    if (!paseoCredentialId || !driver) {
      return;
    }
    setActionError(null);
    setBindingPaseo(true);
    try {
      await bindWorkspacePaseoCredential(userId, workspaceName, {
        credentialId: paseoCredentialId,
        driver,
      });
      window.location.reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBindingPaseo(false);
    }
  }

  async function handleUnbindPaseo(): Promise<void> {
    if (!driver) {
      return;
    }
    setActionError(null);
    setUnbindingPaseo(true);
    try {
      await unbindWorkspacePaseoCredential(userId, workspaceName, { driver });
      window.location.reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setUnbindingPaseo(false);
    }
  }

  function renderControlsCard(): ReactNode {
    return (
      <div className="grid gap-6">
        {data?.progress && (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium">{t("provisioning_title")}</div>
                <div className="text-sm text-muted-foreground">{data.progress.phase}</div>
              </div>
              <div className="w-full min-w-0 sm:w-[18rem]">
                <div className="mb-2 flex justify-between text-sm text-muted-foreground">
                  <span>{t("provisioning")}</span>
                  <span>{data.progress.percent}%</span>
                </div>
                <Progress value={data.progress.percent} />
              </div>
            </div>
            <Separator />
          </>
        )}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium">{t("switch_driver")}</div>
            <div className="text-sm text-muted-foreground">{t("switch_driver_desc")}</div>
          </div>
          <div className="flex w-full min-w-0 flex-wrap items-end gap-3 sm:w-auto sm:justify-end">
            <div className="w-full min-w-0 sm:w-[18rem]">
              <Select value={driver} onValueChange={setDriver}>
                <SelectTrigger>
                  <SelectValue placeholder={t("select_driver")} />
                </SelectTrigger>
                <SelectContent>
                  {(data?.availableDrivers ?? []).map((item) => {
                    const label = driverLabel(item);
                    return (
                      <SelectItem key={label} value={label}>
                        {item.available ? label : `${label} (${t("create_suffix")})`}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => void handleSwitch()} disabled={switching || !driver}>
              <RefreshCw className="h-4 w-4" />
              {switching ? t("switching") : t("switch_workspace_action")}
            </Button>
          </div>
        </div>
        <Separator />
        <div className="grid gap-3">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t("paseo_credential")}</div>
              <div className="text-sm text-muted-foreground">{t("paseo_credential_desc")}</div>
            </div>
            <div className="w-full min-w-0 sm:w-[28rem]">
              {credentialsLoading ? (
                <p className="text-sm text-muted-foreground">{t("loading_paseo_credentials")}</p>
              ) : credentialsError ? (
                <p className="text-sm text-destructive">{credentialsError}</p>
              ) : (
                <div className="grid gap-3">
                  <div className="flex flex-wrap items-end justify-end gap-3">
                    <div className="min-w-[8rem] flex-1">
                      <Select
                        value={paseoCredentialId}
                        onValueChange={setPaseoCredentialId}
                        disabled={agentCredentials.length === 0 || bindingPaseo || unbindingPaseo}
                      >
                        <SelectTrigger id="paseo-credential">
                          <SelectValue placeholder={t("paseo_credential")} />
                        </SelectTrigger>
                        <SelectContent>
                          {agentCredentials.map((credential) => (
                            <SelectItem key={credential.id} value={credential.id}>
                              {credential.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      className="shrink-0"
                      onClick={() => void handleBindPaseo()}
                      disabled={!paseoCredentialId || !driver || agentCredentials.length === 0 || bindingPaseo || unbindingPaseo}
                    >
                      {bindingPaseo ? t("binding_paseo") : t("bind_paseo")}
                    </Button>
                    <Button
                      className="shrink-0"
                      variant="outline"
                      onClick={() => void handleUnbindPaseo()}
                      disabled={!driver || !currentPaseoCredentialId || bindingPaseo || unbindingPaseo}
                    >
                      {unbindingPaseo ? t("unbinding_paseo") : t("unbind_paseo")}
                    </Button>
                  </div>
                  {agentCredentials.length === 0 ? (
                    <div className="text-right text-sm text-muted-foreground">
                      {t("no_paseo_credentials")}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </div>
        <Separator />
        <div className="grid gap-6">
          <div className="min-w-0">
            <div className="text-sm font-medium text-destructive">{t("danger_zone")}</div>
            <div className="text-sm text-muted-foreground">
              {t("workspace_danger_zone_desc")}
            </div>
          </div>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t("stop_workspace")}</div>
              <div className="text-sm text-muted-foreground">
                {translateWorkspaceRuntimeState(data?.status?.state, t)}
              </div>
            </div>
            <Button
              variant="outline"
              onClick={() => void handleStop()}
              disabled={loading || stopping || deleting}
            >
              {stopping ? t("stopping") : t("stop_workspace")}
            </Button>
          </div>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-destructive">{t("remove_workspace")}</div>
              <div className="text-sm text-muted-foreground">
                {t("remove_workspace_confirm_description")}
              </div>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="destructive"
                  disabled={loading || stopping || deleting}
                >
                  <Trash2 className="h-4 w-4" />
                  {deleting ? t("deleting") : t("remove_workspace")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("remove_workspace_confirm_title")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("remove_workspace_confirm_description")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void handleDelete()}>
                    {deleting ? t("deleting") : t("remove_workspace")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
        {actionError ? (
          <p className="text-sm text-destructive">{actionError}</p>
        ) : null}
      </div>
    );
  }

  function renderPane(): ReactNode {
    if (!data) {
      return (
        <EmptyPane
          title={t("empty_pane")}
          description={t("select_submenu")}
        />
      );
    }

    if (currentPane === "") {
      return embeddedPortalUrl ? (
        <div className="flex min-h-[75dvh] w-full min-w-0 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden rounded-[1.25rem] border border-border bg-background shadow-sm">
            <iframe
              key={embeddedPortalUrl}
              title={`${workspaceName} paseo`}
              src={embeddedPortalUrl}
              className="h-full min-h-[70dvh] w-full border-0"
            />
          </div>
        </div>
      ) : (
        <EmptyPane
          title={workspaceName}
          description={t("pairing_unknown")}
        />
      );
    }

    if (currentPane === "paseo") {
      const liveTarget = normalizePaseoPortalUrl(
        data.liveTarget ?? data.status?.paseo?.liveTarget,
      );
      return (
        <div className="flex min-h-[75dvh] w-full min-w-0 flex-col gap-6">
          <div className="grid gap-1">
            <div className="text-sm font-medium">
              {t("paseo_status")}
            </div>
            <div className="text-sm text-muted-foreground">
              {translatePaseoState(data.status?.daemon, t)}
            </div>
          </div>
          <Separator />
          <div className="grid gap-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium">{t("daemon_address")}</div>
                <div className="text-sm text-muted-foreground">{t("paseo_status")}</div>
              </div>
              <div className="w-full min-w-0 text-sm text-muted-foreground sm:w-[28rem] sm:text-right">
                <span className="break-all">
                  {data.status?.paseo?.daemonAddress ?? t("unknown")}
                </span>
              </div>
            </div>
            <Separator />
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium">{t("supported_harnesses")}</div>
                <div className="text-sm text-muted-foreground">{t("paseo_status")}</div>
              </div>
              <div className="flex w-full flex-wrap justify-start gap-2 sm:w-[28rem] sm:justify-end">
                {(data.status?.paseo?.supportedHarnesses ?? []).length > 0
                  ? data.status?.paseo?.supportedHarnesses?.map((item) => (
                      <Badge key={item} variant="secondary">{item}</Badge>
                    ))
                  : <span className="text-sm text-muted-foreground">{t("unknown")}</span>}
              </div>
            </div>
            <Separator />
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium">{t("live_target")}</div>
                <div className="text-sm text-muted-foreground">
                  {translatePairingState(data.status?.daemon?.pairing?.state, t)}
                </div>
              </div>
              <div className="w-full min-w-0 text-sm text-muted-foreground sm:w-[28rem] sm:text-right">
                <span className="break-all">
                  {liveTarget ?? t("unknown")}
                </span>
              </div>
            </div>
          </div>
          {renderControlsCard()}
        </div>
      );
    }

    if (currentPane === "dev-env") {
      return (
        <div className="grid gap-4">
          <div className="grid gap-1">
            <div className="text-sm font-medium">{t("isolated_dev_env")}</div>
            <div className="text-sm text-muted-foreground">{t("workspace_specs")}</div>
          </div>
          <WorkspaceAssetTable
            t={t}
            sections={developmentSections}
            emptyLabel={t("no_assets")}
            userId={userId}
            workspaceName={workspaceName}
            hideDetailsColumn
          />
        </div>
      );
    }

    if (currentPane === "memory") {
      return (
        <div className="grid gap-4">
          <div className="grid gap-1">
            <div className="text-sm font-medium">{t("evolution_memory")}</div>
            <div className="text-sm text-muted-foreground">
              {data.status?.evolution
                ? `${data.status.evolution.artifactCount} ${t("evolution_assets")}`
                : t("no_assets")}
            </div>
          </div>
          <WorkspaceAssetTable
            t={t}
            sections={evolutionSections}
            emptyLabel={t("no_assets")}
            userId={userId}
            workspaceName={workspaceName}
            hideDetailsColumn
          />
        </div>
      );
    }

    return (
      <EmptyPane
        title={t("empty_pane")}
        description={t("select_submenu")}
      />
    );
  }

  return (
    <PortalShell users={users ?? []}>
      <div className="grid w-full min-w-0 gap-6">
        {loading && <p className="text-sm text-muted-foreground">{t("loading_workspace")}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {actionError && <p className="text-sm text-destructive">{actionError}</p>}
        {renderPane()}
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
  const { t } = useLanguage();
  const { userId = "" } = useParams();
  const { data: users } = useAsyncValue(listUsers, []);
  const { data, error, loading } = useAsyncValue(() => listCredentials(userId), [userId]);

  return (
    <PortalShell users={users ?? []}>
      <div className="grid w-full min-w-0 gap-6">
        <div className="grid gap-1">
          <div className="text-sm font-medium">{t("credentials")}</div>
          <div className="text-sm text-muted-foreground">{t("credentials_for_user")}</div>
        </div>
        {loading && <p className="text-sm text-muted-foreground">{t("loading_credentials")}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <WorkspaceAssetTable
          t={t}
          sections={credentialAssetSections(data ?? [], t)}
          emptyLabel={t("no_credentials")}
          userId={userId}
        />
      </div>
    </PortalShell>
  );
}

function ProfilePage() {
  const { t } = useLanguage();
  const { userId = "" } = useParams();
  const { data: users } = useAsyncValue(listUsers, []);
  const [reloadKey, setReloadKey] = useState(0);
  const {
    data: credentials,
    error: credentialsError,
    loading: credentialsLoading,
  } = useAsyncValue(() => listCredentials(userId), [userId, reloadKey]);
  const [credentialForm, setCredentialForm] = useState({
    harness: "codex",
    label: "rightcode",
    providerName: "rightcode",
    baseUrl: "https://right.codes/codex/v1",
    apiKey: "",
  });
  const [credentialLabelTouched, setCredentialLabelTouched] = useState(false);
  const [credentialCreating, setCredentialCreating] = useState(false);
  const [credentialActionError, setCredentialActionError] = useState<string | null>(null);
  const [deletingCredentialId, setDeletingCredentialId] = useState<string | null>(null);

  async function handleCredentialCreate(event?: React.FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    if (credentialCreating) {
      return;
    }
    setCredentialCreating(true);
    setCredentialActionError(null);
    try {
      await createCodexCredential(userId, {
        label: credentialForm.label.trim() || credentialForm.providerName.trim() || "rightcode",
        providerName: credentialForm.providerName.trim() || "rightcode",
        baseUrl: credentialForm.baseUrl.trim() || "https://right.codes/codex/v1",
        apiKey: credentialForm.apiKey,
      });
      setCredentialForm({
        harness: "codex",
        label: "rightcode",
        providerName: "rightcode",
        baseUrl: "https://right.codes/codex/v1",
        apiKey: "",
      });
      setCredentialLabelTouched(false);
      setReloadKey((current) => current + 1);
    } catch (error) {
      setCredentialActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setCredentialCreating(false);
    }
  }

  async function handleCredentialDelete(credentialId: string): Promise<void> {
    if (deletingCredentialId) {
      return;
    }
    setDeletingCredentialId(credentialId);
    setCredentialActionError(null);
    try {
      await deleteCredential(userId, credentialId);
      setReloadKey((current) => current + 1);
    } catch (error) {
      setCredentialActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingCredentialId(null);
    }
  }

  return (
    <PortalShell users={users ?? []}>
      <div className="grid w-full gap-6">
        <div className="grid gap-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t("credentials")}</div>
              <div className="text-sm text-muted-foreground">{t("add_credential_desc")}</div>
            </div>
          </div>
          <form className="grid gap-4 rounded-[1.25rem] border border-border bg-background p-5 shadow-sm" onSubmit={(event) => void handleCredentialCreate(event)}>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="credential-type">{t("credential_type")}</Label>
                <Select
                  value={credentialForm.harness}
                  onValueChange={(value) => setCredentialForm((current) => ({ ...current, harness: value }))}
                >
                  <SelectTrigger id="credential-type" type="button">
                    <SelectValue placeholder={t("credential_type")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="codex">{t("credential_codex_option")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="credential-label">{t("credential_label")}</Label>
                <Input
                  id="credential-label"
                  value={credentialForm.label}
                  onChange={(event) => {
                    setCredentialLabelTouched(true);
                    setCredentialForm((current) => ({ ...current, label: event.target.value }));
                  }}
                  disabled={credentialCreating}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="credential-provider-name">{t("credential_provider_name")}</Label>
                <Input
                  id="credential-provider-name"
                  value={credentialForm.providerName}
                  onChange={(event) => {
                    const nextProviderName = event.target.value;
                    setCredentialForm((current) => ({
                      ...current,
                      providerName: nextProviderName,
                      label: credentialLabelTouched ? current.label : nextProviderName,
                    }));
                  }}
                  disabled={credentialCreating}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="credential-base-url">{t("credential_base_url")}</Label>
                <Input
                  id="credential-base-url"
                  value={credentialForm.baseUrl}
                  onChange={(event) => setCredentialForm((current) => ({ ...current, baseUrl: event.target.value }))}
                  disabled={credentialCreating}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="credential-api-key">{t("credential_api_key")}</Label>
              <Input
                id="credential-api-key"
                type="password"
                value={credentialForm.apiKey}
                onChange={(event) => setCredentialForm((current) => ({ ...current, apiKey: event.target.value }))}
                disabled={credentialCreating}
              />
            </div>
            {credentialActionError && (
              <p className="text-sm text-destructive">{credentialActionError}</p>
            )}
            <div className="flex justify-end">
              <Button type="submit" disabled={credentialCreating}>
                {credentialCreating ? t("creating_credential") : t("create_credential")}
              </Button>
            </div>
          </form>
          {credentialsLoading && (
            <p className="text-sm text-muted-foreground">{t("loading_credentials")}</p>
          )}
          {credentialsError && (
            <p className="text-sm text-destructive">{credentialsError}</p>
          )}
          <WorkspaceAssetTable
            t={t}
            sections={credentialAssetSections(credentials ?? [], t, {
              deletingCredentialId,
              onDelete: (credentialId) => void handleCredentialDelete(credentialId),
            })}
            emptyLabel={t("no_credentials")}
            userId={userId}
          />
        </div>
      </div>
    </PortalShell>
  );
}

function SettingsPage() {
  const { language, setLanguage, t } = useLanguage();
  const { userId = "" } = useParams();
  const navigate = useNavigate();
  const clerk = useClerk();
  const { mapping } = useCurrentUserMapping();
  const { data: users } = useAsyncValue(listUsers, []);
  const [deletingUser, setDeletingUser] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const canDeleteSelf = mapping?.polarisUserId === userId;

  async function handleDeleteUser(): Promise<void> {
    if (!canDeleteSelf || deletingUser) {
      return;
    }
    setDeletingUser(true);
    setDeleteError(null);
    try {
      await deletePortalUser(userId);
      await clerk.signOut({ redirectUrl: "/sign-in" });
      navigate("/sign-in", { replace: true });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingUser(false);
    }
  }

  return (
    <PortalShell users={users ?? []}>
      <div className="grid w-full gap-6">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t("settings_title")}</div>
          <div className="text-sm text-muted-foreground">{t("settings_desc")}</div>
        </div>
        <Separator />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium">{t("language")}</div>
            <div className="text-sm text-muted-foreground">{t("settings_desc")}</div>
          </div>
          <div className="w-full min-w-0 sm:w-[14rem]">
            <Select value={language} onValueChange={(value) => setLanguage(value as Language)}>
              <SelectTrigger>
                <SelectValue placeholder={t("language")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="zh">{t("lang_zh")}</SelectItem>
                <SelectItem value="en">{t("lang_en")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {canDeleteSelf && (
          <>
            <Separator />
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                  <span>{t("danger_zone")}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex items-center justify-center text-[11px] leading-none text-destructive/80 transition hover:text-destructive"
                        aria-label={t("danger_zone_tooltip")}
                      >
                        ?
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs border bg-white text-sm text-foreground shadow-lg">
                      {t("danger_zone_tooltip")}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <div className="text-sm text-muted-foreground">
                  {t("danger_zone_desc")}
                </div>
              </div>
              {deleteError && (
                <p className="w-full text-sm text-destructive">{deleteError}</p>
              )}
              <div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" disabled={deletingUser}>
                      <Trash2 className="h-4 w-4" />
                      {deletingUser ? t("deleting_user") : t("delete_user")}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("delete_user_confirm_title")}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("delete_user_confirm_description")}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => void handleDeleteUser()}>
                        {deletingUser ? t("deleting_user") : t("delete_user")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </>
        )}
      </div>
    </PortalShell>
  );
}

function trimUserAssetPath(pathValue: string, userId: string): string {
  const prefix = `config/users/${userId}/`;
  return pathValue.startsWith(prefix) ? pathValue.slice(prefix.length) : pathValue;
}

function CredentialPathCell(props: {
  path: string;
  userId?: string;
  previewPath?: string;
  previewScope?: "credential" | "workspace";
  workspaceName?: string;
}) {
  const showPreview = Boolean(props.userId && props.previewPath);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PortalCredentialPreview | PortalWorkspaceAssetPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !showPreview || preview) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const loader = props.previewScope === "workspace"
      ? getWorkspaceAssetPreview(
          props.userId as string,
          props.workspaceName as string,
          props.previewPath as string,
        )
      : getCredentialPreview(props.userId as string, props.previewPath as string);
    void loader
      .then((value) => {
        if (!cancelled) {
          setPreview(value);
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
  }, [
    open,
    preview,
    props.previewPath,
    props.previewScope,
    props.userId,
    props.workspaceName,
    showPreview,
  ]);

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="block max-w-full truncate text-sm text-muted-foreground" title={props.path}>
          {props.path}
        </span>
        {showPreview ? (
          <button
            type="button"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label={`Preview ${props.previewPath}`}
            onClick={() => setOpen((current) => !current)}
          >
            {open ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        ) : null}
      </div>
      {showPreview && open ? (
        <div className="grid gap-2 rounded-md border border-border bg-muted/20 p-3">
          {loading ? (
            <div className="text-sm text-muted-foreground">Loading...</div>
          ) : error ? (
            <div className="text-sm text-destructive">{error}</div>
          ) : (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs leading-5">
              {preview?.content ?? ""}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  );
}

function credentialAssetSections(
  credentials: PortalCredentialSummary[],
  t: (key: string) => string,
  options?: {
    deletingCredentialId?: string | null;
    onDelete?: (credentialId: string) => void;
  },
): AssetSection[] {
  return credentials.map((credential) => ({
    label: credential.label,
    rows: (credential.paths.length > 0 ? credential.paths : [t("none")]).map((item) => ({
      name: item === t("none") ? credential.kind : basenameForDisplay(item),
      path: item,
      status: translateState(credential.status, t),
      previewPath: item !== t("none") ? item : undefined,
    })),
    action: options?.onDelete ? (
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="destructive"
            size="sm"
            disabled={options.deletingCredentialId === credential.id}
            aria-label={t("delete_credential")}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("delete_credential_confirm_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("delete_credential_confirm_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => options.onDelete?.(credential.id)}>
              {options.deletingCredentialId === credential.id
                ? t("deleting_credential")
                : t("delete_credential")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ) : undefined,
  }));
}

export default function App(props: {
  language: Language;
  setLanguage: (value: Language) => void;
}) {
  const value: LanguageContextValue = {
    language: props.language,
    setLanguage: (next) => {
      writeStoredLanguage(next);
      props.setLanguage(next);
    },
    t: (key: string): string => COPY[props.language][key] ?? key,
  };

  return (
    <AppErrorBoundary>
      <LanguageContext.Provider value={value}>
        <Routes>
          <Route path="/sign-in/*" element={<SignInPage />} />
          <Route path="/sign-up/*" element={<SignUpPage />} />
          <Route
            path="*"
            element={(
              <AuthGate>
                <Routes>
                  <Route path="/" element={<OverviewPage />} />
                  <Route path="/users/:userId/profile" element={<ProfilePage />} />
                  <Route path="/users/:userId/admin" element={<AdminPage />} />
                  <Route path="/users/:userId/settings" element={<SettingsPage />} />
                  <Route path="/users/:userId/workspaces" element={<WorkspaceIndexPage />} />
                  <Route path="/users/:userId/workspaces/:workspaceName" element={<WorkspaceDetailPage />} />
                  <Route path="/users/:userId/workspaces/:workspaceName/paseo" element={<WorkspaceDetailPage />} />
                  <Route path="/users/:userId/workspaces/:workspaceName/dev-env" element={<WorkspaceDetailPage />} />
                  <Route path="/users/:userId/workspaces/:workspaceName/memory" element={<WorkspaceDetailPage />} />
                  <Route path="/users/:userId/credentials" element={<CredentialsPage />} />
                </Routes>
              </AuthGate>
            )}
          />
        </Routes>
      </LanguageContext.Provider>
    </AppErrorBoundary>
  );
}
