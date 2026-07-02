import * as React from "react";
import { useAuth, useClerk, useUser } from "@clerk/react";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Link,
  Navigate,
  Outlet,
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
  PlusCircle,
  RefreshCw,
  Link2,
  LogOut,
  Settings2,
  Trash2,
} from "lucide-react";
import {
  activateCredential,
  createCredential,
  createWorkspace,
  createPortalUser,
  deletePortalUser,
  deleteArchivedWorkspace,
  deleteCredential,
  deleteWorkspace,
  getCredentialCatalog,
  getCredentialPreview,
  getWorkspaceAssetPreview,
  getWorkspaceDetail,
  getWorkspacePaseoDiagnostic,
  getPortalSession,
  getUserProfile,
  listAdminUsers,
  listArchivedWorkspaces,
  listCredentials,
  listUsers,
  refreshWorkspaceStatus,
  restartWorkspacePaseoDaemon,
  resolvePortalUserMapping,
  setApiAuthTokenProvider,
  listWorkspaces,
  startWorkspace,
  stopWorkspace,
  switchWorkspaceLiveCredential,
  switchWorkspaceDriver,
  type PortalAdminUserSummary,
  type PortalArchivedWorkspaceSummary,
  type ManagedHarness,
  type PortalCredentialCatalog,
  type PortalCredentialSummary,
  type PortalCredentialPreview,
  type PortalProfileSummary,
  type PortalSession,
  type PortalUserMapping,
  type PortalWorkspaceAssetPreview,
  type PortalWorkspaceDetail,
  type PortalWorkspacePaseoDiagnostic,
  type PortalWorkspaceSummary,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { mergeEmbeddedPaseoFrames, type EmbeddedPaseoFrame } from "@/lib/paseo-frames";
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  buildClerkUrl,
  clerkSignInUrl,
  clerkSignUpUrl,
} from "@/lib/clerk";
import { type Language, writeStoredLanguage } from "@/lib/language";

function basenameForDisplay(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || filePath;
}

function workspaceSidebarStatusDotClass(backendLiveness: string | null | undefined): string {
  switch (backendLiveness) {
    case "running":
      return "bg-emerald-500";
    case "starting":
    case "creating":
      return "bg-sky-500";
    case "stopping":
    case "archiving":
      return "bg-amber-500";
    case "unknown":
      return "bg-rose-500";
    case "missing":
    case "stopped":
    default:
      return "bg-muted-foreground/35";
  }
}

type LanguageContextValue = {
  language: Language;
  setLanguage: (value: Language) => void;
  t: (key: string) => string;
};

type PortalShellContextValue = {
  activeUserId: string;
  workspaces: PortalWorkspaceSummary[];
  workspacesLoading: boolean;
  workspacesError: string | null;
  openCreateWorkspaceDialog: () => void;
  refreshWorkspaces: () => void;
  sidebarPollingWorkspaceKeys: string[];
  setSidebarWorkspacePolling: (workspaceKey: string, polling: boolean) => void;
  embeddedPaseoFrames: Array<{ workspaceKey: string; src: string; loaded: boolean }>;
  cacheEmbeddedPaseoFrame: (workspaceKey: string, src: string) => void;
  removeEmbeddedPaseoFrame: (workspaceKey: string) => void;
};

const COPY: Record<Language, Record<string, string>> = {
  en: {
    app_name: "Polaris",
    select_user: "Select a user",
    manage_users: "Manage users",
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
    workspace_name_invalid: "Use 1-63 lowercase letters, numbers, or hyphens. Start and end with a letter or number, and include at least one letter.",
    workspace_name_taken: "This workspace name already exists for the current user.",
    provisioning: "Provisioning...",
    create_workspace: "Create workspace",
    switch_driver: "Switch driver",
    switch_driver_desc: "Reuse the existing Polaris switch workflow.",
    switching: "Switching...",
    switch_workspace_action: "Switch driver",
    start_workspace: "Start workspace",
    stop_workspace: "Stop workspace",
    remove_workspace: "Archive workspace",
    remove_workspace_confirm_title: "Archive workspace?",
    remove_workspace_confirm_description: "This moves the workspace into the user archive and removes it from the active list. Running workspaces must be stopped before archiving.",
    deleting: "Deleting...",
    starting: "Starting...",
    stopping: "Stopping...",
    cancel: "Cancel",
    current_driver: "Current driver",
    driver_info: "Driver",
    base_image: "Base image",
    rootdisk_image: "Rootdisk image",
    driver_runtime: "Runtime",
    driver_runtime_docker: "Docker container",
    driver_runtime_pod: "Kubernetes pod",
    driver_runtime_vm: "KubeVirt VM",
    instance_missing: "missing",
    instance_created: "created",
    instance_running: "running",
    instance_stopped: "stopped",
    instance_degraded: "degraded",
    instance_unsupported: "unsupported",
    loading_workspace: "Loading workspace...",
    workspace_state: "Workspace state",
    daemon_pairing: "Daemon pairing",
    backend: "Backend",
    live_target: "Live target",
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
    asset_action: "Action",
    asset_details: "Details",
    no_assets: "No asset metadata yet.",
    credentials: "Credentials",
    credentials_for_user: "User-owned credentials for this user.",
    credentials_header_desc: "Manage SSH and agent harness credentials.",
    loading_credentials: "Loading credentials...",
    no_credentials: "No credentials found.",
    add_credential: "Add credential",
    add_credential_desc: "Manage harness-specific credentials for this user.",
    credential_template: "Credential template",
    credential_template_rightcode: "RightCode Codex",
    credential_label: "Credential label",
    credential_provider: "Provider",
    credential_model: "Model",
    credential_base_url: "Base URL",
    credential_api_key: "API key",
    credential_harness_ssh: "SSH key",
    credential_harness_codex: "Codex",
    credential_harness_claude: "Claude",
    credential_harness_copilot: "Copilot",
    credential_harness_opencode: "OpenCode",
    credential_harness_pi: "pi",
    credential_ssh_desc: "Managed SSH key material for Git and shell access.",
    credential_codex_desc: "Codex-compatible provider credentials and config.",
    credential_generic_desc: "Harness-scoped provider credentials kept in the user inventory.",
    create_credential: "Create credential",
    creating_credential: "Creating credential...",
    delete_credential: "Delete credential",
    set_default_credential: "Set as default",
    setting_default_credential: "Setting default...",
    default_credential: "Default",
    activate_credential: "Use this credential",
    activating_credential: "Switching...",
    active_credential: "Active",
    delete_credential_confirm_title: "Delete credential?",
    delete_credential_confirm_description: "This removes the credential registry entry and its generated auth files.",
    deleting_credential: "Deleting credential...",
    credential_paths: "Credential files",
    user_profile: "User profile",
    user_profile_desc: "Edit the active user information.",
    administration: "Administration",
    administration_desc: "Manage portal users and access.",
    settings_title: "Settings",
    settings_desc: "Choose the language used across the portal.",
    danger_zone: "Danger zone",
    workspace_danger_zone_desc: "Stop or archive this workspace.",
    archived_workspaces: "Archived workspaces",
    no_archived_workspaces: "No archived workspaces",
    admin_users_title: "Portal users",
    admin_users_desc: "Review users, scope ownership, and manage portal access.",
    admin_user_role: "Role",
    admin_user_status: "Status",
    admin_user_plan: "Plan",
    admin_user_credentials: "Credentials",
    admin_user_archives: "Archived",
    admin_user_mappings: "Mappings",
    admin_user_directory: "User directory",
    admin_user_overview: "Overview",
    admin_user_workspace_section: "Workspaces",
    admin_user_credentials_section: "Credentials",
    admin_user_tab_user: "User",
    admin_user_tab_credentials: "Credentials",
    admin_user_tab_workspaces: "Workspaces",
    admin_user_tab_paseo: "Paseo",
    admin_paseo_reconnect_mode: "Reconnect mode",
    admin_paseo_reconnect_target: "Reconnect target",
    admin_paseo_live_target: "Live target",
    admin_paseo_reconnectable: "Reconnectable",
    admin_paseo_needs_pairing: "Needs pairing",
    admin_paseo_status_button: "Refresh daemon status",
    admin_paseo_restart_button: "Restart daemon",
    admin_paseo_restarting_button: "Restarting daemon...",
    admin_paseo_status_raw: "paseo daemon status --json",
    admin_paseo_server_id: "Persisted server ID",
    admin_paseo_pairing_server_id: "Pairing server ID",
    admin_paseo_pairing_url: "Pairing URL",
    admin_paseo_daemon_observed: "Daemon observation",
    admin_paseo_pairing_observed: "Pairing observation",
    admin_user_archives_section: "Archived workspaces",
    admin_user_quick_actions: "Quick actions",
    admin_user_empty: "No users found.",
    admin_workspace_empty: "No workspaces yet.",
    admin_archive_empty: "No archived workspaces.",
    admin_credentials_empty: "No credentials yet.",
    admin_open_admin_user: "Open user",
    admin_manage_credentials: "Manage credentials",
    admin_manage_workspaces: "Manage workspaces",
    admin_open_workspace: "Open workspace",
    admin_open_controls: "Open controls",
    admin_view_archives: "View archives",
    admin_user_email: "Email",
    admin_user_github: "GitHub",
    admin_user_ssh_mode: "SSH mode",
    admin_user_recent_mappings: "Mappings",
    admin_delete_archived_workspace: "Delete archive",
    admin_delete_archived_workspace_confirm_title: "Delete archived workspace?",
    admin_delete_archived_workspace_confirm_description: "This permanently removes the archived workspace.",
    error_user_delete_blocked_workspace: "This user cannot be deleted while workspace data still exists.",
    error_user_delete_blocked_active: "Active workspaces",
    error_user_delete_blocked_archived: "Archived workspaces",
    admin_open_scope: "Open scope",
    admin_saving: "Saving...",
    admin_no_mapping: "No Clerk mapping",
    admin_status_ok: "OK",
    admin_status_mapping_only: "Mapping only",
    admin_status_profile_only: "Profile only",
    admin_status_profile_root_missing: "Profile root missing",
    admin_delete_user: "Delete user",
    admin_delete_user_confirm_title: "Delete user?",
    admin_delete_user_confirm_description: "This removes the user profile, credentials, mappings, and all workspace state under that user.",
    admin_deleting: "Deleting...",
    paseo_credential: "Workspace credential override",
    paseo_credential_desc: "Optionally apply a workspace-specific agent-auth credential for this driver.",
    loading_paseo_credentials: "Loading agent credentials...",
    no_paseo_credentials: "No agent-auth credential found.",
    current_paseo_credential: "Current Paseo credential",
    bind_paseo: "Apply override",
    binding_paseo: "Applying override...",
    unbind_paseo: "Clear override",
    unbinding_paseo: "Clearing override...",
    select_submenu: "Select a workspace submenu.",
    sidebar_tier: "Free",
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
    tracked_workspaces: "Active",
    purposes: "Purposes",
    workspace_example: "my-workspace",
    select_driver: "Select driver",
    create_suffix: "create",
    no_backend_detail: "No backend detail.",
    no_service_detail: "No service detail.",
    no_profile_detail: "No profile detail.",
    workspace_overview: "Workspace overview",
    paseo_info: "Agent cluster",
    paseo_status: "Paseo status",
    isolated_dev_env: "Isolated development environment",
    evolution_memory: "Evolution memory",
    daemon_address: "Daemon address",
    paseo_server_id: "Paseo server ID",
    supported_harnesses: "Supported harnesses",
    credential_selection: "Credential selection",
    credential_selection_none: "No current credential selected.",
    credential_selection_runtime: "Runtime-selected",
    credential_selection_override: "Workspace override",
    credential_selection_active: "User active default",
    credential_selection_compat: "Compatibility fallback",
    credential_selection_current: "Current credential",
    agent_harness: "Agent harness",
    select_harness: "Select harness",
    select_credential: "Select credential",
    switch_credential: "Switch credential",
    credential_switch_requires_running: "Start the workspace before switching the live credential.",
    credential_switch_unavailable: "Live switching is only available for Codex right now.",
    status_ready: "Ready to pair",
    status_unknown: "Unknown",
    status_error: "Error",
    status_failed: "Failed",
    status_provisioning: "Provisioning",
    provisioning_queued: "Queued",
    provisioning_running: "Running",
    provisioning_cancelling: "Cancelling",
    provisioning_cancelled: "Cancelled",
    provisioning_completed: "Completed",
    provisioning_failed: "Failed",
    error_image_build_failed: "Image build failed.",
    error_workspace_runtime_failed: "Workspace runtime failed to start correctly.",
    error_workspace_provision_failed: "Workspace provisioning failed.",
    error_workspace_provision_cancelled: "Workspace provisioning was cancelled.",
    error_generic: "Something went wrong.",
    status_not_selected: "Not selected",
    workspace_not_started: "Not started",
    workspace_creating: "Creating",
    workspace_stopped: "Stopped",
    workspace_starting: "Starting",
    workspace_ready: "Driver ready",
    workspace_ready_to_pair: "Ready to pair",
    workspace_attention: "Needs attention",
    workspace_status_loading: "Reading status",
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
    empty_pane: "Select content",
    workspace_header_title: "Workspace",
    workspace_header_empty: "No workspace selected yet.",
    workspace_status_button: "Workspace status",
    workspace_empty_title: "Create your first workspace",
    workspace_empty_description_line_1: "You don't have any workspaces yet.",
    workspace_empty_description_line_2: "After creation, you can start using it right away. The system will connect the default key first.",
    workspace_empty_description_line_3: "If you want to use your own credentials, you can add them first.",
    workspace_empty_create: "Create now",
    workspace_empty_credentials: "Add credentials",
    global_error_title: "Something went wrong",
    global_error_description: "The page could not be loaded.",
    global_error_unresolved_access: "Your access could not be verified.",
    creating_account: "Creating account...",
    refresh: "Refresh",
    refreshing: "Refreshing...",
  },
  zh: {
    app_name: "Polaris",
    select_user: "选择用户",
    manage_users: "管理用户",
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
    workspace_name_invalid: "工作空间名称需为 1-63 个字符，只能包含小写字母、数字或连字符，首尾必须是字母或数字，且至少包含一个字母。",
    workspace_name_taken: "这个工作空间名称已经存在。",
    provisioning: "正在准备…",
    create_workspace: "创建工作空间",
    switch_driver: "切换驱动",
    switch_driver_desc: "复用现有的 Polaris 切换流程。",
    switching: "切换中…",
    switch_workspace_action: "切换驱动",
    start_workspace: "启动工作空间",
    stop_workspace: "停止工作空间",
    remove_workspace: "归档工作空间",
    remove_workspace_confirm_title: "归档这个工作空间？",
    remove_workspace_confirm_description: "这会把工作空间移入用户归档区，并从当前列表中移除，不可逆。",
    deleting: "归档中…",
    starting: "启动中…",
    stopping: "停止中…",
    cancel: "取消",
    current_driver: "当前驱动",
    driver_info: "驱动",
    base_image: "基础镜像",
    rootdisk_image: "根磁盘镜像",
    driver_runtime: "运行时",
    driver_runtime_docker: "Docker 容器",
    driver_runtime_pod: "Kubernetes Pod",
    driver_runtime_vm: "KubeVirt 虚拟机",
    instance_missing: "未创建",
    instance_created: "已创建",
    instance_running: "运行中",
    instance_stopped: "已停止",
    instance_degraded: "异常",
    instance_unsupported: "不支持",
    loading_workspace: "正在加载工作空间…",
    workspace_state: "工作空间状态",
    daemon_pairing: "配对状态",
    backend: "后端",
    live_target: "访问入口",
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
    asset_action: "操作",
    asset_details: "详情",
    no_assets: "暂无资产元数据。",
    credentials: "凭证",
    credentials_for_user: "该用户所属的凭证。",
    credentials_header_desc: "集中管理当前用户的 SSH 与 agent harness 凭证。",
    loading_credentials: "正在加载凭证…",
    no_credentials: "暂无凭证。",
    add_credential: "新增凭证",
    add_credential_desc: "管理该用户按 harness 分类的凭证。",
    credential_template: "凭证模板",
    credential_template_rightcode: "RightCode Codex",
    credential_label: "凭证名称",
    credential_provider: "供应商",
    credential_model: "模型",
    credential_base_url: "Base URL",
    credential_api_key: "API Key",
    credential_harness_ssh: "SSH Key",
    credential_harness_codex: "Codex",
    credential_harness_claude: "Claude",
    credential_harness_copilot: "Copilot",
    credential_harness_opencode: "OpenCode",
    credential_harness_pi: "pi",
    credential_ssh_desc: "用于 Git 和 shell 访问的托管 SSH 密钥。",
    credential_codex_desc: "Codex 兼容供应商凭证与配置。",
    credential_generic_desc: "按 harness 归档保存的供应商凭证。",
    create_credential: "创建凭证",
    creating_credential: "正在创建凭证…",
    delete_credential: "删除凭证",
    set_default_credential: "设为默认",
    setting_default_credential: "设置中…",
    default_credential: "默认",
    activate_credential: "切换到这个凭证",
    activating_credential: "切换中…",
    active_credential: "当前使用",
    delete_credential_confirm_title: "删除这个凭证？",
    delete_credential_confirm_description: "这会删除凭证注册文件以及生成出的鉴权文件。",
    deleting_credential: "正在删除凭证…",
    credential_paths: "凭证文件",
    user_profile: "用户资料",
    user_profile_desc: "编辑当前用户信息。",
    administration: "管理",
    administration_desc: "管理门户用户和访问权限。",
    settings_title: "设置",
    settings_desc: "选择整个门户使用的语言。",
    danger_zone: "危险操作",
    workspace_danger_zone_desc: "停止或归档这个工作空间。",
    archived_workspaces: "已归档工作空间",
    no_archived_workspaces: "没有已归档工作空间",
    admin_users_title: "门户用户",
    admin_users_desc: "查看用户、归属范围和门户访问权限。",
    admin_user_role: "角色",
    admin_user_status: "状态",
    admin_user_plan: "套餐",
    admin_user_credentials: "凭证",
    admin_user_archives: "归档",
    admin_user_mappings: "映射",
    admin_user_directory: "用户目录",
    admin_user_overview: "概览",
    admin_user_workspace_section: "工作空间",
    admin_user_credentials_section: "凭证",
    admin_user_tab_user: "用户",
    admin_user_tab_credentials: "凭证",
    admin_user_tab_workspaces: "工作空间",
    admin_user_tab_paseo: "Paseo",
    admin_paseo_reconnect_mode: "重连模式",
    admin_paseo_reconnect_target: "重连入口",
    admin_paseo_live_target: "访问入口",
    admin_paseo_reconnectable: "可重连",
    admin_paseo_needs_pairing: "需要重新配对",
    admin_paseo_status_button: "刷新 daemon 状态",
    admin_paseo_restart_button: "重启 daemon",
    admin_paseo_restarting_button: "正在重启 daemon…",
    admin_paseo_status_raw: "paseo daemon status --json",
    admin_paseo_server_id: "持久化 server ID",
    admin_paseo_pairing_server_id: "配对 server ID",
    admin_paseo_pairing_url: "配对 URL",
    admin_paseo_daemon_observed: "daemon 观测",
    admin_paseo_pairing_observed: "配对观测",
    admin_user_archives_section: "已归档工作空间",
    admin_user_quick_actions: "快捷操作",
    admin_user_empty: "暂无用户。",
    admin_workspace_empty: "还没有工作空间。",
    admin_archive_empty: "还没有归档工作空间。",
    admin_credentials_empty: "还没有凭证。",
    admin_open_admin_user: "打开用户",
    admin_manage_credentials: "管理凭证",
    admin_manage_workspaces: "管理工作空间",
    admin_open_workspace: "打开工作空间",
    admin_open_controls: "打开控制区",
    admin_view_archives: "查看归档",
    admin_user_email: "邮箱",
    admin_user_github: "GitHub",
    admin_user_ssh_mode: "SSH 模式",
    admin_user_recent_mappings: "映射",
    admin_delete_archived_workspace: "删除归档",
    admin_delete_archived_workspace_confirm_title: "删除这个已归档工作空间？",
    admin_delete_archived_workspace_confirm_description: "这会永久删除这个已归档工作空间。",
    error_user_delete_blocked_workspace: "该用户仍有工作空间数据，无法删除。",
    error_user_delete_blocked_active: "活跃工作空间",
    error_user_delete_blocked_archived: "已归档工作空间",
    admin_open_scope: "打开用户范围",
    admin_saving: "保存中…",
    admin_no_mapping: "还没有 Clerk 映射",
    admin_status_ok: "正常",
    admin_status_mapping_only: "只有映射",
    admin_status_profile_only: "只有资料",
    admin_status_profile_root_missing: "资料存在但目录缺失",
    admin_delete_user: "删除用户",
    admin_delete_user_confirm_title: "删除这个用户？",
    admin_delete_user_confirm_description: "这会删除该用户的资料、凭证、映射，以及该用户下的全部工作空间状态。",
    admin_deleting: "删除中…",
    paseo_credential: "工作空间凭证覆盖",
    paseo_credential_desc: "可选地为当前 driver 应用一个工作空间级 agent-auth 凭证。",
    loading_paseo_credentials: "正在加载 agent 凭证…",
    no_paseo_credentials: "没有可用的 agent-auth credential。",
    current_paseo_credential: "当前 Paseo 凭证",
    bind_paseo: "应用覆盖",
    binding_paseo: "正在应用覆盖…",
    unbind_paseo: "清除覆盖",
    unbinding_paseo: "正在清除覆盖…",
    select_submenu: "请选择工作空间子页面。",
    sidebar_tier: "免费版",
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
    tracked_workspaces: "活跃",
    purposes: "用途",
    workspace_example: "my-workspace",
    select_driver: "选择驱动",
    create_suffix: "创建",
    no_backend_detail: "暂无后端详情。",
    no_service_detail: "暂无服务详情。",
    no_profile_detail: "暂无用户配置详情。",
    workspace_overview: "工作空间概览",
    paseo_info: "智能体集群",
    paseo_status: "Paseo 状态",
    isolated_dev_env: "隔离开发环境",
    evolution_memory: "演进记忆",
    daemon_address: "守护进程地址",
    paseo_server_id: "Paseo server ID",
    supported_harnesses: "支持的协作者",
    credential_selection: "凭证选择",
    credential_selection_none: "当前没有选中的凭证。",
    credential_selection_runtime: "运行时已切换",
    credential_selection_override: "工作空间覆盖",
    credential_selection_active: "用户当前默认值",
    credential_selection_compat: "兼容回退",
    credential_selection_current: "当前凭证",
    agent_harness: "Agent harness",
    select_harness: "选择 harness",
    select_credential: "选择凭证",
    switch_credential: "凭证切换",
    credential_switch_requires_running: "请先启动工作空间，再切换运行时凭证。",
    credential_switch_unavailable: "当前只有 Codex 支持运行时切换。",
    status_ready: "可配对",
    status_unknown: "未知",
    status_error: "错误",
    status_failed: "失败",
    status_provisioning: "准备中",
    provisioning_queued: "排队中",
    provisioning_running: "执行中",
    provisioning_cancelling: "取消中",
    provisioning_cancelled: "已取消",
    provisioning_completed: "已完成",
    provisioning_failed: "失败",
    error_image_build_failed: "镜像构建失败。",
    error_workspace_runtime_failed: "工作空间运行时启动失败。",
    error_workspace_provision_failed: "工作空间准备失败。",
    error_workspace_provision_cancelled: "工作空间准备已取消。",
    error_generic: "出现异常。",
    status_not_selected: "未选中",
    workspace_not_started: "未启动",
    workspace_creating: "创建中",
    workspace_stopped: "已停止",
    workspace_starting: "启动中",
    workspace_ready: "驱动就绪",
    workspace_ready_to_pair: "可配对",
    workspace_attention: "需要处理",
    workspace_status_loading: "正在读取状态",
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
    empty_pane: "请选择内容",
    workspace_header_title: "工作空间",
    workspace_header_empty: "未选择工作空间",
    workspace_status_button: "工作空间状态",
    workspace_empty_title: "开始创建你的第一个工作空间",
    workspace_empty_description_line_1: "你还没有工作空间。",
    workspace_empty_description_line_2: "创建后即可直接开始使用，系统会先为你接入默认密钥。",
    workspace_empty_description_line_3: "如果你想使用自己的凭证，也可以先添加。",
    workspace_empty_create: "立即创建",
    workspace_empty_credentials: "添加凭证",
    global_error_title: "出错了",
    global_error_description: "页面无法加载。",
    global_error_unresolved_access: "无法验证当前访问权限。",
    creating_account: "正在创建账号…",
    refresh: "刷新",
    refreshing: "刷新中…",
  },
};

const LanguageContext = createContext<LanguageContextValue | null>(null);
const PortalShellContext = createContext<PortalShellContextValue | null>(null);

function useLanguage(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("Language context is not available");
  }
  return context;
}

function usePortalShell(): PortalShellContextValue {
  const context = useContext(PortalShellContext);
  if (!context) {
    throw new Error("Portal shell context is not available");
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
    return clerkSignInUrl();
  }
  const redirectTarget = normalizePath(window.location.pathname) === "/sign-in"
    || normalizePath(window.location.pathname) === "/sign-up"
    ? new URL("/", window.location.origin).toString()
    : window.location.href;
  return buildClerkUrl(clerkSignInUrl(), redirectTarget);
}

function portalSignUpUrl(): string {
  if (typeof window === "undefined") {
    return clerkSignUpUrl();
  }
  return buildClerkUrl(
    clerkSignUpUrl(),
    new URL("/", window.location.origin).toString(),
  );
}

function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

function AuthGate(props: { children: ReactNode }) {
  const { isLoaded, userId } = useAuth();
  const [backendSession, setBackendSession] = useState<PortalSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void getPortalSession()
      .then((session) => {
        if (!cancelled) {
          setBackendSession(session);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBackendSession(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSessionLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const hasBackendSession =
    backendSession?.authenticated && Boolean(backendSession.clerkUserId);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }
    if (userId || hasBackendSession || sessionLoading) {
      return;
    }
    window.location.assign(portalSignInUrl());
  }, [hasBackendSession, isLoaded, sessionLoading, userId]);

  if (!isLoaded || sessionLoading || (!userId && !hasBackendSession)) {
    return null;
  }
  return <>{props.children}</>;
}

function ApiAuthBridge() {
  const { getToken } = useAuth();

  useLayoutEffect(() => {
    setApiAuthTokenProvider(async () => {
      const token = await getToken();
      return token?.trim() || null;
    });
    return () => {
      setApiAuthTokenProvider(null);
    };
  }, [getToken]);

  return null;
}

function normalizeClerkUsername(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function resolveClerkIdentityKey(user: {
  id?: string | null;
  username?: string | null;
  primaryEmailAddress?: {
    emailAddress?: string | null;
  } | null;
} | null | undefined): string {
  return normalizeClerkUsername(
    user?.username
      ?? user?.primaryEmailAddress?.emailAddress?.split("@")[0]
      ?? user?.id
      ?? null,
  );
}

function resolvePolarisProfileIdCandidate(user: {
  id?: string | null;
  username?: string | null;
} | null | undefined): string {
  const username = normalizeClerkUsername(user?.username);
  if (username) {
    return username;
  }
  const clerkUserId = String(user?.id ?? "").trim();
  return clerkUserId || "";
}

function useCurrentUserMapping() {
  const { user } = useUser();
  const { data: backendSession } = useAsyncValue<PortalSession | null>(
    () => getPortalSession(),
    [],
  );
  const clerkUsername = resolveClerkIdentityKey(user);
  const clerkUserId = String(user?.id ?? "").trim();
  const { data, error, loading } = useAsyncValue<PortalUserMapping | null>(
    () => clerkUsername || clerkUserId
      ? resolvePortalUserMapping({ clerkUsername, clerkUserId })
      : Promise.resolve(null),
    [clerkUserId, clerkUsername],
  );
  const useBackendSessionIdentity =
    !clerkUsername && !clerkUserId && Boolean(backendSession?.authenticated);
  const sessionMapping = backendSession?.polarisUserId && backendSession.role
    ? {
      polarisUserId: backendSession.polarisUserId,
      role: backendSession.role,
      plan: "free" as const,
    }
    : null;
  return {
    clerkUsername: useBackendSessionIdentity ? (backendSession?.clerkUsername ?? "") : clerkUsername,
    clerkUserId: useBackendSessionIdentity ? backendSession?.clerkUserId ?? "" : clerkUserId,
    mapping: useBackendSessionIdentity ? sessionMapping : data,
    mappingError: useBackendSessionIdentity ? null : error,
    mappingLoading: useBackendSessionIdentity ? false : loading,
  };
}

function SignInPage() {
  const { isLoaded, userId } = useAuth();
  useEffect(() => {
    if (isLoaded && userId) {
      return;
    }
    window.location.assign(portalSignInUrl());
  }, [isLoaded, userId]);
  if (isLoaded && userId) {
    return <Navigate to="/" replace />;
  }
  return null;
}

function SignUpPage() {
  const { isLoaded, userId } = useAuth();
  useEffect(() => {
    if (isLoaded && userId) {
      return;
    }
    window.location.assign(portalSignUpUrl());
  }, [isLoaded, userId]);

  if (isLoaded && userId) {
    return <Navigate to="/" replace />;
  }
  return null;
}

function driverLabel(driver: { backend: string; profile?: string } | null): string {
  if (!driver) {
    return "not-selected";
  }
  return driver.backend === "pod" && driver.profile
    ? `pod:${driver.profile}`
    : driver.backend;
}

const WORKSPACE_NAME_INPUT_PATTERN =
  /^(?=.{1,63}$)(?=.*[a-z])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function validateWorkspaceNameInput(
  value: string,
  t: (key: string) => string,
): string | null {
  return WORKSPACE_NAME_INPUT_PATTERN.test(value.trim())
    ? null
    : t("workspace_name_invalid");
}

function translateDriverRuntimeKind(
  value: string | null | undefined,
  t: (key: string) => string,
): string {
  switch (value) {
    case "docker-container":
      return t("driver_runtime_docker");
    case "kubernetes-pod":
      return t("driver_runtime_pod");
    case "kubevirt-vm":
      return t("driver_runtime_vm");
    default:
      return value || t("unknown");
  }
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

function translateErrorCode(
  errorCode: string | null | undefined,
  t: (key: string) => string,
): string {
  switch (errorCode) {
    case "image-build-failed":
      return t("error_image_build_failed");
    case "workspace-runtime-failed":
      return t("error_workspace_runtime_failed");
    case "workspace-provision-cancelled":
      return t("error_workspace_provision_cancelled");
    case "workspace-provision-failed":
      return t("error_workspace_provision_failed");
    default:
      return t("error_generic");
  }
}

function formatProvisionError(args: {
  errorCode?: string;
  message?: string;
  t: (key: string) => string;
}): string {
  const friendly = translateErrorCode(args.errorCode, args.t);
  const detail = args.message?.trim();
  if (!detail || detail === friendly) {
    return friendly;
  }
  return `${friendly} ${detail}`;
}

function formatActionError(
  error: unknown,
  t: (key: string) => string,
): string {
  const raw = error instanceof Error ? error.message : String(error);
  const trimmed = raw.trim();
  if (!trimmed) {
    return t("error_generic");
  }
  if (/cannot be deleted while workspace data still exists/i.test(trimmed)) {
    const activeMatch = trimmed.match(/Active workspaces:\s*([^.]*(?:\.[^A-Z]|[^.]*)?)(?:Archived workspaces:|Archive or delete|$)/i);
    const archivedMatch = trimmed.match(/Archived workspaces:\s*([^.]*(?:\.[^A-Z]|[^.]*)?)(?:Archive or delete|$)/i);
    const parts = [t("error_user_delete_blocked_workspace")];
    const active = activeMatch?.[1]?.trim().replace(/\s+$/, "");
    const archived = archivedMatch?.[1]?.trim().replace(/\s+$/, "");
    if (active) {
      parts.push(`${t("error_user_delete_blocked_active")}：${active}`);
    }
    if (archived) {
      parts.push(`${t("error_user_delete_blocked_archived")}：${archived}`);
    }
    return parts.join(" ");
  }
  if (
    /already archived for user/i.test(trimmed)
    || /already exists for user/i.test(trimmed)
  ) {
    return t("workspace_name_taken");
  }
  const separator = ": ";
  const index = trimmed.indexOf(separator);
  if (index > 0) {
    const errorCode = trimmed.slice(0, index).trim();
    const detail = trimmed.slice(index + separator.length).trim();
    if (/^[a-z0-9-]+$/i.test(errorCode)) {
      return formatProvisionError({
        errorCode,
        message: detail,
        t,
      });
    }
  }
  return trimmed;
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

function translateReconnectMode(
  value: "reconnectable" | "needs-pairing" | "unknown" | null | undefined,
  t: (key: string) => string,
): string {
  switch (value) {
    case "reconnectable":
      return t("admin_paseo_reconnectable");
    case "needs-pairing":
      return t("admin_paseo_needs_pairing");
    default:
      return t("pairing_unknown");
  }
}

function translateAdminIntegrityStatus(
  value: PortalAdminUserSummary["integrityStatus"],
  t: (key: string) => string,
): string {
  switch (value) {
    case "ok":
      return t("admin_status_ok");
    case "mapping-only":
      return t("admin_status_mapping_only");
    case "profile-only":
      return t("admin_status_profile_only");
    case "profile-root-missing":
      return t("admin_status_profile_root_missing");
    default:
      return value;
  }
}

function translateWorkspaceLiveness(
  value: string | null | undefined,
  t: (key: string) => string,
): string {
  switch (value) {
    case "creating":
      return t("workspace_creating");
    case "starting":
      return t("workspace_starting");
    case "running":
      return t("workspace_ready");
    case "stopping":
      return t("stopping");
    case "archiving":
      return t("deleting");
    case "stopped":
    case "missing":
      return t("workspace_not_started");
    default:
      return t("unknown");
  }
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

function normalizePaseoScope(input: string | null | undefined): string | null {
  const trimmed = String(input ?? "").trim();
  return trimmed || null;
}

function extractPaseoScope(input: string): string | null {
  try {
    const baseUrl = typeof window === "undefined" ? "http://localhost" : window.location.href;
    const url = new URL(input, baseUrl);
    const scope = url.searchParams.get("scope")?.trim();
    return scope || null;
  } catch {
    return null;
  }
}

function upgradePaseoUrlForSecureOrigin(input: string): string {
  if (typeof window === "undefined") {
    return input;
  }
  try {
    const current = new URL(window.location.href);
    const url = new URL(input, current.href);
    if (current.protocol === "https:" && url.protocol === "http:" && url.host === current.host) {
      url.protocol = "https:";
      return url.toString();
    }
  } catch {
    return input;
  }
  return input;
}

function applyPaseoScope(input: string, scope: string | null | undefined): string {
  const normalizedScope = normalizePaseoScope(scope);
  if (!normalizedScope) {
    return upgradePaseoUrlForSecureOrigin(input);
  }
  try {
    const baseUrl = typeof window === "undefined" ? "http://localhost" : window.location.href;
    const url = new URL(input, baseUrl);
    url.searchParams.set("scope", normalizedScope);
    return upgradePaseoUrlForSecureOrigin(url.toString());
  } catch {
    return upgradePaseoUrlForSecureOrigin(input);
  }
}

function buildScopedPaseoPortalUrl(
  appBaseUrl: string,
  offer: string,
  scope: string | null | undefined,
): string {
  try {
    const baseUrl = typeof window === "undefined" ? "http://localhost" : window.location.href;
    const url = new URL(appBaseUrl, baseUrl);
    const normalizedScope = normalizePaseoScope(scope);
    if (normalizedScope) {
      url.searchParams.set("scope", normalizedScope);
    }
    url.hash = `offer=${offer}`;
    return upgradePaseoUrlForSecureOrigin(url.toString());
  } catch {
    return upgradePaseoUrlForSecureOrigin(
      applyPaseoScope(`${appBaseUrl.replace(/\/$/, "")}/#offer=${offer}`, scope),
    );
  }
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
    return upgradePaseoUrlForSecureOrigin(url.toString()).replace(/\/$/, "");
  }
  if (typeof window === "undefined") {
    return null;
  }
  const url = new URL(window.location.href);
  url.pathname = "/paseo/";
  url.search = "";
  url.hash = "";
  return upgradePaseoUrlForSecureOrigin(url.toString()).replace(/\/$/, "");
}

function normalizePaseoPortalUrl(
  input: string | null | undefined,
  scope?: string | null,
): string | null {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const effectiveScope = extractPaseoScope(trimmed) ?? normalizePaseoScope(scope);
  const offer = extractOfferFragment(trimmed);
  if (!offer) {
    return applyPaseoScope(trimmed, effectiveScope);
  }
  const appBaseUrl = configuredPaseoAppBaseUrl();
  if (!appBaseUrl) {
    return applyPaseoScope(trimmed, effectiveScope);
  }
  return upgradePaseoUrlForSecureOrigin(
    buildScopedPaseoPortalUrl(appBaseUrl, offer, effectiveScope),
  );
}

function buildPaseoReconnectUrl(
  serverId: string | null | undefined,
  liveTarget: string | null | undefined,
  scope?: string | null,
): string | null {
  const normalizedServerId = String(serverId ?? "").trim();
  if (!normalizedServerId) {
    return normalizePaseoPortalUrl(liveTarget, scope);
  }
  const appBaseUrl = configuredPaseoAppBaseUrl();
  if (!appBaseUrl) {
    return normalizePaseoPortalUrl(liveTarget, scope);
  }
  try {
    const url = new URL(`${appBaseUrl.replace(/\/$/, "")}/h/${encodeURIComponent(normalizedServerId)}`);
    const normalizedScope = normalizePaseoScope(scope);
    if (normalizedScope) {
      url.searchParams.set("scope", normalizedScope);
    }
    const offer = extractOfferFragment(String(liveTarget ?? ""));
    if (offer) {
      url.hash = `offer=${offer}`;
    }
    return upgradePaseoUrlForSecureOrigin(url.toString());
  } catch {
    return normalizePaseoPortalUrl(liveTarget, scope);
  }
}

function workspacePaseoScope(userId: string, workspaceName: string): string {
  return `${userId.trim()}:${workspaceName.trim()}`;
}

function formatBackendValue(
  data: PortalWorkspaceDetail,
  t: (key: string) => string,
): string {
  const kind = data.status?.driver?.backend ?? t("status_unknown");
  const profile = data.status?.driver?.profile ?? t("status_unknown");
  return `${kind} / ${profile}`;
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
  const { userId: routeUserId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [startAfterCreate, setStartAfterCreate] = useState(true);
  const [defaultDockerOnly, setDefaultDockerOnly] = useState(true);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [createWorkspaceError, setCreateWorkspaceError] = useState<string | null>(null);
  const [workspaceRefreshTick, setWorkspaceRefreshTick] = useState(0);
  const [sidebarPollingWorkspaceKeys, setSidebarPollingWorkspaceKeys] = useState<string[]>([]);
  const [embeddedPaseoFrames, setEmbeddedPaseoFrames] = useState<EmbeddedPaseoFrame[]>([]);
  const isAdmin = mapping?.role === "admin";
  const activeUserId = String(routeUserId ?? "").trim();
  const activeUser = props.users.find((user) => user.id === activeUserId) ?? null;
  const {
    data: sidebarWorkspaces,
    loading: sidebarWorkspacesLoading,
    error: sidebarWorkspacesError,
  } = useAsyncValue(
    () => activeUserId ? listWorkspaces(activeUserId) : Promise.resolve<PortalWorkspaceSummary[]>([]),
    [activeUserId, workspaceRefreshTick],
  );
  const pathParts = location.pathname.split("/").filter(Boolean);
  const isWorkspaceRoute = pathParts[0] === "users" && pathParts[2] === "workspaces";
  const currentWorkspaceName = isWorkspaceRoute && pathParts[3]
    ? decodeURIComponent(pathParts[3])
    : "";
  const currentWorkspacePane = isWorkspaceRoute ? (pathParts[4] ?? "") : "";
  const activeFrameKey = currentWorkspaceName
    ? `${activeUserId.trim()}:${currentWorkspaceName.trim()}`
    : "";
  const activeEmbeddedPaseoFrame = activeFrameKey
    ? embeddedPaseoFrames.find((frame) => frame.workspaceKey === activeFrameKey) ?? null
    : null;
  const hasActiveEmbeddedPaseoFrame = Boolean(activeEmbeddedPaseoFrame);
  const activeEmbeddedPaseoFrameLoaded = activeEmbeddedPaseoFrame?.loaded === true;
  const activeSidebarWorkspace = currentWorkspaceName
    ? (sidebarWorkspaces ?? []).find((workspace) => workspace.name === currentWorkspaceName) ?? null
    : null;
  const activeSidebarWorkspaceLiveness = activeSidebarWorkspace?.status?.health?.backendLiveness ?? null;
  const activeSidebarWorkspaceAllowsEmbeddedPaseo =
    activeSidebarWorkspaceLiveness === "running"
    || activeSidebarWorkspaceLiveness === "starting"
    || activeSidebarWorkspaceLiveness === "creating";
  const shouldShowEmbeddedPaseoLoading = Boolean(
    currentWorkspaceName
    && currentWorkspacePane === ""
    && activeSidebarWorkspaceAllowsEmbeddedPaseo
    && !activeEmbeddedPaseoFrameLoaded
    && (
      sidebarWorkspacesLoading
      || hasActiveEmbeddedPaseoFrame
      || activeSidebarWorkspace?.liveTarget
      || activeSidebarWorkspace?.reconnectTarget
    ),
  );
  const createWorkspaceNameError = validateWorkspaceNameInput(newWorkspaceName, t);
  const canSubmitCreateWorkspace =
    !creatingWorkspace
    && newWorkspaceName.trim().length > 0
    && !createWorkspaceNameError;

  function resetCreateWorkspaceForm(): void {
    setNewWorkspaceName("");
    setStartAfterCreate(true);
    setDefaultDockerOnly(true);
    setCreateWorkspaceError(null);
    setCreatingWorkspace(false);
  }

  function handleCreateWorkspaceOpenChange(open: boolean): void {
    if (creatingWorkspace && !open) {
      return;
    }
    setCreateWorkspaceOpen(open);
    if (!open) {
      resetCreateWorkspaceForm();
    }
  }

  function openCreateWorkspaceDialog(): void {
    if (isMobile && openMobile) {
      setOpenMobile(false);
      window.setTimeout(() => {
        setCreateWorkspaceOpen(true);
      }, 0);
      return;
    }
    setCreateWorkspaceOpen(true);
  }

  function closeMobileSidebar(): void {
    if (isMobile) {
      setOpenMobile(false);
    }
  }

  function handleSidebarNavigate(): void {
    closeMobileSidebar();
  }

  async function handleWorkspaceSelect(
    event: React.MouseEvent<HTMLAnchorElement>,
    workspaceName: string,
  ): Promise<void> {
    event.preventDefault();
    handleSidebarNavigate();
    if (!activeUserId) {
      return;
    }
    try {
      const nextWorkspaces = await listWorkspaces(activeUserId);
      setWorkspaceRefreshTick((current) => current + 1);
      const selectedWorkspace = nextWorkspaces.find((workspace) => workspace.name === workspaceName) ?? null;
      if (!selectedWorkspace) {
        const missingWorkspaceFrameKey = `${activeUserId.trim()}:${workspaceName.trim()}`;
        setEmbeddedPaseoFrames((current) =>
          current.filter((entry) => entry.workspaceKey !== missingWorkspaceFrameKey)
        );
        if (currentWorkspaceName === workspaceName) {
          navigate(`/users/${encodeURIComponent(activeUserId)}/workspaces`, { replace: true });
        }
        return;
      }
      navigate(workspaceLink(workspaceName));
    } catch {
      navigate(workspaceLink(workspaceName));
    }
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

  async function handleCreateWorkspace(event?: React.FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    const trimmedName = newWorkspaceName.trim();
    const nextStartAfterCreate = startAfterCreate;
    const nextDefaultDockerOnly = defaultDockerOnly;
    if (!activeUserId || !trimmedName || creatingWorkspace) {
      return;
    }
    if (createWorkspaceNameError) {
      setCreateWorkspaceError(createWorkspaceNameError);
      return;
    }
    if ((sidebarWorkspaces ?? []).some((entry) => entry.name === trimmedName)) {
      setCreateWorkspaceError(t("workspace_name_taken"));
      return;
    }
    setCreatingWorkspace(true);
    setCreateWorkspaceError(null);
    try {
      await createWorkspace(activeUserId, trimmedName, {
        defaultDockerOnly: nextDefaultDockerOnly,
        startAfterCreate: nextStartAfterCreate,
      });
      setCreateWorkspaceOpen(false);
      resetCreateWorkspaceForm();
      setWorkspaceRefreshTick((current) => current + 1);
      navigate(
        `/users/${encodeURIComponent(activeUserId)}/workspaces/${encodeURIComponent(trimmedName)}`,
      );
    } catch (error) {
      setCreateWorkspaceError(formatActionError(error, t));
    } finally {
      setCreatingWorkspace(false);
    }
  }

  const activeUserInitial = (activeUser?.name || activeUser?.id || "?")
    .trim()
    .charAt(0)
    .toUpperCase();
  const activeUserName = activeUser?.name || activeUser?.id || t("manage_users");
  const isWorkspaceSection = isWorkspaceRoute || location.pathname === userWorkspaceIndexLink();
  const workspaceHeaderSubtitle = sidebarWorkspacesLoading
    ? ""
    : currentWorkspaceName
      ? currentWorkspaceName
      : (sidebarWorkspaces?.length ?? 0) === 0
        ? t("no_workspace_for_user")
        : t("workspace_header_empty");
  const currentPaneTitle = location.pathname.includes("/admin")
    ? t("administration")
    : location.pathname.includes("/credentials")
      ? t("credentials")
    : location.pathname.includes("/settings")
      ? t("settings_title")
    : isWorkspaceSection
        ? workspaceHeaderSubtitle
        : t("app_name");
  const shellContextValue: PortalShellContextValue = {
    activeUserId,
    workspaces: sidebarWorkspaces ?? [],
    workspacesLoading: sidebarWorkspacesLoading,
    workspacesError: sidebarWorkspacesError,
    openCreateWorkspaceDialog,
    refreshWorkspaces: () => {
      setWorkspaceRefreshTick((current) => current + 1);
    },
    sidebarPollingWorkspaceKeys,
    setSidebarWorkspacePolling: (workspaceKey, polling) => {
      setSidebarPollingWorkspaceKeys((current) => {
        const hasKey = current.includes(workspaceKey);
        if (polling) {
          return hasKey ? current : [...current, workspaceKey];
        }
        return hasKey ? current.filter((entry) => entry !== workspaceKey) : current;
      });
    },
    embeddedPaseoFrames,
    cacheEmbeddedPaseoFrame: (workspaceKey, src) => {
      setEmbeddedPaseoFrames((current) => {
        const existingIndex = current.findIndex((entry) => entry.workspaceKey === workspaceKey);
        if (existingIndex === -1) {
          return [...current, { workspaceKey, src, loaded: false }];
        }
        const existing = current[existingIndex];
        if (existing?.src === src) {
          return current;
        }
        return current.map((entry, index) =>
          index === existingIndex
            ? { ...entry, src, loaded: false }
            : entry,
        );
      });
    },
    removeEmbeddedPaseoFrame: (workspaceKey) => {
      setEmbeddedPaseoFrames((current) =>
        current.filter((entry) => entry.workspaceKey !== workspaceKey)
      );
    },
  };

  useEffect(() => {
    setEmbeddedPaseoFrames([]);
    setSidebarPollingWorkspaceKeys([]);
  }, [activeUserId]);

  useEffect(() => {
    if (!activeUserId || !sidebarWorkspaces) {
      return;
    }
    const knownWorkspaceKeys = sidebarWorkspaces.map(
      (workspace) => `${activeUserId.trim()}:${workspace.name.trim()}`,
    );
    const nextSources: Array<{ workspaceKey: string; src: string }> = [];
    for (const workspace of sidebarWorkspaces) {
      const workspaceKey = `${activeUserId.trim()}:${workspace.name.trim()}`;
      const scope = workspacePaseoScope(activeUserId, workspace.name);
      const src = workspace.reconnectTarget
        ?? normalizePaseoPortalUrl(workspace.liveTarget, scope);
      if (src) {
        nextSources.push({ workspaceKey, src });
      }
    }
    setEmbeddedPaseoFrames((current) =>
      mergeEmbeddedPaseoFrames(current, knownWorkspaceKeys, nextSources)
    );
  }, [activeUserId, sidebarWorkspaces]);

  useEffect(() => {
    if (
      !activeUserId
      || !currentWorkspaceName
      || sidebarWorkspacesLoading
      || !sidebarWorkspaces
    ) {
      return;
    }
    const workspaceStillExists = sidebarWorkspaces.some(
      (workspace) => workspace.name === currentWorkspaceName,
    );
    if (workspaceStillExists) {
      return;
    }
    navigate(`/users/${encodeURIComponent(activeUserId)}/workspaces`, { replace: true });
  }, [
    activeUserId,
    currentWorkspaceName,
    navigate,
    sidebarWorkspaces,
    sidebarWorkspacesLoading,
  ]);

  return (
    <PortalShellContext.Provider value={shellContextValue}>
      <>
        <Sidebar collapsible="offcanvas">
        <SidebarHeader className="p-4">
          <Link
            to={activeUserId ? userWorkspaceIndexLink() : "/"}
            onClick={handleSidebarNavigate}
            className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-lg outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2"
          >
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
              P
            </div>
            <div className="grid min-w-0 gap-0.5">
              <div className="truncate text-sm font-medium leading-none">{t("app_name")}</div>
              <div className="truncate text-xs text-muted-foreground">{t("sidebar_tier")}</div>
            </div>
          </Link>
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
                    <SidebarMenuButton onClick={openCreateWorkspaceDialog}>
                      <PlusCircle />
                      <span>{t("add_workspace")}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  {sidebarWorkspacesLoading && !sidebarWorkspaces && (
                    <div className="flex items-center justify-center px-2 py-3 text-muted-foreground">
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    </div>
                  )}
                  {!sidebarWorkspacesLoading && sidebarWorkspacesError && (
                    <div className="px-2 py-3 text-sm text-destructive">
                      {sidebarWorkspacesError}
                    </div>
                  )}
                  {sidebarWorkspaces?.map((workspace) => {
                    const active = currentWorkspaceName === workspace.name;
                    const workspaceKey = `${activeUserId.trim()}:${workspace.name.trim()}`;
                    const sidebarPolling = sidebarPollingWorkspaceKeys.includes(workspaceKey);
                    const backendLiveness = workspace.status?.health?.backendLiveness ?? null;
                    const sidebarStatusLabel = translateWorkspaceLiveness(backendLiveness, t);
                    return (
                      <SidebarMenuItem key={workspace.name}>
                        <SidebarMenuButton asChild isActive={active} tooltip={workspace.name}>
                          <Link
                            to={workspaceLink(workspace.name)}
                            onClick={(event) => void handleWorkspaceSelect(event, workspace.name)}
                          >
                            <FolderKanban />
                            <span className="truncate">{workspace.name}</span>
                            <span
                              className={`ml-auto h-2.5 w-2.5 shrink-0 rounded-full ${workspaceSidebarStatusDotClass(backendLiveness)}`}
                              title={sidebarStatusLabel}
                              aria-label={sidebarStatusLabel}
                            />
                            {sidebarPolling ? (
                              <RefreshCw className="ml-2 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                            ) : null}
                          </Link>
                        </SidebarMenuButton>
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
                      <Link
                        to={`/users/${encodeURIComponent(activeUser.id)}/admin`}
                        onClick={handleSidebarNavigate}
                      >
                        <CircleUser />
                        <span>{t("manage_users")}</span>
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
                    <DropdownMenuItem asChild>
                      <Link
                        to={`/users/${encodeURIComponent(activeUser.id)}/credentials`}
                        onClick={handleSidebarNavigate}
                      >
                        <Link2 className="mr-2 h-4 w-4" />
                        {t("credentials")}
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        clerk.openUserProfile();
                      }}
                    >
                      <CircleUser className="mr-2 h-4 w-4" />
                      {t("menu_account")}
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link
                        to={`/users/${encodeURIComponent(activeUser.id)}/settings`}
                        onClick={handleSidebarNavigate}
                      >
                        <Settings2 className="mr-2 h-4 w-4" />
                        {t("settings")}
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => {
                        void clerk.signOut({ redirectUrl: clerkSignInUrl() });
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
          <header className="flex min-h-16 shrink-0 items-center gap-3 border-b bg-background px-4 py-3">
            <SidebarTrigger />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">
                {currentPaneTitle}
              </div>
            </div>
          </header>
          {embeddedPaseoFrames.length > 0 ? (
            <div
              className={currentWorkspacePane === "" && activeSidebarWorkspaceAllowsEmbeddedPaseo && activeEmbeddedPaseoFrameLoaded
                ? "-mx-4 -my-4 relative flex min-h-0 flex-1 overflow-hidden p-4 sm:-mx-6 sm:-my-6 sm:p-6"
                : "pointer-events-none absolute inset-0 overflow-hidden opacity-0"}
              aria-hidden={currentWorkspacePane === "" && activeSidebarWorkspaceAllowsEmbeddedPaseo && activeEmbeddedPaseoFrameLoaded ? undefined : true}
            >
          {embeddedPaseoFrames.map((frame) => {
            return (
              <iframe
                key={frame.workspaceKey}
                title={`${frame.workspaceKey} paseo`}
                src={frame.src}
                onLoad={() => {
                  setEmbeddedPaseoFrames((current) =>
                    current.map((entry) =>
                      entry.workspaceKey === frame.workspaceKey
                        ? { ...entry, loaded: true }
                        : entry
                    )
                  );
                }}
                className={frame.workspaceKey === activeFrameKey
                  ? "absolute inset-4 h-[calc(100%-2rem)] w-[calc(100%-2rem)] border-0 sm:inset-6 sm:h-[calc(100%-3rem)] sm:w-[calc(100%-3rem)]"
                  : "absolute inset-4 h-[calc(100%-2rem)] w-[calc(100%-2rem)] border-0 opacity-0 pointer-events-none sm:inset-6 sm:h-[calc(100%-3rem)] sm:w-[calc(100%-3rem)]"}
              />
            );
              })}
            </div>
          ) : null}
          <div
            className={currentWorkspaceName && currentWorkspacePane === "" && activeSidebarWorkspaceAllowsEmbeddedPaseo && activeEmbeddedPaseoFrameLoaded
              ? "hidden"
              : "flex min-h-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6"}
          >
            {shouldShowEmbeddedPaseoLoading ? (
              <div className="flex min-h-[40dvh] w-full items-center justify-center">
                <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : null}
            <div className={shouldShowEmbeddedPaseoLoading ? "hidden" : "contents"}>
            {props.children}
            </div>
          </div>
        </SidebarInset>
        {isMobile ? (
          <Sheet
            open={createWorkspaceOpen}
            onOpenChange={handleCreateWorkspaceOpenChange}
          >
            <SheetContent side="bottom" className="max-h-[92dvh] overflow-y-auto">
              <SheetHeader>
                <SheetTitle>{t("add_workspace")}</SheetTitle>
                <SheetDescription>{t("add_workspace_desc")}</SheetDescription>
              </SheetHeader>
              <form
                className="grid gap-4 py-4"
                onSubmit={(event) => void handleCreateWorkspace(event)}
              >
                <div className="grid gap-2">
                  <Label htmlFor="new-workspace-name-mobile">{t("workspace_name")}</Label>
                  <Input
                    id="new-workspace-name-mobile"
                    value={newWorkspaceName}
                    onChange={(event) => {
                      setNewWorkspaceName(event.target.value);
                      setCreateWorkspaceError(null);
                    }}
                    placeholder={t("workspace_example")}
                    autoComplete="off"
                    disabled={creatingWorkspace}
                  />
                  {newWorkspaceName.trim() && createWorkspaceNameError ? (
                    <p className="text-sm text-destructive">{createWorkspaceNameError}</p>
                  ) : null}
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
                  <p className="text-sm text-muted-foreground">{t("provisioning")}</p>
                )}
                {createWorkspaceError && (
                  <p className="text-sm text-destructive">{createWorkspaceError}</p>
                )}
                <SheetFooter className="gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => handleCreateWorkspaceOpenChange(false)}
                    disabled={creatingWorkspace}
                  >
                    {t("cancel")}
                  </Button>
                  <Button
                    type="submit"
                    disabled={!canSubmitCreateWorkspace}
                  >
                    {creatingWorkspace ? t("provisioning") : t("create_workspace")}
                  </Button>
                </SheetFooter>
              </form>
            </SheetContent>
          </Sheet>
        ) : (
          <AlertDialog
            open={createWorkspaceOpen}
            onOpenChange={handleCreateWorkspaceOpenChange}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("add_workspace")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("add_workspace_desc")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <form
                className="grid gap-4"
                onSubmit={(event) => void handleCreateWorkspace(event)}
              >
                <div className="grid gap-2">
                  <Label htmlFor="new-workspace-name">{t("workspace_name")}</Label>
                  <Input
                    id="new-workspace-name"
                    value={newWorkspaceName}
                    onChange={(event) => {
                      setNewWorkspaceName(event.target.value);
                      setCreateWorkspaceError(null);
                    }}
                    placeholder={t("workspace_example")}
                    autoComplete="off"
                    disabled={creatingWorkspace}
                  />
                  {newWorkspaceName.trim() && createWorkspaceNameError ? (
                    <p className="text-sm text-destructive">{createWorkspaceNameError}</p>
                  ) : null}
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
                  <p className="text-sm text-muted-foreground">{t("provisioning")}</p>
                )}
                {createWorkspaceError && (
                  <p className="text-sm text-destructive">{createWorkspaceError}</p>
                )}
                <AlertDialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => handleCreateWorkspaceOpenChange(false)}
                    disabled={creatingWorkspace}
                  >
                    {t("cancel")}
                  </Button>
                  <Button
                    type="submit"
                    disabled={!canSubmitCreateWorkspace}
                  >
                    {creatingWorkspace ? t("provisioning") : t("create_workspace")}
                  </Button>
                </AlertDialogFooter>
              </form>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </>
    </PortalShellContext.Provider>
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
  const navigate = useNavigate();
  const { user } = useUser();
  const {
    data: backendSession,
    loading: backendSessionLoading,
  } = useAsyncValue<PortalSession | null>(
    () => getPortalSession(),
    [],
  );
  const {
    clerkUsername,
    clerkUserId,
    mapping,
    mappingError,
    mappingLoading,
  } = useCurrentUserMapping();
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const registrationStartedRef = useRef(false);
  const canSelfRegister =
    Boolean(clerkUsername || clerkUserId || backendSession?.clerkUsername || backendSession?.clerkUserId);

  const explicitMappedUserId = mapping?.polarisUserId ?? null;
  const nextPolarisUserId = resolvePolarisProfileIdCandidate(user)
    || backendSession?.clerkUsername
    || backendSession?.clerkUserId
    || "";
  const resolvingAccess =
    backendSessionLoading
    || mappingLoading
    || (!explicitMappedUserId
      && !mappingError
      && !registrationError
      && canSelfRegister
      && !registering);

  useEffect(() => {
    if (
      !canSelfRegister
      || !nextPolarisUserId
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
      userProfileId: nextPolarisUserId,
      ...(clerkUsername ? { clerkUsername } : {}),
      ...(clerkUserId ? { clerkUserId } : {}),
      ...(!clerkUsername && backendSession?.clerkUsername
        ? { clerkUsername: backendSession.clerkUsername }
        : {}),
      ...(!clerkUserId && backendSession?.clerkUserId
        ? { clerkUserId: backendSession.clerkUserId }
        : {}),
      ...(user?.primaryEmailAddress?.emailAddress?.trim()
        ? { email: user.primaryEmailAddress.emailAddress.trim() }
        : {}),
      name:
        user?.fullName?.trim()
        || user?.username?.trim()
        || clerkUsername
        || backendSession?.clerkUsername
        || backendSession?.clerkUserId
        || nextPolarisUserId,
      role: "user",
      plan: "free",
    })
      .then((created) => {
        navigate(`/users/${encodeURIComponent(created.id)}/workspaces`, { replace: true });
      })
      .catch((cause: unknown) => {
        registrationStartedRef.current = false;
        setRegistrationError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        setRegistering(false);
      });
  }, [
    canSelfRegister,
    clerkUsername,
    clerkUserId,
    explicitMappedUserId,
    backendSession,
    mappingError,
    mappingLoading,
    navigate,
    nextPolarisUserId,
    user,
  ]);

  if (explicitMappedUserId) {
    return <Navigate to={`/users/${encodeURIComponent(explicitMappedUserId)}/workspaces`} replace />;
  }

  if (resolvingAccess) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-background px-4 py-8">
        <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
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

function PortalLayout() {
  const { data: users } = useAsyncValue(listUsers, []);
  return (
    <PortalShell users={users ?? []}>
      <Outlet />
    </PortalShell>
  );
}

function WorkspaceIndexPage() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { userId = "" } = useParams();
  return (
    <WorkspaceIndexContent
      userId={userId}
      onOpenCredentials={() => {
        navigate(`/users/${encodeURIComponent(userId)}/credentials`);
      }}
    />
  );
}

function WorkspaceIndexContent(props: {
  userId: string;
  onOpenCredentials: () => void;
}) {
  const { t } = useLanguage();
  const { workspaces, workspacesLoading, workspacesError } = usePortalShell();

  if (workspacesLoading) {
    return null;
  }

  if (workspacesError) {
    return (
      <div className="flex min-h-[40dvh] w-full items-center justify-center">
        <div className="text-sm text-destructive">{workspacesError}</div>
      </div>
    );
  }

  if (workspaces.length > 0) {
    return (
      <Navigate
        to={`/users/${encodeURIComponent(props.userId)}/workspaces/${encodeURIComponent(workspaces[0].name)}`}
        replace
      />
    );
  }

  return (
    <WorkspaceEmptyState
      title={t("workspace_empty_title")}
      descriptionLines={[
        t("workspace_empty_description_line_1"),
        t("workspace_empty_description_line_2"),
        t("workspace_empty_description_line_3"),
      ]}
      onOpenCredentials={props.onOpenCredentials}
    />
  );
}

function WorkspaceEmptyState(props: {
  title: string;
  descriptionLines: string[];
  onOpenCredentials: () => void;
}) {
  const { t } = useLanguage();
  const {
    workspaces,
    workspacesLoading,
    workspacesError,
    openCreateWorkspaceDialog,
  } = usePortalShell();

  if (workspacesLoading) {
    return (
      <div className="flex min-h-[40dvh] w-full items-center justify-center">
        <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (workspaces.length > 0) {
    return <div className="min-h-[40dvh]" />;
  }

  if (workspacesError) {
    return (
      <div className="flex min-h-[40dvh] w-full items-center justify-center">
        <div className="text-sm text-destructive">{workspacesError}</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[60dvh] w-full items-center justify-center">
      <div className="grid w-full max-w-2xl gap-6 rounded-[1.75rem] border border-border bg-card p-6 shadow-sm sm:p-8">
        <div className="grid gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{props.title}</h1>
          <div className="grid gap-2 text-sm leading-6 text-muted-foreground">
            {props.descriptionLines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button onClick={openCreateWorkspaceDialog}>
            {t("workspace_empty_create")}
          </Button>
          <Button variant="outline" onClick={props.onOpenCredentials}>
            {t("workspace_empty_credentials")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AdminPage() {
  const { t } = useLanguage();
  const { userId = "" } = useParams();
  const navigate = useNavigate();
  const [reloadKey, setReloadKey] = useState(0);
  const { data: users } = useAsyncValue(listUsers, [reloadKey]);
  const { data: adminUsers, error: adminUsersError, loading: adminUsersLoading } = useAsyncValue(
    listAdminUsers,
    [reloadKey],
  );
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [adminActionError, setAdminActionError] = useState<string | null>(null);
  const [workspaceAdminActionError, setWorkspaceAdminActionError] = useState<string | null>(null);
  const [paseoDiagnostics, setPaseoDiagnostics] = useState<Record<string, PortalWorkspacePaseoDiagnostic | undefined>>({});
  const [paseoActionState, setPaseoActionState] = useState<Record<string, "loading" | "restarting">>({});
  const [workspaceActionState, setWorkspaceActionState] = useState<
    Record<string, "start" | "stop" | "archive" | "delete-archive">
  >({});
  const { mapping, mappingLoading, mappingError } = useCurrentUserMapping();
  const [selectedAdminUserId, setSelectedAdminUserId] = useState(userId);
  const [adminTab, setAdminTab] = useState<"user" | "credentials" | "workspaces" | "paseo">("user");
  const selectedAdminUser = adminUsers?.find((entry) => entry.id === selectedAdminUserId) ?? null;
  const {
    data: selectedProfile,
    error: selectedProfileError,
    loading: selectedProfileLoading,
  } = useAsyncValue(
    () => selectedAdminUserId ? getUserProfile(selectedAdminUserId) : Promise.resolve(null),
    [selectedAdminUserId, reloadKey],
  );
  const {
    data: selectedCredentials,
    error: selectedCredentialsError,
    loading: selectedCredentialsLoading,
  } = useAsyncValue(
    () => selectedAdminUserId ? listCredentials(selectedAdminUserId) : Promise.resolve([]),
    [selectedAdminUserId, reloadKey],
  );
  const {
    data: selectedWorkspaces,
    error: selectedWorkspacesError,
    loading: selectedWorkspacesLoading,
  } = useAsyncValue(
    () => selectedAdminUserId ? listWorkspaces(selectedAdminUserId) : Promise.resolve([]),
    [selectedAdminUserId, reloadKey],
  );
  const {
    data: selectedArchivedWorkspaces,
    error: selectedArchivedWorkspacesError,
    loading: selectedArchivedWorkspacesLoading,
  } = useAsyncValue(
    () => selectedAdminUserId ? listArchivedWorkspaces(selectedAdminUserId) : Promise.resolve([]),
    [selectedAdminUserId, reloadKey],
  );

  useEffect(() => {
    if (!adminUsers?.length) {
      return;
    }
    const hasSelection = adminUsers.some((entry) => entry.id === selectedAdminUserId);
    if (hasSelection) {
      return;
    }
    const fallbackUserId = adminUsers.some((entry) => entry.id === userId)
      ? userId
      : adminUsers[0]?.id;
    if (fallbackUserId) {
      setSelectedAdminUserId(fallbackUserId);
    }
  }, [adminUsers, selectedAdminUserId, userId]);

  useEffect(() => {
    setPaseoDiagnostics({});
    setPaseoActionState({});
    setAdminTab("user");
  }, [selectedAdminUserId]);

  if (mappingLoading) {
    return (
      <div className="flex w-full items-center justify-center py-6">
        <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (mappingError) {
    return (
      <div className="grid w-full gap-6">
        <p className="text-sm text-destructive">{mappingError}</p>
      </div>
    );
  }

  if (!mapping || mapping.role !== "admin") {
    return <Navigate to={`/users/${encodeURIComponent(userId)}/workspaces`} replace />;
  }

  function setWorkspaceAction(
    target: string,
    kind: "start" | "stop" | "archive" | "delete-archive",
  ): void {
    setWorkspaceActionState((current) => ({
      ...current,
      [target]: kind,
    }));
  }

  function clearWorkspaceAction(target: string): void {
    setWorkspaceActionState((current) => {
      if (!(target in current)) {
        return current;
      }
      const next = { ...current };
      delete next[target];
      return next;
    });
  }

  async function handleDeleteUser(targetUserId: string): Promise<void> {
    if (savingUserId) {
      return;
    }
    setSavingUserId(targetUserId);
    setAdminActionError(null);
    try {
      await deletePortalUser(targetUserId);
      const nextUsers = (users ?? []).filter((entry) => entry.id !== targetUserId);
      setReloadKey((current) => current + 1);
      if (targetUserId === selectedAdminUserId) {
        const fallbackUserId = nextUsers.some((entry) => entry.id === userId)
          ? userId
          : nextUsers[0]?.id;
        if (fallbackUserId) {
          setSelectedAdminUserId(fallbackUserId);
        } else if (targetUserId === userId) {
          navigate("/", { replace: true });
        }
      } else if (targetUserId === userId && nextUsers.length === 0) {
        navigate("/", { replace: true });
      }
    } catch (error) {
      setAdminActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingUserId(null);
    }
  }

  async function handleArchiveWorkspace(workspaceName: string): Promise<void> {
    if (!selectedAdminUser) {
      return;
    }
    setWorkspaceAction(workspaceName, "archive");
    setWorkspaceAdminActionError(null);
    try {
      await deleteWorkspace(selectedAdminUser.id, workspaceName);
      setReloadKey((current) => current + 1);
    } catch (error) {
      setWorkspaceAdminActionError(formatActionError(error, t));
    } finally {
      clearWorkspaceAction(workspaceName);
    }
  }

  async function handleStopAdminWorkspace(workspaceName: string): Promise<void> {
    if (!selectedAdminUser) {
      return;
    }
    setWorkspaceAction(workspaceName, "stop");
    setWorkspaceAdminActionError(null);
    try {
      await stopWorkspace(selectedAdminUser.id, workspaceName);
      await refreshWorkspaceStatus(selectedAdminUser.id, workspaceName);
      setReloadKey((current) => current + 1);
    } catch (error) {
      setWorkspaceAdminActionError(formatActionError(error, t));
    } finally {
      clearWorkspaceAction(workspaceName);
    }
  }

  async function handleStartAdminWorkspace(workspaceName: string): Promise<void> {
    if (!selectedAdminUser) {
      return;
    }
    setWorkspaceAction(workspaceName, "start");
    setWorkspaceAdminActionError(null);
    try {
      await startWorkspace(selectedAdminUser.id, workspaceName);
      await refreshWorkspaceStatus(selectedAdminUser.id, workspaceName);
      setReloadKey((current) => current + 1);
    } catch (error) {
      setWorkspaceAdminActionError(formatActionError(error, t));
    } finally {
      clearWorkspaceAction(workspaceName);
    }
  }

  async function handleDeleteArchivedWorkspace(archiveId: string): Promise<void> {
    if (!selectedAdminUser) {
      return;
    }
    setWorkspaceAction(archiveId, "delete-archive");
    setWorkspaceAdminActionError(null);
    try {
      await deleteArchivedWorkspace(selectedAdminUser.id, archiveId);
      setReloadKey((current) => current + 1);
    } catch (error) {
      setWorkspaceAdminActionError(formatActionError(error, t));
    } finally {
      clearWorkspaceAction(archiveId);
    }
  }

  async function handleLoadPaseoDiagnostic(workspaceName: string): Promise<void> {
    if (!selectedAdminUser) {
      return;
    }
    setPaseoActionState((current) => ({ ...current, [workspaceName]: "loading" }));
    setWorkspaceAdminActionError(null);
    try {
      const diagnostic = await getWorkspacePaseoDiagnostic(selectedAdminUser.id, workspaceName);
      setPaseoDiagnostics((current) => ({ ...current, [workspaceName]: diagnostic }));
    } catch (error) {
      setWorkspaceAdminActionError(formatActionError(error, t));
    } finally {
      setPaseoActionState((current) => {
        const next = { ...current };
        delete next[workspaceName];
        return next;
      });
    }
  }

  async function handleRestartPaseoDaemon(workspaceName: string): Promise<void> {
    if (!selectedAdminUser) {
      return;
    }
    setPaseoActionState((current) => ({ ...current, [workspaceName]: "restarting" }));
    setWorkspaceAdminActionError(null);
    try {
      const result = await restartWorkspacePaseoDaemon(selectedAdminUser.id, workspaceName);
      setPaseoDiagnostics((current) => ({ ...current, [workspaceName]: result.diagnostic }));
    } catch (error) {
      setWorkspaceAdminActionError(formatActionError(error, t));
    } finally {
      setPaseoActionState((current) => {
        const next = { ...current };
        delete next[workspaceName];
        return next;
      });
    }
  }

  const selectedMappings = selectedAdminUser
    ? [...selectedAdminUser.clerkUsernames, ...selectedAdminUser.clerkUserIds]
    : [];

  return (
    <div className="grid w-full gap-6 lg:grid-cols-[21rem_minmax(0,1fr)]">
      <div className="grid gap-4">
        <Card className="border-border/70 lg:sticky lg:top-4">
          <CardHeader className="gap-1">
            <CardTitle className="text-base">{t("admin_user_directory")}</CardTitle>
            <CardDescription>{t("administration_desc")}</CardDescription>
          </CardHeader>
          <CardContent className="grid max-h-[calc(100vh-10rem)] gap-2 overflow-y-auto">
            {adminUsersLoading ? (
              <div className="flex items-center justify-center py-4 text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin" />
              </div>
            ) : null}
            {adminUsersError ? (
              <p className="text-sm text-destructive">{adminUsersError}</p>
            ) : null}
            {!adminUsersLoading && !adminUsersError && (adminUsers?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">{t("admin_user_empty")}</p>
            ) : null}
            {adminUsers?.map((entry) => {
              const active = entry.id === selectedAdminUserId;
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setSelectedAdminUserId(entry.id)}
                  className={active
                    ? "box-border grid w-full min-w-0 gap-2 rounded-2xl border border-border bg-muted/40 px-3 py-3 text-left"
                    : "box-border grid w-full min-w-0 gap-2 rounded-2xl border border-border/60 bg-white px-3 py-3 text-left hover:bg-muted/20"}
                >
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {entry.name || entry.id}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {entry.id}
                      </div>
                    </div>
                    <Badge className="shrink-0" variant={entry.role === "admin" ? "default" : "secondary"}>
                      {entry.role}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span>{entry.credentialCount} {t("credentials")}</span>
                    <span>{entry.workspaces.length} {t("tracked_workspaces")}</span>
                    <span>{entry.archivedWorkspaceCount} {t("admin_user_archives")}</span>
                  </div>
                </button>
              );
            })}
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-6">
        <div className="grid gap-4">
          <ErrorPopup
            title={t("global_error_title")}
            message={adminActionError}
            onClose={() => setAdminActionError(null)}
          />
          {!selectedAdminUser ? (
            <Card className="border-border/70">
              <CardContent className="py-10">
                <p className="text-sm text-muted-foreground">{t("admin_user_empty")}</p>
              </CardContent>
            </Card>
          ) : (
            <Tabs
              key={selectedAdminUserId}
              value={adminTab}
              onValueChange={(value) => setAdminTab(value as "user" | "credentials" | "workspaces" | "paseo")}
              className="w-full"
            >
              <TabsList className="mb-4 w-full max-w-md justify-start rounded-2xl border border-border/70 bg-muted/20 p-1">
                <TabsTrigger value="user" className="flex-1 rounded-xl">
                  {t("admin_user_tab_user")}
                </TabsTrigger>
                <TabsTrigger value="credentials" className="flex-1 rounded-xl">
                  {t("admin_user_tab_credentials")}
                </TabsTrigger>
                <TabsTrigger value="workspaces" className="flex-1 rounded-xl">
                  {t("admin_user_tab_workspaces")}
                </TabsTrigger>
                <TabsTrigger value="paseo" className="flex-1 rounded-xl">
                  {t("admin_user_tab_paseo")}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="user">
                <Card className="border-border/70">
                  <CardHeader className="gap-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <CardTitle className="truncate text-xl">
                          {selectedAdminUser.name || selectedAdminUser.id}
                        </CardTitle>
                        <CardDescription className="truncate">
                          {selectedAdminUser.id}
                        </CardDescription>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant={selectedAdminUser.role === "admin" ? "default" : "secondary"}>
                          {selectedAdminUser.role}
                        </Badge>
                        <Badge
                          variant={selectedAdminUser.integrityStatus === "ok" ? "secondary" : "outline"}
                        >
                          {translateAdminIntegrityStatus(selectedAdminUser.integrityStatus, t)}
                        </Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="grid gap-6">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
                        <div className="text-xs text-muted-foreground">{t("tracked_workspaces")}</div>
                        <div className="mt-1 text-2xl font-semibold">
                          {selectedWorkspaces?.length ?? selectedAdminUser.workspaces.length}
                        </div>
                      </div>
                      <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
                        <div className="text-xs text-muted-foreground">{t("credentials")}</div>
                        <div className="mt-1 text-2xl font-semibold">
                          {selectedCredentials?.length ?? selectedAdminUser.credentialCount}
                        </div>
                      </div>
                      <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
                        <div className="text-xs text-muted-foreground">{t("admin_user_archives")}</div>
                        <div className="mt-1 text-2xl font-semibold">
                          {selectedArchivedWorkspaces?.length ?? selectedAdminUser.archivedWorkspaceCount}
                        </div>
                      </div>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="grid gap-1">
                        <div className="text-xs text-muted-foreground">{t("admin_user_email")}</div>
                        <div className="text-sm">
                          {selectedProfile?.email || selectedAdminUser.email || t("none")}
                        </div>
                      </div>
                      <div className="grid gap-1">
                        <div className="text-xs text-muted-foreground">{t("admin_user_github")}</div>
                        <div className="text-sm">{selectedProfile?.githubAccount || t("none")}</div>
                      </div>
                      <div className="grid gap-1">
                        <div className="text-xs text-muted-foreground">{t("admin_user_ssh_mode")}</div>
                        <div className="text-sm">{selectedProfile?.sshMode || t("none")}</div>
                      </div>
                      <div className="grid gap-1">
                        <div className="text-xs text-muted-foreground">{t("admin_user_recent_mappings")}</div>
                        <div className="text-sm text-muted-foreground break-all">
                          {selectedMappings.length > 0 ? selectedMappings.join(", ") : t("admin_no_mapping")}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="destructive"
                            disabled={savingUserId === selectedAdminUser.id}
                          >
                            {savingUserId === selectedAdminUser.id ? t("admin_deleting") : t("admin_delete_user")}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t("admin_delete_user_confirm_title")}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {t("admin_delete_user_confirm_description")}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                            <AlertDialogAction onClick={() => void handleDeleteUser(selectedAdminUser.id)}>
                              {savingUserId === selectedAdminUser.id ? t("admin_deleting") : t("admin_delete_user")}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                    {selectedProfileLoading ? (
                      <div className="flex items-center justify-center py-2 text-muted-foreground">
                        <RefreshCw className="h-4 w-4 animate-spin" />
                      </div>
                    ) : null}
                      <ErrorPopup title={t("global_error_title")} message={selectedProfileError} />
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="credentials">
                <Card className="border-border/70">
                  <CardHeader className="flex flex-row items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-base">{t("admin_user_credentials_section")}</CardTitle>
                      <CardDescription>{t("credentials_for_user")}</CardDescription>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => navigate(`/users/${encodeURIComponent(selectedAdminUser.id)}/credentials`)}
                    >
                      {t("admin_manage_credentials")}
                    </Button>
                  </CardHeader>
                  <CardContent className="grid gap-3">
                    {selectedCredentialsLoading ? (
                      <div className="flex items-center justify-center py-4 text-muted-foreground">
                        <RefreshCw className="h-4 w-4 animate-spin" />
                      </div>
                    ) : null}
                      <ErrorPopup title={t("global_error_title")} message={selectedCredentialsError} />
                    {!selectedCredentialsLoading && !selectedCredentialsError && (selectedCredentials?.length ?? 0) === 0 ? (
                      <p className="text-sm text-muted-foreground">{t("admin_credentials_empty")}</p>
                    ) : null}
                    {selectedCredentials?.map((credential) => (
                      <div
                        key={credential.id}
                        className="grid gap-2 rounded-2xl border border-border/70 bg-muted/20 p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{credential.label}</div>
                            <div className="truncate text-xs text-muted-foreground">
                              {credential.providerName || credential.kind}
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {credential.active ? <Badge>{t("active")}</Badge> : null}
                            <Badge variant="outline">{credential.harness || credential.kind}</Badge>
                          </div>
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {credential.purposes.join(", ") || t("none")}
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="workspaces">
                <div className="grid gap-6">
                  <ErrorPopup
                    title={t("global_error_title")}
                    message={workspaceAdminActionError}
                    onClose={() => setWorkspaceAdminActionError(null)}
                  />
                  <Card className="border-border/70">
                    <CardHeader>
                      <div>
                        <CardTitle className="text-base">{t("admin_user_workspace_section")}</CardTitle>
                        <CardDescription>{t("admin_manage_workspaces")}</CardDescription>
                      </div>
                    </CardHeader>
                    <CardContent className="grid gap-3">
                      {selectedWorkspacesLoading ? (
                        <div className="flex items-center justify-center py-4 text-muted-foreground">
                          <RefreshCw className="h-4 w-4 animate-spin" />
                        </div>
                      ) : null}
                      <ErrorPopup title={t("global_error_title")} message={selectedWorkspacesError} />
                      {!selectedWorkspacesLoading && !selectedWorkspacesError && (selectedWorkspaces?.length ?? 0) === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("admin_workspace_empty")}</p>
                      ) : null}
                      {selectedWorkspaces?.map((workspace) => (
                        <div
                          key={workspace.name}
                          className="grid gap-3 rounded-2xl border border-border/70 bg-muted/20 p-4"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium">{workspace.name}</div>
                              <div className="text-sm text-muted-foreground">
                                {translateWorkspaceLiveness(
                                  workspace.status?.health?.backendLiveness,
                                  t,
                                )}
                              </div>
                            </div>
                            <Badge variant="outline">
                              {driverLabel(workspace.selectedDriver)}
                            </Badge>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={workspace.name in workspaceActionState}
                              onClick={() => void (
                                workspace.status?.health?.backendLiveness === "running"
                                  ? handleStopAdminWorkspace(workspace.name)
                                  : handleStartAdminWorkspace(workspace.name)
                              )}
                            >
                              {workspaceActionState[workspace.name] === "stop"
                                ? t("stopping")
                                : workspaceActionState[workspace.name] === "start"
                                  ? t("starting")
                                  : workspace.status?.health?.backendLiveness === "running"
                                    ? t("stop_workspace")
                                    : t("start_workspace")}
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  disabled={workspace.name in workspaceActionState}
                                >
                                  {workspaceActionState[workspace.name] === "archive"
                                    ? t("deleting")
                                    : t("remove_workspace")}
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
                                  <AlertDialogAction onClick={() => void handleArchiveWorkspace(workspace.name)}>
                                    {t("remove_workspace")}
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                  <Card className="border-border/70">
                    <CardHeader>
                      <CardTitle className="text-base">{t("archived_workspaces")}</CardTitle>
                      <CardDescription>{t("admin_user_archives_section")}</CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-3">
                      {selectedArchivedWorkspacesLoading ? (
                        <div className="flex items-center justify-center py-4 text-muted-foreground">
                          <RefreshCw className="h-4 w-4 animate-spin" />
                        </div>
                      ) : null}
                      <ErrorPopup title={t("global_error_title")} message={selectedArchivedWorkspacesError} />
                      {!selectedArchivedWorkspacesLoading && !selectedArchivedWorkspacesError && (selectedArchivedWorkspaces?.length ?? 0) === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("admin_archive_empty")}</p>
                      ) : null}
                      {selectedArchivedWorkspaces?.map((entry) => (
                        <div
                          key={entry.archiveId}
                          className="grid gap-3 rounded-2xl border border-border/70 bg-muted/20 p-4"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-medium">{entry.workspaceName}</div>
                              <div className="text-xs text-muted-foreground">
                                {entry.archivedAt || t("unknown")}
                              </div>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  disabled={entry.archiveId in workspaceActionState}
                                >
                                  {workspaceActionState[entry.archiveId] === "delete-archive"
                                    ? t("deleting")
                                    : t("admin_delete_archived_workspace")}
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>{t("admin_delete_archived_workspace_confirm_title")}</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    {t("admin_delete_archived_workspace_confirm_description")}
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                                  <AlertDialogAction onClick={() => void handleDeleteArchivedWorkspace(entry.archiveId)}>
                                    {t("admin_delete_archived_workspace")}
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>

              <TabsContent value="paseo">
                <Card className="border-border/70">
                  <CardHeader>
                    <CardTitle className="text-base">{t("admin_user_tab_paseo")}</CardTitle>
                    <CardDescription>{t("paseo_info")}</CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-3">
                    {selectedWorkspacesLoading ? (
                      <div className="flex items-center justify-center py-4 text-muted-foreground">
                        <RefreshCw className="h-4 w-4 animate-spin" />
                      </div>
                    ) : null}
                    <ErrorPopup title={t("global_error_title")} message={selectedWorkspacesError} />
                    {!selectedWorkspacesLoading && !selectedWorkspacesError && (selectedWorkspaces?.length ?? 0) === 0 ? (
                      <p className="text-sm text-muted-foreground">{t("admin_workspace_empty")}</p>
                    ) : null}
                    {selectedWorkspaces?.map((workspace) => (
                      <div key={`paseo-${workspace.name}`} className="grid gap-3 rounded-2xl border border-border/70 bg-muted/20 p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{workspace.name}</div>
                            <div className="text-sm text-muted-foreground">
                              {translateReconnectMode(workspace.reconnectMode, t)}
                            </div>
                          </div>
                          <Badge variant="outline">
                            {driverLabel(workspace.selectedDriver)}
                          </Badge>
                        </div>
                        <div className="grid gap-1">
                          <div className="text-xs text-muted-foreground">
                            {t("admin_paseo_reconnect_mode")}
                          </div>
                          <div className="break-all text-sm">
                            {translateReconnectMode(workspace.reconnectMode, t)}
                          </div>
                        </div>
                        {workspace.reconnectTarget ? (
                          <div className="grid gap-1">
                            <div className="text-xs text-muted-foreground">
                              {t("admin_paseo_reconnect_target")}
                            </div>
                            <div className="break-all text-sm">{workspace.reconnectTarget}</div>
                          </div>
                        ) : null}
                        {workspace.liveTarget && workspace.liveTarget !== workspace.reconnectTarget ? (
                          <div className="grid gap-1">
                            <div className="text-xs text-muted-foreground">
                              {t("admin_paseo_live_target")}
                            </div>
                            <div className="break-all text-sm">{workspace.liveTarget}</div>
                          </div>
                        ) : null}
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={Boolean(paseoActionState[workspace.name])}
                            onClick={() => void handleLoadPaseoDiagnostic(workspace.name)}
                          >
                            {paseoActionState[workspace.name] === "loading"
                              ? t("refreshing")
                              : t("admin_paseo_status_button")}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={Boolean(paseoActionState[workspace.name])}
                            onClick={() => void handleRestartPaseoDaemon(workspace.name)}
                          >
                            {paseoActionState[workspace.name] === "restarting"
                              ? t("admin_paseo_restarting_button")
                              : t("admin_paseo_restart_button")}
                          </Button>
                        </div>
                        {paseoDiagnostics[workspace.name] ? (
                          <>
                            <details className="rounded-xl border border-border/70 bg-background">
                              <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
                                {t("admin_paseo_status_raw")}
                              </summary>
                              <pre className="overflow-x-auto border-t border-border/70 p-3 text-xs leading-5">
                                {paseoDiagnostics[workspace.name]?.daemonStatusRaw}
                              </pre>
                            </details>
                          </>
                        ) : null}
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>
    </div>
  );
}

function ErrorPopup(props: {
  title: string;
  message: string | null;
  onClose?: () => void;
}) {
  const [dismissedMessage, setDismissedMessage] = useState<string | null>(null);
  const open = Boolean(props.message) && props.message !== dismissedMessage;

  useEffect(() => {
    if (!props.message) {
      setDismissedMessage(null);
    }
  }, [props.message]);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen || !props.message) {
          return;
        }
        setDismissedMessage(props.message);
        props.onClose?.();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription className="break-words">
            {props.message}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction
            onClick={() => {
              setDismissedMessage(props.message);
              props.onClose?.();
            }}
          >
            OK
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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

function PaneSpinner() {
  return (
    <div className="flex min-h-[40dvh] w-full items-center justify-center">
      <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

function WorkspaceDetailPage() {
  return <WorkspaceDetailContent />;
}

function WorkspaceDetailContent() {
  const { t } = useLanguage();
  const { userId = "", workspaceName = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const {
    cacheEmbeddedPaseoFrame,
    embeddedPaseoFrames,
    removeEmbeddedPaseoFrame,
    refreshWorkspaces,
    setSidebarWorkspacePolling,
  } = usePortalShell();
  const [refreshTick, setRefreshTick] = useState(0);
  const { data, error, loading } = useAsyncValue(
    () => getWorkspaceDetail(userId, workspaceName),
    [refreshTick, userId, workspaceName],
  );
  const {
    data: credentials,
    error: credentialsError,
    loading: credentialsLoading,
  } = useAsyncValue(
    () => listCredentials(userId),
    [userId],
  );
  const workspaceData = data?.name === workspaceName ? data : null;
  const workspaceLoading = loading || (!!data && !workspaceData);
  const [driver, setDriver] = useState("");
  const [switching, setSwitching] = useState(false);
  const [workspaceAction, setWorkspaceAction] = useState<"starting" | "stopping" | "deleting" | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [paseoCredentialSelections, setPaseoCredentialSelections] = useState<
    Partial<Record<ManagedHarness, string>>
  >({});
  const [actionError, setActionError] = useState<string | null>(null);
  const pathParts = location.pathname.split("/").filter(Boolean);
  const currentPane = pathParts[4] ?? "";
  const assets = workspaceData?.status?.assets;
  const agentCredentials = (credentials ?? []).filter((credential) =>
    credential.purposes.includes("agent-auth")
  );
  const liveStatus = workspaceData?.status?.credentials?.live;
  const liveSelections = liveStatus?.selectedByHarness ?? {};
  const harnessOptions = Array.from(
    new Set(
      [
        ...(liveStatus?.supportedHarnesses ?? []),
        ...agentCredentials.map((credential) => credential.harness ?? "").filter(Boolean),
      ],
    ),
  );
  const paseoHarnesses = MANAGED_HARNESS_ORDER.filter(
    (harness) => harness !== "ssh" && harnessOptions.includes(harness),
  );
  const switchableHarnesses = liveStatus?.switchableHarnesses ?? MANAGED_HARNESS_ORDER;
  const paseoScope = workspacePaseoScope(userId, workspaceName);
  const embeddedPortalUrl = workspaceData?.reconnectTarget ?? workspaceData?.liveTarget ?? null;
  const workspaceFrameKey = `${userId.trim()}:${workspaceName.trim()}`;
  const activeEmbeddedPaseoFrame = embeddedPaseoFrames.find(
    (frame) => frame.workspaceKey === workspaceFrameKey,
  ) ?? null;
  const activeEmbeddedPaseoFrameLoaded = activeEmbeddedPaseoFrame?.loaded === true;
  const hasActiveEmbeddedPaseoFrame = Boolean(activeEmbeddedPaseoFrame);
  const backendLiveness = workspaceData?.status?.health?.backendLiveness ?? null;
  const runtimeRunning = backendLiveness === "running";
  const persistedWorkspaceAction =
    backendLiveness === "starting" || backendLiveness === "creating"
      ? "starting"
      : backendLiveness === "stopping"
        ? "stopping"
        : backendLiveness === "archiving"
          ? "deleting"
          : null;
  const effectiveRuntimeRunning =
    (workspaceAction ?? persistedWorkspaceAction) === "starting"
      ? true
      : (workspaceAction ?? persistedWorkspaceAction) === "stopping"
        || (workspaceAction ?? persistedWorkspaceAction) === "deleting"
        ? false
        : runtimeRunning;
  const effectiveWorkspaceAction = workspaceAction ?? persistedWorkspaceAction;
  const starting = effectiveWorkspaceAction === "starting";
  const stopping = effectiveWorkspaceAction === "stopping";
  const deleting = effectiveWorkspaceAction === "deleting";
  const workspaceActionInFlight = effectiveWorkspaceAction !== null;
  const backendState = workspaceData?.status?.health?.backendLiveness ?? null;
  const waitingForEmbeddedPaseo =
    !deleting
    && !activeEmbeddedPaseoFrameLoaded
    && !embeddedPortalUrl
    && Boolean(workspaceData)
    && (
      backendState === "creating"
      || backendState === "starting"
      || backendState === "running"
    );
  const workspaceStateLabel = deleting
    ? t("deleting")
    : starting
      ? t("workspace_starting")
      : stopping
        ? t("stopping")
        : effectiveRuntimeRunning
          ? t("workspace_ready")
          : t("workspace_not_started");
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
    if (workspaceData?.selectedDriver) {
      setDriver(driverLabel(workspaceData.selectedDriver));
    }
  }, [workspaceData]);

  useEffect(() => {
    if (workspaceLoading && !workspaceData) {
      return;
    }
    if (!embeddedPortalUrl || !effectiveRuntimeRunning) {
      removeEmbeddedPaseoFrame(workspaceFrameKey);
      return;
    }
    cacheEmbeddedPaseoFrame(workspaceFrameKey, embeddedPortalUrl);
  }, [effectiveRuntimeRunning, embeddedPortalUrl, workspaceData, workspaceFrameKey, workspaceLoading]);

  useEffect(() => {
    setPaseoCredentialSelections((current) => {
      const next: Partial<Record<ManagedHarness, string>> = { ...current };
      let changed = false;

      for (const harness of paseoHarnesses) {
        const harnessCredentials = agentCredentials.filter(
          (credential) => credential.harness === harness,
        );
        const runtimeCredentialId = liveSelections[harness]?.credentialId ?? "";
        const runtimeCredential = runtimeCredentialId
          ? harnessCredentials.find(
              (credential) => credential.id === runtimeCredentialId,
            ) ?? null
          : null;
        const activeCredential =
          harnessCredentials.find((credential) => credential.active) ?? null;
        const preferredCredentialId =
          runtimeCredential?.id
          ?? activeCredential?.id
          ?? harnessCredentials[0]?.id
          ?? "";
        const currentCredentialId = next[harness] ?? "";
        const currentStillValid = harnessCredentials.some(
          (credential) => credential.id === currentCredentialId,
        );
        if (
          currentCredentialId !== preferredCredentialId
          && (!currentStillValid || !currentCredentialId)
        ) {
          next[harness] = preferredCredentialId;
          changed = true;
        }
      }

      for (const harness of MANAGED_HARNESS_ORDER) {
        if (harness !== "ssh" && !paseoHarnesses.includes(harness) && next[harness]) {
          delete next[harness];
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [
    agentCredentials,
    liveStatus?.selectedByHarness,
    paseoHarnesses,
  ]);

  useEffect(() => {
    if (!workspaceAction) {
      return;
    }
    if (workspaceAction === "starting" && runtimeRunning) {
      setWorkspaceAction(null);
      return;
    }
    if (workspaceAction === "stopping" && !runtimeRunning) {
      setWorkspaceAction(null);
    }
  }, [runtimeRunning, workspaceAction]);

  useEffect(() => {
    if (!effectiveWorkspaceAction || effectiveWorkspaceAction === "deleting") {
      return;
    }
    const timer = window.setInterval(() => {
      setRefreshTick((current) => current + 1);
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [effectiveWorkspaceAction]);

  useEffect(() => {
    setSidebarWorkspacePolling(workspaceFrameKey, waitingForEmbeddedPaseo);
  }, [setSidebarWorkspacePolling, waitingForEmbeddedPaseo, workspaceFrameKey]);

  useEffect(() => {
    if (!waitingForEmbeddedPaseo) {
      return;
    }
    const timer = window.setInterval(() => {
      setRefreshTick((current) => current + 1);
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [waitingForEmbeddedPaseo]);

  async function handleSwitch(): Promise<void> {
    if (!driver) {
      return;
    }
    setActionError(null);
    setSwitching(true);
    try {
      await switchWorkspaceDriver(userId, workspaceName, driver);
      await refreshWorkspaceStatus(userId, workspaceName);
      refreshWorkspaces();
      setRefreshTick((current) => current + 1);
      setActionError(null);
    } catch (error) {
      setActionError(formatActionError(error, t));
    } finally {
      setSwitching(false);
    }
  }

  async function handleDelete(): Promise<void> {
    setActionError(null);
    setWorkspaceAction("deleting");
    try {
      await deleteWorkspace(userId, workspaceName);
      refreshWorkspaces();
      navigate(`/users/${encodeURIComponent(userId)}/workspaces`);
    } catch (error) {
      setWorkspaceAction(null);
      setActionError(formatActionError(error, t));
    }
  }

  async function handleStop(): Promise<void> {
    setActionError(null);
    setWorkspaceAction("stopping");
    try {
      await stopWorkspace(userId, workspaceName);
      await refreshWorkspaceStatus(userId, workspaceName);
      refreshWorkspaces();
      setRefreshTick((current) => current + 1);
    } catch (error) {
      setWorkspaceAction(null);
      setActionError(formatActionError(error, t));
    }
  }

  async function handleStart(): Promise<void> {
    setActionError(null);
    setWorkspaceAction("starting");
    try {
      await startWorkspace(userId, workspaceName);
      await refreshWorkspaceStatus(userId, workspaceName);
      refreshWorkspaces();
      setRefreshTick((current) => current + 1);
    } catch (error) {
      setWorkspaceAction(null);
      setActionError(formatActionError(error, t));
    }
  }

  async function handleRefreshStatus(): Promise<void> {
    setActionError(null);
    setRefreshing(true);
    try {
      await refreshWorkspaceStatus(userId, workspaceName);
      setRefreshTick((current) => current + 1);
    } catch (error) {
      setActionError(formatActionError(error, t));
    } finally {
      setRefreshing(false);
    }
  }

  async function handleSwitchLiveCredential(harness: ManagedHarness): Promise<void> {
    const credentialId = paseoCredentialSelections[harness] ?? "";
    if (
      !harness ||
      !credentialId ||
      !runtimeRunning
    ) {
      return;
    }
    setActionError(null);
    setSwitching(true);
    try {
      await switchWorkspaceLiveCredential(userId, workspaceName, {
        harness,
        credentialId,
      });
      await refreshWorkspaceStatus(userId, workspaceName);
      setRefreshTick((current) => current + 1);
    } catch (error) {
      setActionError(formatActionError(error, t));
    } finally {
      setSwitching(false);
    }
  }

  function renderDriverSwitchControls(): ReactNode {
    return (
      <div className="flex w-full min-w-0 flex-wrap items-end gap-3 sm:w-auto sm:justify-end">
        <div className="w-full min-w-0 sm:w-[18rem]">
          <Select value={driver} onValueChange={setDriver}>
            <SelectTrigger>
              <SelectValue placeholder={t("select_driver")} />
            </SelectTrigger>
            <SelectContent>
              {(workspaceData?.availableDrivers ?? []).map((item) => {
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
        <Button onClick={() => void handleSwitch()} disabled>
          <RefreshCw className="h-4 w-4" />
          {switching ? t("switching") : t("switch_workspace_action")}
        </Button>
      </div>
    );
  }

  function credentialSelectionSourceLabel(
    source:
      | "runtime-state"
      | "workspace-binding"
      | "user-active"
      | "compatibility"
      | undefined,
  ): string {
    return source === "runtime-state"
      ? t("credential_selection_runtime")
      : source === "workspace-binding"
        ? t("credential_selection_override")
        : source === "compatibility"
          ? t("credential_selection_compat")
          : t("credential_selection_active");
  }

  function renderLiveCredentialControls(): ReactNode {
    if (credentialsLoading) {
      return (
        <div className="flex items-center justify-center py-2 text-muted-foreground">
          <RefreshCw className="h-4 w-4 animate-spin" />
        </div>
      );
    }
    if (credentialsError) {
      return <p className="text-sm text-destructive">{credentialsError}</p>;
    }
    if (paseoHarnesses.length === 0) {
      return (
        <p className="text-sm text-muted-foreground">
          {t("no_paseo_credentials")}
        </p>
      );
    }
    return (
      <div className="grid w-full gap-3">
        {paseoHarnesses.map((harness) => {
          const harnessCredentials = agentCredentials.filter(
            (credential) => credential.harness === harness,
          );
          const runtimeCredentialSelection = liveSelections[harness];
          const currentCredential = runtimeCredentialSelection?.credentialId
            ? harnessCredentials.find(
                (credential) => credential.id === runtimeCredentialSelection.credentialId,
              ) ?? null
            : null;
          const currentSource = runtimeCredentialSelection?.source;
          const selectedCredentialId =
            paseoCredentialSelections[harness] ?? "";
          const canLiveSwitch = switchableHarnesses.includes(harness);

          return (
            <div
              key={harness}
              className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border/70 bg-muted/20 p-3"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  {credentialHarnessLabel(harness, t)}
                </div>
                <div className="text-sm text-muted-foreground">
                  {currentCredential
                    ? `${t("credential_selection_current")}：${currentCredential.label} · ${credentialSelectionSourceLabel(currentSource)}`
                    : `${t("credential_selection_current")}：${t("credential_selection_none")}`}
                </div>
              </div>
              <div className="flex w-full min-w-0 flex-wrap items-end justify-start gap-3 sm:w-auto sm:justify-end">
                <div className="w-full min-w-0 sm:w-[16rem]">
                  <Select
                    value={selectedCredentialId}
                    onValueChange={(value) =>
                      setPaseoCredentialSelections((current) => ({
                        ...current,
                        [harness]: value,
                      }))}
                    disabled={harnessCredentials.length === 0}
                  >
                    <SelectTrigger className="bg-white">
                      <SelectValue
                        placeholder={harnessCredentials.length === 0
                          ? t("no_paseo_credentials")
                          : t("select_credential")}
                      />
                    </SelectTrigger>
                    <SelectContent className="bg-white">
                      {harnessCredentials.map((credential) => (
                        <SelectItem key={credential.id} value={credential.id}>
                          {credential.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  variant="outline"
                  disabled={
                    switching
                    || !effectiveRuntimeRunning
                    || !selectedCredentialId
                    || !canLiveSwitch
                  }
                  onClick={() =>
                    void handleSwitchLiveCredential(harness)}
                >
                  {switching ? t("activating_credential") : t("switch_credential")}
                </Button>
              </div>
            </div>
          );
        })}
        {!effectiveRuntimeRunning ? (
          <p className="text-sm text-muted-foreground">
            {t("credential_switch_requires_running")}
          </p>
        ) : null}
      </div>
    );
  }

  function renderWorkspaceControlsCard(): ReactNode {
    return (
      <div className="grid gap-6">
        <div className="grid gap-6">
          <div className="min-w-0">
            <div className="text-base font-semibold">{t("workspace_header_title")}</div>
          </div>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t("switch_driver")}</div>
              <div className="text-sm text-muted-foreground">
                {workspaceData?.status?.driver
                  ? driverLabel({
                    backend: workspaceData.status.driver.backend,
                    profile: workspaceData.status.driver.profile,
                  })
                  : driverLabel(workspaceData?.selectedDriver ?? null)}
              </div>
            </div>
            {renderDriverSwitchControls()}
          </div>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">
                {effectiveRuntimeRunning ? t("stop_workspace") : t("start_workspace")}
              </div>
              <div className="text-sm text-muted-foreground">
                {workspaceStateLabel}
              </div>
            </div>
            <Button
              variant={effectiveRuntimeRunning ? "outline" : "default"}
              onClick={() => void (effectiveRuntimeRunning ? handleStop() : handleStart())}
              disabled={workspaceActionInFlight}
            >
              {effectiveRuntimeRunning
                ? (stopping ? t("stopping") : t("stop_workspace"))
                : (starting ? t("starting") : t("start_workspace"))}
            </Button>
          </div>
        </div>
        <div className="grid gap-6">
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
                  disabled={workspaceActionInFlight}
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
        <ErrorPopup
          title={t("global_error_title")}
          message={actionError}
          onClose={() => setActionError(null)}
        />
      </div>
    );
  }

  function renderPane(): ReactNode {
    if (!workspaceData) {
      return null;
    }

    if (currentPane === "dev-env" || currentPane === "memory") {
      return (
        <Navigate
          to={`/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspaceName)}/paseo`}
          replace
        />
      );
    }

    if (currentPane === "") {
      return null;
    }

    if (currentPane === "paseo") {
      const liveTarget =
        workspaceData.reconnectTarget ?? workspaceData.liveTarget;
      const driverStatus = workspaceData.status?.driver;
      return (
        <div className="flex min-h-[75dvh] w-full min-w-0 flex-col gap-6">
          <div className="grid gap-6">
            <div className="grid gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-base font-semibold">{t("paseo_info")}</div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleRefreshStatus()}
                  disabled={loading || refreshing || switching || starting || stopping || deleting}
                >
                  <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
                  {refreshing ? t("refreshing") : t("refresh")}
                </Button>
              </div>
              {liveTarget ? (
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t("live_target")}</div>
                  </div>
                  <div className="w-full min-w-0 text-sm text-muted-foreground sm:w-[28rem] sm:text-right">
                    <span className="break-all">{liveTarget}</span>
                  </div>
                </div>
              ) : null}
              {renderLiveCredentialControls()}
            </div>
            <Separator />
            {renderWorkspaceControlsCard()}
            <Separator />
            <div className="grid gap-4">
              <div className="text-base font-semibold">{t("driver_info")}</div>
              <div className="grid gap-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t("current_driver")}</div>
                  </div>
                  <div className="w-full min-w-0 text-sm text-muted-foreground sm:w-[28rem] sm:text-right">
                    {driverStatus
                      ? driverLabel({
                        backend: driverStatus.backend,
                        profile: driverStatus.profile,
                      })
                      : driverLabel(workspaceData.selectedDriver)}
                  </div>
                </div>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t("base_image")}</div>
                  </div>
                  <div className="w-full min-w-0 text-sm text-muted-foreground sm:w-[28rem] sm:text-right">
                    <span className="break-all">
                      {driverStatus?.baseImage ?? t("unknown")}
                    </span>
                  </div>
                </div>
                {driverStatus?.rootdiskImage ? (
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{t("rootdisk_image")}</div>
                      <div className="text-sm text-muted-foreground">{t("driver_info")}</div>
                    </div>
                    <div className="w-full min-w-0 text-sm text-muted-foreground sm:w-[28rem] sm:text-right">
                      <span className="break-all">
                        {driverStatus.rootdiskImage}
                      </span>
                    </div>
                  </div>
                ) : null}
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t("driver_runtime")}</div>
                  </div>
                  <div className="w-full min-w-0 text-sm text-muted-foreground sm:w-[28rem] sm:text-right">
                    <div>{translateDriverRuntimeKind(driverStatus?.runtimeKind, t)}</div>
                    <div className="break-all">{driverStatus?.runtimeRef ?? t("unknown")}</div>
                  </div>
                </div>
              </div>
            </div>
            <Separator />
            <div className="grid gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-base font-semibold">
                  {t("evolution_memory")}
                </div>
                <div className="text-sm text-muted-foreground">
                  {workspaceData.status?.evolution
                    ? `${workspaceData.status.evolution.artifactCount} ${t("evolution_assets")}`
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
            <Separator />
          </div>
        </div>
      );
    }

    if (currentPane === "controls") {
      return renderWorkspaceControlsCard();
    }

    return null;
  }

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
      <ErrorPopup title={t("global_error_title")} message={error} />
      <ErrorPopup
        title={t("global_error_title")}
        message={actionError}
        onClose={() => setActionError(null)}
      />
      {currentPane === ""
        ? renderPane()
        : (
            <div className="grid w-full min-w-0 gap-6">
              {renderPane()}
            </div>
          )}
    </div>
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

type CredentialDraft = {
  harness: ManagedHarness;
  label: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  presetId: string;
  model: string;
};

const MANAGED_HARNESS_ORDER: ManagedHarness[] = [
  "ssh",
  "codex",
  "claude",
  "copilot",
  "opencode",
  "pi",
];

function credentialHarnessLabel(
  harness: ManagedHarness,
  t: (key: string) => string,
): string {
  switch (harness) {
    case "ssh":
      return t("credential_harness_ssh");
    case "codex":
      return t("credential_harness_codex");
    case "claude":
      return t("credential_harness_claude");
    case "copilot":
      return t("credential_harness_copilot");
    case "opencode":
      return t("credential_harness_opencode");
    case "pi":
      return t("credential_harness_pi");
  }
}

function presetsForHarness(
  catalog: PortalCredentialCatalog | null,
  harness: ManagedHarness,
) {
  return catalog?.presetsByHarness[harness] ?? [];
}

function defaultCredentialDraft(
  harness: ManagedHarness,
  catalog: PortalCredentialCatalog | null,
): CredentialDraft {
  const defaultPreset = presetsForHarness(catalog, harness)[0];
  if (harness === "codex") {
    return {
      harness,
      label: defaultPreset?.label ?? "RightCode",
      providerName: defaultPreset?.providerName ?? "rightcode",
      baseUrl: defaultPreset?.baseUrl ?? "https://right.codes/codex/v1",
      apiKey: "",
      presetId: defaultPreset?.id ?? "rightcode",
      model: defaultPreset?.model ?? "gpt-5.5",
    };
  }
  if (defaultPreset) {
    return {
      harness,
      label: defaultPreset.label,
      providerName: defaultPreset.providerName,
      baseUrl: defaultPreset.baseUrl,
      apiKey: "",
      presetId: defaultPreset.id,
      model: defaultPreset.model ?? "",
    };
  }
  return {
    harness,
    label:
      harness === "claude"
        ? "Claude credential"
        : harness === "copilot"
          ? "Copilot credential"
          : harness === "opencode"
            ? "OpenCode credential"
            : "pi credential",
    providerName: harness,
    baseUrl: "",
    apiKey: "",
    presetId: "",
    model: "",
  };
}

function credentialPathsCell(
  credential: PortalCredentialSummary,
  userId: string,
  t: (key: string) => string,
): ReactNode {
  if (credential.paths.length === 0) {
    return <span className="text-sm text-muted-foreground">{t("none")}</span>;
  }
  return (
    <div className="grid gap-2">
      {credential.paths.map((item) => (
        <CredentialPathCell
          key={`${credential.id}:${item}`}
          path={trimUserAssetPath(item, userId)}
          userId={userId}
          previewPath={item}
        />
      ))}
    </div>
  );
}

function CredentialManagerContent() {
  const { t } = useLanguage();
  const { userId = "" } = useParams();
  const [reloadKey, setReloadKey] = useState(0);
  const {
    data: credentials,
    error: credentialsError,
    loading: credentialsLoading,
  } = useAsyncValue(() => listCredentials(userId), [userId, reloadKey]);
  const { data: credentialCatalog, error: catalogError } = useAsyncValue(
    () => getCredentialCatalog(userId),
    [userId],
  );
  const [sheetOpen, setSheetOpen] = useState(false);
  const [credentialDraft, setCredentialDraft] = useState<CredentialDraft>(
    defaultCredentialDraft("codex", null),
  );
  const [credentialCreating, setCredentialCreating] = useState(false);
  const [credentialActionError, setCredentialActionError] = useState<string | null>(null);
  const [deletingCredentialId, setDeletingCredentialId] = useState<string | null>(null);
  const [activatingCredentialId, setActivatingCredentialId] = useState<string | null>(null);
  const harnessPresets = presetsForHarness(
    credentialCatalog,
    credentialDraft.harness,
  );

  const groupedCredentials = MANAGED_HARNESS_ORDER.map((harness) => ({
    harness,
    supportsCreate:
      credentialCatalog?.harnesses.find((item) => item.id === harness)
        ?.supportsCreate ?? harness !== "ssh",
    credentials: (credentials ?? []).filter(
      (credential) => credential.harness === harness,
    ),
  }));

  function openCredentialSheet(harness: ManagedHarness): void {
    setCredentialDraft(defaultCredentialDraft(harness, credentialCatalog));
    setCredentialActionError(null);
    setSheetOpen(true);
  }

  async function handleCredentialCreate(
    event?: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event?.preventDefault();
    if (credentialCreating) {
      return;
    }
    setCredentialCreating(true);
    setCredentialActionError(null);
    try {
      await createCredential(userId, {
        harness: credentialDraft.harness,
        label: credentialDraft.label.trim() || undefined,
        providerName: credentialDraft.providerName.trim() || undefined,
        baseUrl: credentialDraft.baseUrl.trim() || undefined,
        apiKey: credentialDraft.apiKey,
        presetId:
          credentialDraft.harness !== "ssh"
            ? credentialDraft.presetId || undefined
            : undefined,
        model:
          credentialDraft.harness === "codex"
            ? credentialDraft.model.trim() || undefined
            : undefined,
      });
      setSheetOpen(false);
      setCredentialDraft(defaultCredentialDraft("codex", credentialCatalog));
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

  async function handleCredentialActivate(credentialId: string): Promise<void> {
    if (activatingCredentialId) {
      return;
    }
    setActivatingCredentialId(credentialId);
    setCredentialActionError(null);
    try {
      await activateCredential(userId, credentialId);
      setReloadKey((current) => current + 1);
    } catch (error) {
      setCredentialActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActivatingCredentialId(null);
    }
  }

  return (
    <div className="grid w-full min-w-0 gap-6">
        <div className="grid gap-4">
          {(credentialsLoading || !credentialCatalog) && (
            <div className="flex items-center justify-center py-2 text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" />
            </div>
          )}
          {credentialsError && (
            <p className="text-sm text-destructive">{credentialsError}</p>
          )}
          {catalogError && (
            <p className="text-sm text-destructive">{catalogError}</p>
          )}
          {credentialActionError && (
            <p className="text-sm text-destructive">{credentialActionError}</p>
          )}
          {groupedCredentials.map((section, index) => (
            <React.Fragment key={section.harness}>
              <div className="grid gap-4">
                <div className="flex flex-row items-start justify-between gap-4">
                  <div>
                    <div className="text-base font-semibold">
                      {credentialHarnessLabel(section.harness, t)}
                    </div>
                  </div>
                  {section.supportsCreate ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openCredentialSheet(section.harness)}
                    >
                      <PlusCircle className="h-4 w-4" />
                      {t("add_credential")}
                    </Button>
                  ) : null}
                </div>
                {section.credentials.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("no_credentials")}
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[44rem] table-auto text-sm">
                      <thead className="bg-muted/30 text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
                        <tr className="border-b border-border/70">
                          <th className="px-4 py-3 font-medium">
                            {t("asset_name")}
                          </th>
                          <th className="px-4 py-3 font-medium">
                            {t("credential_provider")}
                          </th>
                          <th className="px-4 py-3 font-medium">
                            {t("credential_paths")}
                          </th>
                          <th className="px-4 py-3 font-medium text-right">
                            {t("asset_action")}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/50">
                        {section.credentials.map((credential) => (
                          <tr key={credential.id} className="align-top">
                            <td className="px-4 py-4">
                              <div className="grid gap-1">
                                <span className="font-medium">
                                  {credential.label}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {credential.id}
                                </span>
                              </div>
                            </td>
                            <td className="px-4 py-4 text-muted-foreground">
                              {credential.providerName ?? "-"}
                            </td>
                            <td className="px-4 py-4">
                              {credentialPathsCell(credential, userId, t)}
                            </td>
                            <td className="px-4 py-4">
                              <div className="flex justify-end gap-2">
                                {credential.harness && credential.harness !== "ssh" ? (
                                  <Button
                                    variant={
                                      credential.active ? "secondary" : "outline"
                                    }
                                    size="sm"
                                    disabled={
                                      credential.active ||
                                      activatingCredentialId === credential.id
                                    }
                                    onClick={() =>
                                      void handleCredentialActivate(
                                        credential.id,
                                      )}
                                  >
                                    {activatingCredentialId === credential.id
                                      ? t("setting_default_credential")
                                      : credential.active
                                        ? t("default_credential")
                                        : t("set_default_credential")}
                                  </Button>
                                ) : null}
                                <AlertDialog>
                                  <AlertDialogTrigger asChild>
                                    <Button
                                      variant="destructive"
                                      size="sm"
                                      disabled={
                                        deletingCredentialId === credential.id
                                      }
                                      aria-label={t("delete_credential")}
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  </AlertDialogTrigger>
                                  <AlertDialogContent>
                                    <AlertDialogHeader>
                                      <AlertDialogTitle>
                                        {t("delete_credential_confirm_title")}
                                      </AlertDialogTitle>
                                      <AlertDialogDescription>
                                        {t(
                                          "delete_credential_confirm_description",
                                        )}
                                      </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                      <AlertDialogCancel>
                                        {t("cancel")}
                                      </AlertDialogCancel>
                                      <AlertDialogAction
                                        onClick={() =>
                                          void handleCredentialDelete(
                                            credential.id,
                                          )}
                                      >
                                        {deletingCredentialId === credential.id
                                          ? t("deleting_credential")
                                          : t("delete_credential")}
                                      </AlertDialogAction>
                                    </AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              {index < groupedCredentials.length - 1 ? <Separator /> : null}
            </React.Fragment>
          ))}
        </div>
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="right" className="w-full sm:max-w-xl">
            <SheetHeader>
              <SheetTitle>{t("add_credential")}</SheetTitle>
              <SheetDescription>
                {credentialHarnessLabel(credentialDraft.harness, t)}
              </SheetDescription>
            </SheetHeader>
            <form
              className="grid gap-4 py-4"
              onSubmit={(event) => void handleCredentialCreate(event)}
            >
              {harnessPresets.length > 0 ? (
                <div className="grid gap-2">
                  <Label htmlFor="credential-preset">
                    {t("credential_template")}
                  </Label>
                  <Select
                    value={credentialDraft.presetId}
                    onValueChange={(value) => {
                      const preset = harnessPresets.find(
                        (item) => item.id === value,
                      );
                      if (!preset) {
                        return;
                      }
                      setCredentialDraft((current) => ({
                        ...current,
                        presetId: preset.id,
                        label: preset.label,
                        providerName: preset.providerName,
                        baseUrl: preset.baseUrl,
                        model: preset.model ?? "",
                      }));
                    }}
                  >
                    <SelectTrigger className="bg-white">
                      <SelectValue
                        placeholder={t("credential_template")}
                      />
                    </SelectTrigger>
                    <SelectContent className="bg-white">
                      {harnessPresets.map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>
                          {preset.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <div className="grid gap-2">
                <Label htmlFor="credential-label">{t("credential_label")}</Label>
                <Input
                  id="credential-label"
                  value={credentialDraft.label}
                  onChange={(event) =>
                    setCredentialDraft((current) => ({
                      ...current,
                      label: event.target.value,
                    }))}
                  disabled={credentialCreating}
                />
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="credential-provider">
                    {t("credential_provider")}
                  </Label>
                  <Input
                    id="credential-provider"
                    value={credentialDraft.providerName}
                    onChange={(event) =>
                      setCredentialDraft((current) => ({
                        ...current,
                        providerName: event.target.value,
                      }))}
                    disabled={credentialCreating}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="credential-model">
                    {t("credential_model")}
                  </Label>
                  <Input
                    id="credential-model"
                    value={credentialDraft.model}
                    onChange={(event) =>
                      setCredentialDraft((current) => ({
                        ...current,
                        model: event.target.value,
                      }))}
                    disabled={
                      credentialCreating ||
                      credentialDraft.harness !== "codex"
                    }
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="credential-base-url">
                  {t("credential_base_url")}
                </Label>
                <Input
                  id="credential-base-url"
                  value={credentialDraft.baseUrl}
                  onChange={(event) =>
                    setCredentialDraft((current) => ({
                      ...current,
                      baseUrl: event.target.value,
                    }))}
                  disabled={credentialCreating}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="credential-api-key">
                  {t("credential_api_key")}
                </Label>
                <Input
                  id="credential-api-key"
                  type="password"
                  value={credentialDraft.apiKey}
                  onChange={(event) =>
                    setCredentialDraft((current) => ({
                      ...current,
                      apiKey: event.target.value,
                    }))}
                  disabled={credentialCreating}
                />
              </div>
              <SheetFooter>
                <Button type="submit" disabled={credentialCreating}>
                  {credentialCreating
                    ? t("creating_credential")
                    : t("create_credential")}
                </Button>
              </SheetFooter>
            </form>
          </SheetContent>
        </Sheet>
      </div>
  );
}

function CredentialsPage() {
  return <CredentialManagerContent />;
}

function ProfilePage() {
  return <CredentialManagerContent />;
}

function LegacyWorkspacePaneRedirect() {
  const { userId = "", workspaceName = "" } = useParams();
  return (
    <Navigate
      to={`/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspaceName)}/paseo`}
      replace
    />
  );
}

function SettingsPage() {
  const { language, setLanguage, t } = useLanguage();
  return (
    <div className="grid w-full gap-6">
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
      </div>
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
    activatingCredentialId?: string | null;
    onDelete?: (credentialId: string) => void;
    onActivate?: (credentialId: string) => void;
  },
): AssetSection[] {
  return credentials.map((credential) => ({
    label: credential.label,
    labelLines: [
      [
        credential.harness ?? credential.kind,
        credential.providerName ? `provider: ${credential.providerName}` : null,
        credential.active ? t("active_credential") : null,
      ].filter(Boolean).join(" · "),
    ],
    rows: (credential.paths.length > 0 ? credential.paths : [t("none")]).map((item) => ({
      name: item === t("none") ? credential.kind : basenameForDisplay(item),
      path: item,
      status: translateState(credential.status, t),
      previewPath: item !== t("none") ? item : undefined,
    })),
    action: options?.onDelete || options?.onActivate ? (
      <div className="flex flex-wrap justify-end gap-2">
        {options.onActivate && credential.kind === "codex-auth" ? (
          <Button
            variant={credential.active ? "secondary" : "outline"}
            size="sm"
            disabled={credential.active || options.activatingCredentialId === credential.id}
            onClick={() => options.onActivate?.(credential.id)}
          >
            {options.activatingCredentialId === credential.id
              ? t("activating_credential")
              : credential.active
                ? t("active_credential")
                : t("activate_credential")}
          </Button>
        ) : null}
        {options.onDelete ? (
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
        ) : null}
      </div>
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
                <>
                  <ApiAuthBridge />
                  <Routes>
                    <Route path="/" element={<OverviewPage />} />
                    <Route element={<PortalLayout />}>
                      <Route path="/users/:userId/profile" element={<ProfilePage />} />
                      <Route path="/users/:userId/admin" element={<AdminPage />} />
                      <Route path="/users/:userId/settings" element={<SettingsPage />} />
                      <Route path="/users/:userId/workspaces" element={<WorkspaceIndexPage />} />
                      <Route path="/users/:userId/workspaces/:workspaceName" element={<WorkspaceDetailPage />} />
                      <Route path="/users/:userId/workspaces/:workspaceName/paseo" element={<WorkspaceDetailPage />} />
                      <Route path="/users/:userId/workspaces/:workspaceName/controls" element={<WorkspaceDetailPage />} />
                      <Route path="/users/:userId/workspaces/:workspaceName/dev-env" element={<LegacyWorkspacePaneRedirect />} />
                      <Route path="/users/:userId/workspaces/:workspaceName/memory" element={<LegacyWorkspacePaneRedirect />} />
                      <Route path="/users/:userId/credentials" element={<CredentialsPage />} />
                    </Route>
                  </Routes>
                </>
              </AuthGate>
            )}
          />
        </Routes>
      </LanguageContext.Provider>
    </AppErrorBoundary>
  );
}
