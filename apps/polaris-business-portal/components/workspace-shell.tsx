"use client";

import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  ArrowLeft,
  BookOpen,
  Bot,
  CalendarRange,
  ChevronDown,
  ChevronRight,
  Compass,
  File,
  FileImage,
  FileJson2,
  FileText,
  Folder,
  FolderPlus,
  Gem,
  Eye,
  Info,
  House,
  ListFilter,
  Map as MapIcon,
  Megaphone,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  RefreshCw,
  Repeat,
  Rocket,
  ScrollText,
  Search,
  Settings,
  ShieldAlert,
  ShoppingCart,
  Sparkles,
  Globe2,
  Key,
  Trash2,
  Waypoints,
  Wrench,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { JsonAssetViewer } from "@/components/json-asset-viewer";
import { CommerceOperationsPanel } from "@/components/commerce-operations-panel";
import { LiteratureReviewPanel } from "@/components/literature-review-panel";
import { ManualReviewAssetPanel } from "@/components/manual-review-asset-panel";
import { ProductGalleryPanel } from "@/components/product-gallery-panel";
import { SeoOpsPanel } from "@/components/seo-ops-panel";
import { TextAssetViewer } from "@/components/text-asset-viewer";
import { WorkflowGraphPanel } from "@/components/workflow-graph-panel";
import {
  assetManagementHeader as assetManagementHeaderForView,
  assetManagementTitle,
  isAssetManagementView,
  resolveAssetManagementNavigation,
  type AssetManagementView,
  type WorkspaceType,
} from "@/lib/asset-management-navigation";
import { selectBrainWorkflowMode } from "@/lib/brain-workflow-mode";
import {
  workflowOverviewStatusItems,
  workflowRunning,
} from "@/lib/workflow-overview-status";
import {
  editableFieldRows,
  groupEditableFields,
  hasPromptCompanion,
  isInputArgumentPath,
  isPromptDetailPath,
  isStepDetailPath,
  promptCompanionTooltip,
  sortEditableFieldGroupsForDisplay,
} from "@/lib/workflow-editable-fields";
import {
  createPaseoEmbed,
  type PaseoEmbedContext,
  type PaseoEmbedHandle,
} from "@/lib/paseo-embed";
import {
  buildWorkflowTaskSelectionGroups,
  existingTaskSelectionValue,
  selectedExistingWorkflowId as selectedExistingWorkflowIdFromValue,
  selectedTemplateId as selectedTemplateIdFromValue,
} from "@/lib/workflow-task-selection";
import {
  findWorkflowAssetByPath,
  workflowDisplayPath,
  workflowIdFromAssetPath,
} from "@/lib/workflow-asset-paths";
import { showLeftPaseoOverlay } from "@/lib/paseo-layout";
import { wanghaiMutationFetch } from "@/lib/mutation-request";
import { wanghaiPath } from "@/lib/paths";
import {
  defaultWorkspaceShellLayoutPrefs,
  readSelectedWorkspace,
  readWorkspaceShellLayoutPrefs,
  resolveInitialWorkspaceSelection,
  workspaceShellLayoutMountKey,
  workspaceShellStorage,
  writeWorkspaceShellLayoutPrefs,
  writeSelectedWorkspace,
  workspaceShellLayoutGroupId,
  type WorkspaceShellLayoutPrefs,
} from "@/lib/workspace-layout-memory";
import { shouldSyncAssetSidebarToAssets } from "@/lib/asset-management-sidebar";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  useDefaultLayout,
  usePanelRef,
} from "@/components/ui/resizable";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

type AssetKind = "data" | "document" | "image" | "pdf";
type AssetKindFilter = AssetKind | "all";

const ASSET_KIND_FILTER_OPTIONS: Array<{
  label: string;
  value: AssetKindFilter;
}> = [
  { label: "全部类型", value: "all" },
  { label: "图片", value: "image" },
  { label: "PDF", value: "pdf" },
  { label: "数据", value: "data" },
  { label: "文档", value: "document" },
];

type Asset = {
  display_path?: string;
  kind: AssetKind;
  modified_at: string;
  name: string;
  path: string;
  size: number;
};

type WorkspaceCreateType = Exclude<WorkspaceType, "unclassified">;
type WorkspaceSummary = {
  name: string;
  type: WorkspaceType;
};

type WorkspaceResponse = {
  workspaces: WorkspaceSummary[];
};

type CreateWorkspaceResponse = {
  workspace: WorkspaceSummary;
};

type CreateWorkspaceForm = {
  workspaceId: string;
  workspaceType: "" | WorkspaceCreateType;
};

type WorkspaceWorkflowStageFact = {
  label: string;
  value: string;
};

type WorkspaceWorkflowEditableField = {
  path: string;
  value: string;
};

type WorkspaceWorkflowStageStatus = {
  artifact: string | null;
  facts: WorkspaceWorkflowStageFact[];
  modified_at: string | null;
  ready: boolean;
  size: number | null;
  status: string | null;
};

type WorkspaceWorkflowStep = {
  args: string[];
  command: string;
  id: string;
  label: string;
  tool: string;
};

type WorkspaceWorkflowStage = {
  depends_on_stage_ids: string[];
  editable_fields: WorkspaceWorkflowEditableField[];
  id: string;
  inputs: Asset[];
  label: string;
  outputs: Asset[];
  root_path: string;
  steps: WorkspaceWorkflowStep[];
  status: WorkspaceWorkflowStageStatus;
};

type WorkspaceWorkflowRunSummary = {
  finished_at: string | null;
  path: string;
  started_at: string | null;
  status: string;
};

type WorkspaceWorkflowPaseoCompanion = {
  agent_id: string;
};

type WorkspaceWorkflow = {
  category: string;
  description: string;
  id: string;
  last_run: WorkspaceWorkflowRunSummary | null;
  files?: Asset[];
  pipeline_status: "current" | "stale" | "incomplete" | "unknown";
  paseo: WorkspaceWorkflowPaseoCompanion | null;
  paseo_workspace_path: string;
  stages: WorkspaceWorkflowStage[];
  status_generated_at: string | null;
  template_id: string | null;
  title: string;
};

type AssetTreeNode = {
  asset?: Asset;
  children: Map<string, AssetTreeNode>;
  name: string;
  path: string;
};

type WorkflowResponse = {
  workflows: WorkspaceWorkflow[];
};

type SettingsCatalogResponse = {
  credentials: SettingsCredential[];
  generated_at: string;
  skills: SettingsSkill[];
  tools: SettingsTool[];
};

type SettingsTool = {
  cli: string | null;
  description: string;
  id: string;
  package_name: string | null;
  path: string;
  title: string;
};

type SettingsSkill = {
  description: string;
  id: string;
  path: string;
  source: "bundled" | "repo";
  title: string;
};

type SettingsCredential = {
  description: string;
  id: string;
  keys: string[];
  locations: string[];
  status: "configured" | "missing" | "partial";
  title: string;
  used_by: string[];
};

type PrebuiltWorkflow = {
  chain: string[];
  icon: typeof House;
  id: string;
  scenario: string;
  summary: string;
  title: string;
  todos: string[];
};

type PrebuiltWorkflowManifestEntry = {
  chain: string[];
  icon: string;
  id: string;
  scenario: string;
  summary: string;
  title: string;
  todos: string[];
};

type PrebuiltWorkflowResponse = {
  workflows: PrebuiltWorkflowManifestEntry[];
};

type WorkspaceTab =
  | { asset: Asset; id: string; title: string; type: "asset" }
  | {
    id: string;
    title: string;
    type: "workflow-graph";
    workflowId: string;
  }
  | {
    id: AssetManagementView;
    title: string;
    type: "asset-management";
    view: AssetManagementView;
  };

type MobileSidebar = "assets";
type SidebarTab = "assets" | "workflows" | "paseo";
type ContentSidebarTab = Exclude<SidebarTab, "paseo">;
type MainPaneMode = "home" | "settings" | "workspace";

type AppNavigationSnapshot = {
  activeHomeWorkflowId: string | null;
  activeTab: WorkspaceTab | null;
  activeTabId: string;
  directAssetManagementView: AssetManagementView | null;
  mainPaneMode: MainPaneMode;
};

const LEFT_SIDEBAR_MIN_WIDTH = 288;
const LEFT_SIDEBAR_MAX_WIDTH = 480;
const RIGHT_SIDEBAR_MIN_WIDTH = 320;
const RIGHT_SIDEBAR_MAX_WIDTH = 720;
const WIDE_PASEO_BREAKPOINT = "(min-width: 1680px)";
const PASEO_WEB_URL = process.env.NEXT_PUBLIC_PASEO_WEB_URL?.trim() ?? "";
const PASEO_DAEMON_ENDPOINT = process.env.NEXT_PUBLIC_PASEO_DAEMON_ENDPOINT?.trim() ?? "";
const PASEO_DEFAULT_MODEL = {
  model: "gpt-5.4",
  provider: "codex",
  thinkingOptionId: "medium",
};

const DTC_BRAIN_WORKFLOWS: PrebuiltWorkflow[] = [
  {
    chain: ["explore", "compete", "brand", "product", "launch"],
    icon: Compass,
    id: "start-from-zero",
    scenario: "什么都还没有",
    summary: "从市场洞察到品牌、产品和上市计划的完整起步路径。",
    title: "从零起步",
    todos: ["洞察用户与市场机会", "整理竞品地图", "明确品牌定位", "完成产品与定价策略", "形成上市计划"],
  },
  {
    chain: ["diagnose", "ice-priority", "execute", "dashboard"],
    icon: Activity,
    id: "growth-bottleneck-breakthrough",
    scenario: "数据不好看，不知道卡在哪",
    summary: "先诊断，再按 ICE 优先级推进修复，并用数据验证结果。",
    title: "增长瓶颈突破",
    todos: ["完成全链路诊断", "按 ICE 排序问题", "执行最高优先级修复", "回到 dashboard 验证"],
  },
  {
    chain: ["brand", "creative", "fb/gg/tt", "convert"],
    icon: Megaphone,
    id: "ads-system-setup",
    scenario: "要开始投广告了",
    summary: "品牌对齐后搭建创意与投放体系，并同步优化转化承接。",
    title: "广告体系搭建",
    todos: ["确认品牌表达与主卖点", "准备创意矩阵", "选择投放渠道与账户结构", "优化落地页承接"],
  },
  {
    chain: ["retain", "email", "sms", "aov"],
    icon: Repeat,
    id: "retention-system-setup",
    scenario: "复购太低，LTV 上不去",
    summary: "从留存诊断出发，搭建邮件、短信与客单价联动体系。",
    title: "留存体系搭建",
    todos: ["完成留存体检", "设计生命周期邮件流", "补齐短信触达流程", "加入 AOV 提升机制"],
  },
  {
    chain: ["seo", "geo", "social", "creative"],
    icon: ScrollText,
    id: "content-marketing-system",
    scenario: "想做有机增长",
    summary: "围绕搜索、AI 可见度和社交内容建立持续内容引擎。",
    title: "内容营销体系",
    todos: ["制定 SEO 方向", "建立 GEO/AEO 检查清单", "规划社交内容体系", "补足配套创意资产"],
  },
  {
    chain: ["compete", "brand", "creative", "convert"],
    icon: Sparkles,
    id: "brand-upgrade",
    scenario: "品牌老了，要重新定位",
    summary: "先做竞品与定位，再同步刷新创意和转化表达。",
    title: "品牌升级",
    todos: ["重做竞品认知", "更新品牌定位", "刷新视觉与创意表达", "同步修正转化页面"],
  },
  {
    chain: ["product+creative", "fb+gg+tt", "convert+email+sms"],
    icon: CalendarRange,
    id: "promotion-prep",
    scenario: "BFCM / 大促前准备",
    summary: "产品、创意、投放和转化留存三组并行协同的大促工作流。",
    title: "大促备战",
    todos: ["锁定促销商品与机制", "准备大促素材", "配置广告推进节奏", "联动转化与触达系统"],
  },
  {
    chain: ["expand", "route", "execute"],
    icon: Waypoints,
    id: "channel-expansion",
    scenario: "想拓展新渠道",
    summary: "先评估渠道适配度，再路由到对应执行模块落地。",
    title: "渠道扩展",
    todos: ["完成渠道评估", "确定主扩展方向", "准备渠道入场条件", "启动对应执行模块"],
  },
  {
    chain: ["triage", "monetize/foundation/paid", "stabilize"],
    icon: ShieldAlert,
    id: "emergency-stop-loss",
    scenario: "现金流告急",
    summary: "根据当前资产与问题分支，多模块联动先止血再恢复。",
    title: "紧急止血",
    todos: ["判断现金流问题类型", "选择止血主线", "联动相关模块执行", "验证现金流恢复信号"],
  },
  {
    chain: ["clarify-direction", "explore", "start-from-zero"],
    icon: MapIcon,
    id: "level-zero-guide",
    scenario: "完全没方向",
    summary: "先把方向理顺，再进入真正的从零起步工作流。",
    title: "Level 0 引导",
    todos: ["梳理现状与目标", "明确优先方向", "进入 explore", "衔接从零起步"],
  },
  {
    chain: ["product", "tier-routing", "execution"],
    icon: Gem,
    id: "premium-capability-building",
    scenario: "想提高利润率",
    summary: "通过产品四维溢价评估，把问题路由到正确模块去解决。",
    title: "溢价能力构建",
    todos: ["完成四维溢价评估", "识别当前 Tier", "确认溢价短板", "启动对应模块修复"],
  },
];

const RESEARCH_BRAIN_WORKFLOWS: PrebuiltWorkflow[] = [
  {
    chain: ["intake", "scope", "survey", "baseline", "artifact-intake", "method-design", "prototype", "evaluation", "synthesis", "writing", "submission", "post-submission"],
    icon: Rocket,
    id: "idea-to-paper",
    scenario: "从想法开始",
    summary: "用于从研究想法、目标领域或开放问题推进到论文提交。",
    title: "idea-to-paper",
    todos: ["明确问题与 scope", "完成 survey 与 baseline", "准备 artifact 与方法设计", "实现与评估", "完成写作与投稿"],
  },
  {
    chain: ["intake", "survey", "artifact-intake", "reproduction", "experiment-design", "evaluation", "threats-validity", "writing"],
    icon: ScrollText,
    id: "paper-reproduction",
    scenario: "已有论文，要复现或审计",
    summary: "用于论文复现、审计实验链路和整理有效性威胁。",
    title: "paper-reproduction",
    todos: ["读论文并整理目标", "准备 artifact", "建立复现实验", "做 evaluation", "补 threats-validity 和写作"],
  },
  {
    chain: ["intake", "scope", "survey", "baseline", "synthesis", "related-work", "write", "submission"],
    icon: Search,
    id: "literature-review",
    scenario: "做某个方向的文献综述",
    summary: "用于 topic survey、related work map、假设与边界对比，以及综述型写作。",
    title: "literature-review",
    todos: ["收敛综述问题与边界", "系统梳理 related work", "提炼 baseline 与比较维度", "形成 synthesis 和 related-work 结构", "输出综述型写作"],
  },
  {
    chain: ["intake", "scope", "target-understanding", "reverse or static-analysis", "dynamic-analysis or fuzzing", "exploit", "evaluation", "synthesis", "writing", "disclosure"],
    icon: ShieldAlert,
    id: "system-attack-study",
    scenario: "研究系统攻击路径",
    summary: "用于分析目标系统、构建攻击路径、做 PoC 和评估。",
    title: "system-attack-study",
    todos: ["理解目标与授权边界", "做静态或逆向分析", "补动态分析或 fuzzing", "验证 exploit", "评估并形成 disclosure 材料"],
  },
  {
    chain: ["intake", "scope", "survey", "baseline", "target-understanding", "method-design", "defense-prototype", "evaluation", "performance", "compatibility", "threats-validity", "writing", "submission"],
    icon: Key,
    id: "defense-design-study",
    scenario: "设计并验证防御",
    summary: "用于从 baseline 到 defense prototype，再到性能、兼容性和投稿。",
    title: "defense-design-study",
    todos: ["完成 survey 和 baseline", "理解目标系统", "设计并实现 defense", "评估性能与兼容性", "整理 threats-validity 与投稿"],
  },
  {
    chain: ["intake", "scope", "survey", "baseline", "artifact-intake", "experiment-design", "evaluation", "statistics", "synthesis", "writing", "submission"],
    icon: Globe2,
    id: "measurement-study",
    scenario: "做大规模测量或对比",
    summary: "用于 characterization、comparison 和 trend analysis 类研究。",
    title: "measurement-study",
    todos: ["定义样本与 scope", "准备 artifacts", "设计实验与 evaluation", "完成统计分析", "整理 synthesis 和论文"],
  },
  {
    chain: ["intake", "scope", "target-understanding", "static-analysis or dynamic-analysis", "reproduction", "exploit or defense-prototype", "evaluation", "disclosure", "writing", "post-submission"],
    icon: Wrench,
    id: "vuln-to-disclosure",
    scenario: "疑似漏洞到正式披露",
    summary: "用于对潜在漏洞做验证、复现、评估和纪律化披露。",
    title: "vuln-to-disclosure",
    todos: ["确认漏洞边界", "完成复现", "准备 exploit 或 defense prototype", "整理评估证据", "完成 disclosure 与写作"],
  },
];

const PREBUILT_WORKFLOW_ICONS: Record<string, typeof House> = {
  "globe-2": Globe2,
  key: Key,
  rocket: Rocket,
  search: Search,
  "scroll-text": ScrollText,
  "shield-alert": ShieldAlert,
  wrench: Wrench,
};

function manifestWorkflowToUi(entry: PrebuiltWorkflowManifestEntry): PrebuiltWorkflow {
  return {
    ...entry,
    icon: PREBUILT_WORKFLOW_ICONS[entry.icon] ?? House,
  };
}

function brainWorkflowsForType(
  type: WorkspaceType | null,
  researchWorkflows: PrebuiltWorkflow[] | null,
  workspacesReady: boolean,
): PrebuiltWorkflow[] {
  const mode = selectBrainWorkflowMode(type, workspacesReady);
  if (mode === "research") return researchWorkflows ?? RESEARCH_BRAIN_WORKFLOWS;
  if (mode === "dtc") return DTC_BRAIN_WORKFLOWS;
  return [];
}

function assetUrl(
  workspace: string,
  assetPath: string,
  asset?: Pick<Asset, "modified_at" | "size">,
) {
  const encodedPath = assetPath.split("/").map((part) => encodeURIComponent(part)).join("/");
  // Bust browser/iframe caches when the workspace file is rewritten in place
  // (same path, new bytes) — PDFs are especially sticky.
  const version = asset
    ? `&v=${encodeURIComponent(asset.modified_at)}&s=${asset.size}`
    : "";
  return wanghaiPath(`/api/workspaces/${encodeURIComponent(workspace)}/assets?path=${encodedPath}${version}`);
}

function isJsonAsset(assetPath: string) {
  return assetPath.toLowerCase().endsWith(".json");
}

function isLogAsset(assetPath: string) {
  return assetPath.toLowerCase().endsWith(".log");
}

function isTextAsset(assetPath: string) {
  const lower = assetPath.toLowerCase();
  return lower.endsWith(".log") || lower.endsWith(".txt") || lower.endsWith(".err") || lower.endsWith(".out");
}

function isManualReviewList(assetPath: string) {
  return assetPath.split("/").at(-1) === "manual-review-list.json";
}

function assetIcon(kind: AssetKind) {
  if (kind === "image") return FileImage;
  if (kind === "data") return FileJson2;
  if (kind === "pdf") return FileText;
  return File;
}

function fetchJson<T>(url: string): Promise<T> {
  return fetch(wanghaiPath(url), { cache: "no-store" }).then(async (response) => {
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : `请求失败：${response.status}`);
    return body as T;
  });
}

function sortWorkspaceSummaries(workspaces: WorkspaceSummary[]): WorkspaceSummary[] {
  return [...workspaces].sort((left, right) => left.name.localeCompare(right.name));
}

const INITIAL_CREATE_WORKSPACE_FORM: CreateWorkspaceForm = {
  workspaceId: "",
  workspaceType: "",
};

function sameNavigationSnapshot(left: AppNavigationSnapshot, right: AppNavigationSnapshot) {
  return left.activeHomeWorkflowId === right.activeHomeWorkflowId
    && left.activeTabId === right.activeTabId
    && left.directAssetManagementView === right.directAssetManagementView
    && left.mainPaneMode === right.mainPaneMode;
}

export function WorkspaceShell() {
  const { ts } = useI18n();
  const leftSidebarRef = usePanelRef();
  const workflowRequestId = useRef(0);
  const prebuiltWorkflowRequestId = useRef(0);
  const deepLinkAppliedWorkspaceRef = useRef<string | null>(null);
  const assetDeepLinkAppliedRef = useRef<string | null>(null);
  const navigationHistoryRef = useRef<AppNavigationSnapshot[]>([]);
  const overviewVisibleRef = useRef(true);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspacesReady, setWorkspacesReady] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [assetSearch, setAssetSearch] = useState("");
  const [assetLibrarySearch, setAssetLibrarySearch] = useState("");
  const [workflows, setWorkflows] = useState<WorkspaceWorkflow[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(true);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [activeHomeWorkflowId, setActiveHomeWorkflowId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState("");
  const [directAssetManagementView, setDirectAssetManagementView] = useState<AssetManagementView | null>(null);
  const [mainPaneMode, setMainPaneMode] = useState<MainPaneMode>("home");
  const [workflowId, setWorkflowId] = useState("");
  const [productLibraryRefreshKey, setProductLibraryRefreshKey] = useState(0);
  const [initialOrderNo, setInitialOrderNo] = useState<string | null>(null);
  const [settingsCatalog, setSettingsCatalog] = useState<SettingsCatalogResponse | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [researchBrainWorkflows, setResearchBrainWorkflows] = useState<PrebuiltWorkflow[] | null>(null);
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [leftSidebarTab, setLeftSidebarTab] = useState<SidebarTab>("workflows");
  const [desktopLayout, setDesktopLayout] = useState(false);
  const [widePaseoLayout, setWidePaseoLayout] = useState(false);
  const [rightPaseoOpen, setRightPaseoOpen] = useState(false);
  const [lastContentSidebarTab, setLastContentSidebarTab] = useState<ContentSidebarTab>("workflows");
  const [mobileSidebar, setMobileSidebar] = useState<MobileSidebar | null>(null);
  const [createWorkspaceDialogOpen, setCreateWorkspaceDialogOpen] = useState(false);
  const [createWorkspaceSubmitting, setCreateWorkspaceSubmitting] = useState(false);
  const [createWorkspaceForm, setCreateWorkspaceForm] = useState<CreateWorkspaceForm>(INITIAL_CREATE_WORKSPACE_FORM);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [nextWorkspace, setNextWorkspace] = useState("");
  const [canGoBack, setCanGoBack] = useState(false);
  const [paseoWorkflowId, setPaseoWorkflowId] = useState<string | null>(null);
  const [paseoContext, setPaseoContext] = useState<PaseoEmbedContext | null>(null);
  const activeWorkspace = useMemo(
    () => workspaces.find((item) => item.name === workspace) ?? null,
    [workspace, workspaces],
  );
  const brainWorkflowMode = useMemo(
    () => selectBrainWorkflowMode(activeWorkspace?.type ?? null, workspacesReady),
    [activeWorkspace?.type, workspacesReady],
  );
  const brainWorkflows = useMemo(
    () => brainWorkflowsForType(activeWorkspace?.type ?? null, researchBrainWorkflows, workspacesReady),
    [activeWorkspace?.type, researchBrainWorkflows, workspacesReady],
  );
  const localizedBrainWorkflows = useMemo(
    () => brainWorkflows.map((workflow) => ({
      ...workflow,
      scenario: ts(workflow.scenario),
      summary: ts(workflow.summary),
      title: ts(workflow.title),
      todos: workflow.todos.map((item) => ts(item)),
    })),
    [brainWorkflows, ts],
  );
  const layoutStorage = workspaceShellStorage();
  const showPaseoRightSidebar = desktopLayout && widePaseoLayout && rightPaseoOpen;
  const sidebarContentTab: ContentSidebarTab = leftSidebarTab === "paseo"
    ? lastContentSidebarTab
    : leftSidebarTab;
  const outerPanelIds = showPaseoRightSidebar
    ? ["asset-sidebar", "main-pane", "paseo-right-sidebar"]
    : ["asset-sidebar", "main-pane"];
  const outerLayoutGroupId = workspaceShellLayoutGroupId(workspace, "outer");
  const outerLayoutMemory = useDefaultLayout({
    id: outerLayoutGroupId,
    onlySaveAfterUserInteractions: true,
    panelIds: outerPanelIds,
    storage: layoutStorage,
  });

  const persistLayoutPrefs = useCallback((next: WorkspaceShellLayoutPrefs) => {
    if (!workspace) return;
    writeWorkspaceShellLayoutPrefs(workspace, next, layoutStorage);
  }, [layoutStorage, workspace]);

  const updateLayoutPrefs = useCallback((patch: Partial<WorkspaceShellLayoutPrefs>) => {
    const next: WorkspaceShellLayoutPrefs = {
      leftSidebarTab,
      lastContentSidebarTab,
      rightPaseoOpen,
      ...patch,
    };
    if (next.leftSidebarTab !== leftSidebarTab) setLeftSidebarTab(next.leftSidebarTab);
    if (next.lastContentSidebarTab !== lastContentSidebarTab) {
      setLastContentSidebarTab(next.lastContentSidebarTab);
    }
    if (next.rightPaseoOpen !== rightPaseoOpen) setRightPaseoOpen(next.rightPaseoOpen);
    persistLayoutPrefs(next);
  }, [
    lastContentSidebarTab,
    leftSidebarTab,
    persistLayoutPrefs,
    rightPaseoOpen,
  ]);

  useEffect(() => {
    if (activeWorkspace?.type !== "research") {
      setResearchBrainWorkflows(null);
      return;
    }
    const requestId = ++prebuiltWorkflowRequestId.current;
    fetchJson<PrebuiltWorkflowResponse>("/api/prebuilt-workflows?workspace_type=research")
      .then((data) => {
        if (requestId !== prebuiltWorkflowRequestId.current) return;
        setResearchBrainWorkflows(data.workflows.map(manifestWorkflowToUi));
      })
      .catch(() => {
        if (requestId !== prebuiltWorkflowRequestId.current) return;
        setResearchBrainWorkflows(null);
      });
  }, [activeWorkspace?.type]);

  useEffect(() => {
    const desktopQuery = window.matchMedia("(min-width: 1024px)");
    const widePaseoQuery = window.matchMedia(WIDE_PASEO_BREAKPOINT);
    const updateLayout = () => {
      setDesktopLayout(desktopQuery.matches);
      setWidePaseoLayout(widePaseoQuery.matches);
      if (desktopQuery.matches) setMobileSidebar(null);
    };

    updateLayout();
    desktopQuery.addEventListener("change", updateLayout);
    widePaseoQuery.addEventListener("change", updateLayout);
    return () => {
      desktopQuery.removeEventListener("change", updateLayout);
      widePaseoQuery.removeEventListener("change", updateLayout);
    };
  }, []);

  useEffect(() => {
    if (leftSidebarTab === "paseo") return;
    setLastContentSidebarTab(leftSidebarTab);
  }, [leftSidebarTab]);

  useEffect(() => {
    if (desktopLayout && widePaseoLayout) {
      if (leftSidebarTab === "paseo") {
        updateLayoutPrefs({
          leftSidebarTab: lastContentSidebarTab,
          rightPaseoOpen: true,
        });
      }
      return;
    }

    if (rightPaseoOpen) {
      updateLayoutPrefs({
        leftSidebarTab: "paseo",
        rightPaseoOpen: false,
      });
    }
  }, [desktopLayout, lastContentSidebarTab, leftSidebarTab, rightPaseoOpen, updateLayoutPrefs, widePaseoLayout]);

  useEffect(() => {
    if (!mobileSidebar) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileSidebar(null);
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileSidebar]);

  const reloadWorkflows = useCallback((options?: { silent?: boolean }) => {
    if (!workspace) return;
    const requestId = ++workflowRequestId.current;
    if (!options?.silent) {
      setWorkflowsLoading(true);
      setWorkflowError(null);
    }
    fetchJson<WorkflowResponse>(`/api/workspaces/${encodeURIComponent(workspace)}/workflows`)
      .then((data) => {
        if (requestId !== workflowRequestId.current) return;
        setWorkflows(data.workflows);
        setWorkflowId((current) => data.workflows.some((workflow) => workflow.id === current)
          ? current
          : data.workflows[0]?.id ?? "");
      })
      .catch((error) => {
        if (requestId === workflowRequestId.current) {
          setWorkflowError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!options?.silent && requestId === workflowRequestId.current) {
          setWorkflowsLoading(false);
        }
      });
  }, [workspace]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(window.location.search);
    setWorkspacesReady(false);
    fetchJson<WorkspaceResponse>("/api/workspaces")
      .then((data) => {
        if (cancelled) return;
        const names = data.workspaces.map((item) => item.name);
        setWorkspaces(data.workspaces);
        const nextWorkspace = resolveInitialWorkspaceSelection({
          availableWorkspaces: names,
          requestedWorkspace: params.get("workspace"),
          storedWorkspace: readSelectedWorkspace(layoutStorage),
        });
        setWorkspace(nextWorkspace);
        setNextWorkspace(nextWorkspace);
        setWorkspacesReady(true);
      })
      .catch((error) => {
        if (!cancelled) {
          setWorkspaceError(error instanceof Error ? error.message : String(error));
          setWorkspacesReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!workspace) {
      workflowRequestId.current += 1;
      setWorkflows([]);
      setWorkflowId("");
      setWorkflowsLoading(false);
      return;
    }

    setWorkflows([]);
    reloadWorkflows();
  }, [reloadWorkflows, workspace]);

  useEffect(() => {
    setActiveHomeWorkflowId(null);
    setTabs([]);
    setActiveTabId("");
    setDirectAssetManagementView(null);
    setMainPaneMode("home");
    setAssetLibrarySearch("");
    const prefs = workspace
      ? readWorkspaceShellLayoutPrefs(workspace, layoutStorage)
      : defaultWorkspaceShellLayoutPrefs();
    setLeftSidebarTab(prefs.leftSidebarTab);
    setRightPaseoOpen(prefs.rightPaseoOpen);
    setLastContentSidebarTab(prefs.lastContentSidebarTab);
    setPaseoWorkflowId(null);
    setPaseoContext(null);
    assetDeepLinkAppliedRef.current = null;
  }, [activeWorkspace?.type, layoutStorage, workspace]);

  function captureNavigationSnapshot(): AppNavigationSnapshot {
    return {
      activeHomeWorkflowId,
      activeTab: activeTabId ? tabs.find((tab) => tab.id === activeTabId) ?? null : null,
      activeTabId,
      directAssetManagementView,
      mainPaneMode,
    };
  }

  function applyNavigationSnapshot(snapshot: AppNavigationSnapshot) {
    if (snapshot.activeTab) {
      setTabs((current) => current.some((tab) => tab.id === snapshot.activeTab?.id)
        ? current
        : [...current, snapshot.activeTab!]);
    }
    if (snapshot.activeTab?.type === "workflow-graph") {
      setWorkflowId(snapshot.activeTab.workflowId);
    }
    setActiveHomeWorkflowId(snapshot.activeHomeWorkflowId);
    setActiveTabId(snapshot.activeTabId);
    setDirectAssetManagementView(snapshot.directAssetManagementView);
    setMainPaneMode(snapshot.mainPaneMode);
    setMobileSidebar(null);
  }

  function navigateToSnapshot(snapshot: AppNavigationSnapshot) {
    const currentSnapshot = captureNavigationSnapshot();
    if (sameNavigationSnapshot(currentSnapshot, snapshot)) return;
    navigationHistoryRef.current.push(currentSnapshot);
    setCanGoBack(true);
    applyNavigationSnapshot(snapshot);
  }

  const openAssetManagement = useCallback((view: AssetManagementView, recordHistory = true) => {
    const workflowResultView = view === "product-library"
      || view === "order-management"
      || view === "literature-review";
    const currentSnapshot = captureNavigationSnapshot();
    if (workflowResultView) {
      const nextSnapshot: AppNavigationSnapshot = {
        ...currentSnapshot,
        activeTab: null,
        activeTabId: "",
        directAssetManagementView: view,
        mainPaneMode: "workspace",
      };
      setTabs((current) => current.filter((item) => item.id !== view));
      if (recordHistory) navigateToSnapshot(nextSnapshot);
      else applyNavigationSnapshot(nextSnapshot);
      return;
    }

    const tab = {
      id: view,
      title: ts(assetManagementTitle(view)),
      type: "asset-management" as const,
      view,
    };
    const nextSnapshot: AppNavigationSnapshot = {
      ...currentSnapshot,
      activeTab: tab,
      activeTabId: tab.id,
      directAssetManagementView: null,
      mainPaneMode: "workspace",
    };
    if (recordHistory) navigateToSnapshot(nextSnapshot);
    else applyNavigationSnapshot(nextSnapshot);
  }, [activeHomeWorkflowId, activeTabId, directAssetManagementView, mainPaneMode, tabs]);

  // Deep-link: /?workspace=…&view=order-management&order=…
  useEffect(() => {
    if (!workspace) return;
    if (deepLinkAppliedWorkspaceRef.current === workspace) return;

    deepLinkAppliedWorkspaceRef.current = workspace;
    const params = new URLSearchParams(window.location.search);
    const order = params.get("order");
    const view = params.get("view");
    if (order) {
      setInitialOrderNo(order);
      openAssetManagement("order-management", false);
      return;
    }
    setInitialOrderNo(null);
    if (isAssetManagementView(view)) {
      openAssetManagement(view, false);
    }
  }, [openAssetManagement, workspace]);

  const activeWorkspaceTab = activeTabId
    ? tabs.find((tab) => tab.id === activeTabId) ?? null
    : directAssetManagementView
      ? null
      : tabs[0] ?? null;
  const activeAsset = mainPaneMode === "workspace" && activeWorkspaceTab?.type === "asset"
    ? activeWorkspaceTab.asset
    : null;
  const activeAssetManagementView = mainPaneMode === "workspace"
    ? activeWorkspaceTab?.type === "asset-management"
      ? activeWorkspaceTab.view
      : directAssetManagementView
    : null;
  const activeWorkflow = workflows.find((workflow) => workflow.id === workflowId) ?? null;
  const paseoWorkflow = paseoWorkflowId
    ? workflows.find((workflow) => workflow.id === paseoWorkflowId) ?? null
    : activeWorkflow;
  const activeHomeWorkflow = activeHomeWorkflowId
    ? localizedBrainWorkflows.find((item) => item.id === activeHomeWorkflowId) ?? null
    : null;

  useEffect(() => {
    navigationHistoryRef.current = [];
    setCanGoBack(false);
  }, [workspace]);

  useEffect(() => {
    if (!workspace) return;
    const params = new URLSearchParams();
    params.set("workspace", workspace);
    if (mainPaneMode === "workspace" && activeAsset) params.set("asset", activeAsset.path);
    if (mainPaneMode === "workspace" && activeAssetManagementView) params.set("view", activeAssetManagementView);
    window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
    writeSelectedWorkspace(workspace, layoutStorage);
  }, [activeAsset, activeAssetManagementView, mainPaneMode, workspace]);

  const openAsset = useCallback((asset: Asset) => {
    const id = `asset:${asset.path}`;
    const currentSnapshot = captureNavigationSnapshot();
    navigateToSnapshot({
      ...currentSnapshot,
      activeTab: { asset, id, title: asset.name, type: "asset" },
      activeTabId: id,
      directAssetManagementView: null,
      mainPaneMode: "workspace",
    });
  }, [activeHomeWorkflowId, activeTabId, directAssetManagementView, mainPaneMode, tabs]);

  const openLiteratureReviewAsset = useCallback((assetPath: string) => {
    const match = findWorkflowAssetByPath<Asset, WorkspaceWorkflow>(workflows, assetPath);
    if (!match) {
      toast.error("找不到该综述产物");
      return;
    }
    openAsset(match.asset);
  }, [openAsset, workflows]);

  const openWorkflowGraph = useCallback((workflow: WorkspaceWorkflow) => {
    const tab = {
      id: `workflow-graph:${workflow.id}`,
      title: `${workflow.title} · ${ts("流程图")}`,
      type: "workflow-graph" as const,
      workflowId: workflow.id,
    };
    const currentSnapshot = captureNavigationSnapshot();
    setWorkflowId(workflow.id);
    navigateToSnapshot({
      ...currentSnapshot,
      activeTab: tab,
      activeTabId: tab.id,
      directAssetManagementView: null,
      mainPaneMode: "workspace",
    });
  }, [activeHomeWorkflowId, activeTabId, directAssetManagementView, mainPaneMode, tabs, ts]);

  const modifyLiteratureReview = useCallback((workflowId: string) => {
    const workflow = workflows.find((item) => item.id === workflowId);
    if (!workflow) {
      toast.error("找不到该综述任务");
      return;
    }
    openWorkflowGraph(workflow);
  }, [openWorkflowGraph, workflows]);

  useEffect(() => {
    if (!workspace || workflowsLoading || workflows.length === 0) return;

    const params = new URLSearchParams(window.location.search);
    const assetPath = params.get("asset");
    if (!assetPath) return;

    const deepLinkKey = `${workspace}:${assetPath}`;
    if (assetDeepLinkAppliedRef.current === deepLinkKey) return;

    const match = findWorkflowAssetByPath(workflows, assetPath);
    if (!match) return;

    assetDeepLinkAppliedRef.current = deepLinkKey;
    setWorkflowId(match.workflow.id);
    openAsset(match.asset as Asset);
  }, [openAsset, workspace, workflows, workflowsLoading]);

  const refreshSidebar = useCallback(() => {
    reloadWorkflows();
    setProductLibraryRefreshKey((current) => current + 1);
  }, [reloadWorkflows]);

  const handleSidebarContentTabChange = useCallback((tab: ContentSidebarTab) => {
    updateLayoutPrefs({
      lastContentSidebarTab: tab,
      leftSidebarTab: tab,
    });
  }, [updateLayoutPrefs]);

  const loadSettingsCatalog = useCallback(() => {
    setSettingsLoading(true);
    setSettingsError(null);
    fetchJson<SettingsCatalogResponse>("/api/settings/catalog")
      .then((data) => {
        setSettingsCatalog(data);
      })
      .catch((error) => {
        setSettingsError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setSettingsLoading(false);
      });
  }, []);

  const openOverview = useCallback(() => {
    const currentSnapshot = captureNavigationSnapshot();
    navigateToSnapshot({
      ...currentSnapshot,
      activeHomeWorkflowId: null,
      mainPaneMode: "home",
    });
  }, [activeHomeWorkflowId, activeTabId, directAssetManagementView, mainPaneMode, tabs]);

  useEffect(() => {
    const overviewVisible = mainPaneMode === "home" && activeHomeWorkflowId === null;
    if (workspace && overviewVisible && !overviewVisibleRef.current) {
      reloadWorkflows({ silent: true });
    }
    overviewVisibleRef.current = overviewVisible;
  }, [activeHomeWorkflowId, mainPaneMode, reloadWorkflows, workspace]);

  const openBrainWorkflow = useCallback((workflowId: string) => {
    const workflow = localizedBrainWorkflows.find((item) => item.id === workflowId);
    if (!workflow) return;
    const currentSnapshot = captureNavigationSnapshot();
    navigateToSnapshot({
      ...currentSnapshot,
      activeHomeWorkflowId: workflow.id,
      mainPaneMode: "home",
    });
  }, [activeHomeWorkflowId, activeTabId, directAssetManagementView, localizedBrainWorkflows, mainPaneMode, tabs]);

  const openSettingsPanel = useCallback(() => {
    const currentSnapshot = captureNavigationSnapshot();
    navigateToSnapshot({
      ...currentSnapshot,
      mainPaneMode: "settings",
    });
    if (!settingsCatalog && !settingsLoading) loadSettingsCatalog();
  }, [activeHomeWorkflowId, activeTabId, directAssetManagementView, loadSettingsCatalog, mainPaneMode, settingsCatalog, settingsLoading, tabs]);

  const handleWorkspaceDialogOpenChange = useCallback((open: boolean) => {
    if (open) setNextWorkspace(workspace);
    setWorkspaceDialogOpen(open);
  }, [workspace]);

  const handleCreateWorkspaceDialogOpenChange = useCallback((open: boolean) => {
    setCreateWorkspaceDialogOpen(open);
    if (!open) {
      setCreateWorkspaceSubmitting(false);
      setCreateWorkspaceForm(INITIAL_CREATE_WORKSPACE_FORM);
    }
  }, []);

  const switchWorkspace = useCallback(() => {
    if (nextWorkspace && nextWorkspace !== workspace) setWorkspace(nextWorkspace);
    setWorkspaceDialogOpen(false);
  }, [nextWorkspace, workspace]);

  const submitCreateWorkspace = useCallback(async () => {
    const workspaceId = createWorkspaceForm.workspaceId.trim();
    const workspaceType = createWorkspaceForm.workspaceType;
    if (!workspaceId) {
      toast.error(ts("请先填写 workspace id"));
      return;
    }
    if (!workspaceType) {
      toast.error(ts("请先选择 workspace 类型"));
      return;
    }

    setCreateWorkspaceSubmitting(true);
    try {
      const response = await wanghaiMutationFetch("/api/workspaces", {
        body: JSON.stringify({
          workspace_id: workspaceId,
          workspace_type: workspaceType,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = await response.json().catch(() => null) as {
        error?: string;
        workspace?: WorkspaceSummary;
      } | null;
      if (!response.ok || !body?.workspace) {
        throw new Error(body?.error ?? `创建失败：${response.status}`);
      }

      setWorkspaces((current) => sortWorkspaceSummaries([
        ...current.filter((item) => item.name !== body.workspace!.name),
        body.workspace!,
      ]));
      setWorkspace(body.workspace.name);
      setNextWorkspace(body.workspace.name);
      setCreateWorkspaceDialogOpen(false);
      setCreateWorkspaceForm(INITIAL_CREATE_WORKSPACE_FORM);
      toast.success(ts("已创建工作区 {id}", { id: body.workspace.name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCreateWorkspaceSubmitting(false);
    }
  }, [createWorkspaceForm.workspaceId, createWorkspaceForm.workspaceType, ts]);

  const createWorkflowInstance = useCallback(async (templateId: string) => {
    if (!workspace) throw new Error("当前没有可用工作区");
    const response = await wanghaiMutationFetch(`/api/workspaces/${encodeURIComponent(workspace)}/workflows`, {
      body: JSON.stringify({ template_id: templateId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json().catch(() => null) as {
      error?: string;
      workflow?: WorkspaceWorkflow;
    } | null;
    if (!response.ok || !body?.workflow) {
      throw new Error(body?.error ?? `创建失败：${response.status}`);
    }

    setWorkflows((current) => current.some((item) => item.id === body.workflow!.id)
      ? current
      : [...current, body.workflow!]);
    setWorkflowId(body.workflow.id);
    return body.workflow;
  }, [workspace]);

  const deleteWorkflowInstance = useCallback(async (targetWorkflowId: string) => {
    if (!workspace) throw new Error("当前没有可用工作区");

    const response = await wanghaiMutationFetch(
      `/api/workspaces/${encodeURIComponent(workspace)}/workflows/${encodeURIComponent(targetWorkflowId)}`,
      { method: "DELETE" },
    );
    const body = await response.json().catch(() => null) as {
      error?: string;
    } | null;
    if (!response.ok) {
      throw new Error(body?.error ?? `删除失败：${response.status}`);
    }

    setTabs((current) => {
      const removedIds = new Set(
        current
          .filter((tab) => (
            (tab.type === "asset" && workflowIdFromAssetPath(tab.asset.path) === targetWorkflowId)
            || (tab.type === "workflow-graph" && tab.workflowId === targetWorkflowId)
          ))
          .map((tab) => tab.id),
      );
      if (removedIds.size === 0) return current;

      const next = current.filter((tab) => !removedIds.has(tab.id));
      if (removedIds.has(activeTabId)) {
        const nextActive = next.at(-1) ?? null;
        const nextActiveId = nextActive?.id ?? "";
        setActiveTabId(nextActiveId);
        if (nextActive?.type === "workflow-graph") {
          setWorkflowId(nextActive.workflowId);
        }
        if (!nextActiveId && !directAssetManagementView) {
          setMainPaneMode("home");
        }
      }
      return next;
    });

    setPaseoWorkflowId((current) => current === targetWorkflowId ? null : current);
    setPaseoContext(null);
    reloadWorkflows();
  }, [activeTabId, directAssetManagementView, reloadWorkflows, workspace]);

  const goBack = useCallback(() => {
    const previous = navigationHistoryRef.current.pop();
    if (!previous) return;

    setCanGoBack(navigationHistoryRef.current.length > 0);
    applyNavigationSnapshot(previous);
  }, [applyNavigationSnapshot]);

  function closeTab(id: string) {
    if (activeTabId === id) {
      navigationHistoryRef.current.push(captureNavigationSnapshot());
      setCanGoBack(true);
    }
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id);
      const next = current.filter((tab) => tab.id !== id);
      if (activeTabId === id) {
        const nextActive = next[Math.max(0, index - 1)] ?? null;
        const nextActiveId = nextActive?.id ?? "";
        setActiveTabId(nextActiveId);
        if (nextActive?.type === "workflow-graph") {
          setWorkflowId(nextActive.workflowId);
        }
        if (!nextActiveId) setMainPaneMode("home");
      }
      return next;
    });
  }

  const persistPaseoAgent = useCallback(async (
    targetWorkflowId: string,
    agentId: string,
  ): Promise<WorkspaceWorkflow> => {
    if (!workspace) throw new Error("当前没有可用工作区");

    const response = await wanghaiMutationFetch(
      `/api/workspaces/${encodeURIComponent(workspace)}/workflows/${encodeURIComponent(targetWorkflowId)}/paseo`,
      {
        body: JSON.stringify({ agent_id: agentId }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
    );
    const body = await response.json().catch(() => null) as {
      error?: string;
      workflow?: WorkspaceWorkflow;
    } | null;
    if (!response.ok || !body?.workflow) {
      throw new Error(body?.error ?? `保存 Paseo 会话失败：${response.status}`);
    }

    setWorkflows((current) => current.map((item) => (
      item.id === body.workflow!.id ? body.workflow! : item
    )));
    setWorkflowId(body.workflow.id);
    setPaseoWorkflowId(body.workflow.id);
    return body.workflow;
  }, [workspace]);

  const openPaseoSession = useCallback((
    targetWorkflow: WorkspaceWorkflow,
    context: PaseoEmbedContext | null = null,
  ) => {
    if (!targetWorkflow.paseo_workspace_path) {
      toast.error("这个工作流没有可用的 Paseo workspace");
      return;
    }

    setWorkflowId(targetWorkflow.id);
    setPaseoWorkflowId(targetWorkflow.id);
    setPaseoContext(context);
    if (desktopLayout && widePaseoLayout) {
      updateLayoutPrefs({ rightPaseoOpen: true });
      leftSidebarRef.current?.expand();
    } else if (desktopLayout) {
      updateLayoutPrefs({
        leftSidebarTab: "paseo",
        rightPaseoOpen: false,
      });
      leftSidebarRef.current?.expand();
    } else {
      updateLayoutPrefs({
        leftSidebarTab: "paseo",
        rightPaseoOpen: false,
      });
      setMobileSidebar("assets");
    }
  }, [desktopLayout, leftSidebarRef, updateLayoutPrefs, widePaseoLayout]);

  const addPaseoInputContext = useCallback((
    targetWorkflow: WorkspaceWorkflow,
    stage: WorkspaceWorkflowStage,
    inputValue: string,
  ) => {
    openPaseoSession(targetWorkflow, {
      id: `${targetWorkflow.id}:${stage.id}:input`,
      kind: "workflow-input",
      source: "wanghai",
      subtitle: "--input",
      text: [
        "当前工作流的输入参数：",
        "",
        `--input ${inputValue}`,
        "",
        "Paseo 已在这个工作流目录中打开。请先读取这个输入，再继续任务。",
      ].join("\n"),
      title: `${targetWorkflow.id} · ${stage.id} · --input`,
    });
  }, [openPaseoSession]);

  const addPaseoFieldContext = useCallback((
    targetWorkflow: WorkspaceWorkflow,
    stage: WorkspaceWorkflowStage,
    fieldPath: string,
    fieldValue: string,
  ) => {
    openPaseoSession(targetWorkflow, {
      id: `${targetWorkflow.id}:${stage.id}:${fieldPath}`,
      kind: "workflow-input",
      source: "wanghai",
      subtitle: fieldPath,
      text: [
        "当前工作流字段上下文：",
        "",
        `${fieldPath}:`,
        fieldValue,
        "",
        "这个字段带有对应的 prompt 规格。请先读取这个上下文，再继续任务。",
      ].join("\n"),
      title: `${targetWorkflow.id} · ${stage.id} · ${fieldPath}`,
    });
  }, [openPaseoSession]);

  const addPaseoWorkflowSkillPathContext = useCallback((
    targetWorkflow: WorkspaceWorkflow,
  ) => {
    openPaseoSession(targetWorkflow, {
      id: `${targetWorkflow.id}:workflow-literature-review:skill-path`,
      kind: "workflow-input",
      source: "wanghai",
      subtitle: "skill path",
      text: LITERATURE_REVIEW_WORKFLOW_SKILL_PATH,
      title: `${targetWorkflow.id} · workflow-literature-review`,
    });
  }, [openPaseoSession]);

  function toggleLeftSidebar() {
    if (!desktopLayout) {
      setMobileSidebar((current) => current === "assets" ? null : "assets");
      return;
    }

    if (leftSidebarRef.current?.isCollapsed()) leftSidebarRef.current.expand();
    else leftSidebarRef.current?.collapse();
  }

  const assetBrowser = (
    <AssetBrowser
      assetSearch={assetSearch}
      assetLibrarySearch={assetLibrarySearch}
      activeAssetManagementView={activeAssetManagementView}
      error={workspaceError ?? workflowError}
      loading={workflowsLoading}
      onAssetOpen={openAsset}
      onAssetSearchChange={setAssetSearch}
      onAssetLibrarySearchChange={(value) => {
        setAssetLibrarySearch(value);
        if (value.trim()) openAssetManagement("product-library");
      }}
      onAssetManagementOpen={openAssetManagement}
      onDeleteWorkflow={deleteWorkflowInstance}
      onRefresh={refreshSidebar}
      onPaseoRightSidebarClose={() => updateLayoutPrefs({ rightPaseoOpen: false })}
      onPaseoRightSidebarToggle={() => updateLayoutPrefs({ rightPaseoOpen: !rightPaseoOpen })}
      onSidebarContentTabChange={handleSidebarContentTabChange}
      onSidebarTabChange={(tab) => updateLayoutPrefs({ leftSidebarTab: tab })}
      onWorkflowChange={setWorkflowId}
      onWorkflowGraphOpen={openWorkflowGraph}
      paseoOpen={showPaseoRightSidebar || leftSidebarTab === "paseo"}
      paseoInRightSidebar={showPaseoRightSidebar}
      paseoPanel={(
        <PaseoPanel
          context={paseoContext}
          onAgentCreated={persistPaseoAgent}
          workflow={paseoWorkflow}
        />
      )}
      sidebarContentTab={sidebarContentTab}
      sidebarTab={leftSidebarTab}
      workspace={workspace}
      workspaceType={activeWorkspace?.type ?? null}
      workflowId={workflowId}
      workflows={workflows}
    />
  );
  const mainPane = (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <MainPaneHeader
        activeAssetManagementView={activeAssetManagementView}
        canGoBack={canGoBack}
        homeWorkflowScenario={mainPaneMode === "home" ? (activeHomeWorkflow?.scenario ?? null) : null}
        homeWorkflowSummary={mainPaneMode === "home" ? (activeHomeWorkflow?.summary ?? null) : null}
        homeWorkflowTitle={mainPaneMode === "home" ? (activeHomeWorkflow?.title ?? ts("总览")) : null}
        mainPaneMode={mainPaneMode}
        leftSidebarOpen={desktopLayout
          ? !leftSidebarCollapsed
          : mobileSidebar === "assets"}
        createWorkspaceDialogOpen={createWorkspaceDialogOpen}
        createWorkspaceForm={createWorkspaceForm}
        createWorkspaceSubmitting={createWorkspaceSubmitting}
        nextWorkspace={nextWorkspace}
        onCreateWorkspace={submitCreateWorkspace}
        onCreateWorkspaceDialogOpenChange={handleCreateWorkspaceDialogOpenChange}
        onCreateWorkspaceFormChange={setCreateWorkspaceForm}
        onGoBack={goBack}
        onOpenHome={openOverview}
        onOpenSettings={openSettingsPanel}
        onToggleLeftSidebar={toggleLeftSidebar}
        onWorkspaceDialogOpenChange={handleWorkspaceDialogOpenChange}
        onWorkspaceSelectionChange={setNextWorkspace}
        onWorkspaceSwitch={switchWorkspace}
        workspace={workspace}
        workspaceDialogOpen={workspaceDialogOpen}
        workspaceType={activeWorkspace?.type ?? null}
        workspaces={workspaces}
      />
      <TabBar
        activeTabId={mainPaneMode === "workspace" ? activeTabId : ""}
        hidden={mainPaneMode !== "workspace" || directAssetManagementView !== null || tabs.length === 0}
        onClose={closeTab}
        onSelect={(id) => {
          const nextTab = tabs.find((tab) => tab.id === id) ?? null;
          if (!nextTab) return;
          if (nextTab.type === "workflow-graph") {
            setWorkflowId(nextTab.workflowId);
          }
          navigateToSnapshot({
            ...captureNavigationSnapshot(),
            activeTab: nextTab,
            activeTabId: id,
            directAssetManagementView: null,
            mainPaneMode: "workspace",
          });
        }}
        tabs={tabs}
      />
      {mainPaneMode === "home" ? (
        <div className="min-h-0 flex-1 p-4 md:p-6">
          {brainWorkflowMode === null ? null : activeHomeWorkflow ? (
            <BrainWorkflowPanel
              onAddPaseoFieldContext={addPaseoFieldContext}
              onAddPaseoInputContext={addPaseoInputContext}
              onAddPaseoWorkflowSkillPathContext={addPaseoWorkflowSkillPathContext}
              onCreateWorkflowInstance={createWorkflowInstance}
              onLoadWorkspaceWorkflow={setWorkflowId}
              onOpenPaseoSession={openPaseoSession}
              selectedWorkspaceWorkflowId={workflowId}
              workflow={activeHomeWorkflow}
              workspace={workspace}
              workspaceWorkflows={workflows}
            />
          ) : (
            <BrainOverview
              onOpenOrderManagement={() => openAssetManagement("order-management")}
              onOpenProductManagement={() => openAssetManagement("product-library")}
              onOpenWorkflow={openBrainWorkflow}
              brainWorkflows={localizedBrainWorkflows}
              workspaceWorkflows={workflows}
              workspaceType={activeWorkspace?.type ?? null}
            />
          )}
        </div>
      ) : null}
      {mainPaneMode === "settings" ? (
        <div className="min-h-0 flex-1 p-4 md:p-6">
          <SettingsPanel
            catalog={settingsCatalog}
            error={settingsError}
            loading={settingsLoading}
            onRefresh={loadSettingsCatalog}
          />
        </div>
      ) : null}
      {mainPaneMode === "workspace" ? (
        <div className="relative min-h-0 flex-1">
          {directAssetManagementView === "product-library" ? (
            <div className="relative h-full min-h-0">
              <CommerceOperationsPanel view="products" workspace={workspace} />
            </div>
          ) : null}
          {directAssetManagementView === "order-management" ? (
            <div className="relative h-full min-h-0">
              <CommerceOperationsPanel
                initialOrderNo={initialOrderNo}
                view="orders"
                workspace={workspace}
              />
            </div>
          ) : null}
          {directAssetManagementView === "literature-review" ? (
            <div className="relative h-full min-h-0">
              <LiteratureReviewPanel
                onModify={modifyLiteratureReview}
                onOpenAsset={openLiteratureReviewAsset}
                workspace={workspace}
              />
            </div>
          ) : null}
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            const graphWorkflow = tab.type === "workflow-graph"
              ? workflows.find((workflow) => workflow.id === tab.workflowId) ?? null
              : null;
            return (
              <div
                aria-hidden={!active}
                className={active
                  ? "relative h-full min-h-0"
                  : "absolute inset-0 h-full min-h-0 overflow-hidden invisible pointer-events-none"}
                inert={!active}
                key={tab.id}
                role="tabpanel"
              >
                {tab.type === "asset" ? (
                  <AssetPreview asset={tab.asset} workspace={workspace} />
                ) : null}
                {tab.type === "asset-management" && tab.view === "product-library" ? (
                  <CommerceOperationsPanel view="products" workspace={workspace} />
                ) : null}
                {tab.type === "asset-management" && tab.view === "order-management" ? (
                  <CommerceOperationsPanel
                    initialOrderNo={initialOrderNo}
                    view="orders"
                    workspace={workspace}
                  />
                ) : null}
                {tab.type === "asset-management" && tab.view === "literature-review" ? (
                  <LiteratureReviewPanel
                    onModify={modifyLiteratureReview}
                    onOpenAsset={openLiteratureReviewAsset}
                    workspace={workspace}
                  />
                ) : null}
                {tab.type === "asset-management" && tab.view === "product-gallery" ? (
                  <ProductGalleryPanel
                    refreshKey={productLibraryRefreshKey}
                    workspace={workspace}
                  />
                ) : null}
                {tab.type === "asset-management" && tab.view === "product-video" ? (
                  <AssetManagementPlaceholder />
                ) : null}
                {tab.type === "asset-management" && tab.view === "seo-ops" ? (
                  <SeoOpsPanel
                    refreshKey={productLibraryRefreshKey}
                    workspace={workspace}
                  />
                ) : null}
                {tab.type === "asset-management" && tab.view === "submission-management" ? (
                  <SubmissionManagementPlaceholder />
                ) : null}
                {tab.type === "workflow-graph" ? (
                  <div className="flex h-full min-h-0 flex-col overflow-hidden">
                    {graphWorkflow ? (
                      <WorkflowGraphPanel workflow={graphWorkflow} />
                    ) : (
                      <div className="flex h-full min-h-0 items-center justify-center border border-dashed p-6 text-sm text-muted-foreground">
                        {ts("当前任务已不存在，无法显示流程图。")}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );

  return (
    <div className="h-dvh min-h-0 overflow-hidden bg-muted/20">
      {desktopLayout ? (
        <ResizablePanelGroup
          className="h-full min-h-0"
          defaultLayout={outerLayoutMemory.defaultLayout}
          id={outerLayoutGroupId}
          key={workspaceShellLayoutMountKey(workspace, "outer", outerPanelIds)}
          onLayoutChanged={outerLayoutMemory.onLayoutChanged}
          orientation="horizontal"
          resizeTargetMinimumSize={{ coarse: 24, fine: 8 }}
        >
          <ResizablePanel
            collapsedSize={0}
            collapsible
            defaultSize={272}
            groupResizeBehavior="preserve-pixel-size"
            id="asset-sidebar"
            maxSize={LEFT_SIDEBAR_MAX_WIDTH}
            minSize={LEFT_SIDEBAR_MIN_WIDTH}
            onResize={(size) => {
              const collapsed = size.inPixels <= 1;
              setLeftSidebarCollapsed((current) => current === collapsed
                ? current
                : collapsed);
            }}
            panelRef={leftSidebarRef}
          >
            <div
              aria-hidden={leftSidebarCollapsed}
              className="h-full min-w-0"
              inert={leftSidebarCollapsed}
            >
              {assetBrowser}
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel
            className="min-h-0 min-w-0 overflow-hidden"
            id="main-pane"
            minSize={320}
          >
            {mainPane}
          </ResizablePanel>
          {showPaseoRightSidebar ? (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel
                className="min-h-0 min-w-0 overflow-hidden"
                defaultSize={420}
                groupResizeBehavior="preserve-pixel-size"
                id="paseo-right-sidebar"
                maxSize={RIGHT_SIDEBAR_MAX_WIDTH}
                minSize={RIGHT_SIDEBAR_MIN_WIDTH}
              >
                <PaseoRightSidebar
                  onClose={() => updateLayoutPrefs({ rightPaseoOpen: false })}
                >
                  <PaseoPanel
                    context={paseoContext}
                    onAgentCreated={persistPaseoAgent}
                    workflow={paseoWorkflow}
                  />
                </PaseoRightSidebar>
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      ) : (
        <div
          aria-hidden={mobileSidebar !== null}
          className="h-full"
          inert={mobileSidebar !== null}
        >
          {mainPane}
        </div>
      )}

      {!desktopLayout && mobileSidebar === "assets" ? (
        <MobileSidebarOverlay
          label={ts("工作区导航")}
          onClose={() => setMobileSidebar(null)}
        >
          {assetBrowser}
        </MobileSidebarOverlay>
      ) : null}
    </div>
  );
}

function MobileSidebarOverlay({
  children,
  label,
  onClose,
  showCloseButton = true,
}: {
  children: ReactNode;
  label: string;
  onClose: () => void;
  showCloseButton?: boolean;
}) {
  const { ts } = useI18n();
  return (
    <div
      aria-label={label}
      aria-modal="true"
      className="fixed inset-0 z-50 flex min-h-0 flex-col bg-card"
      role="dialog"
    >
      {showCloseButton ? (
        <div className="flex h-14 shrink-0 items-center justify-end border-b px-3">
          <Button
            aria-label={ts("关闭")}
            autoFocus
            onClick={onClose}
            size="icon"
            title={ts("关闭")}
            type="button"
            variant="ghost"
          >
            <X className="size-5" aria-hidden="true" />
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

function AssetManagementNavigation({
  activeView,
  onOpen,
  workspaceType,
}: {
  activeView: AssetManagementView | null;
  onOpen: (view: AssetManagementView) => void;
  workspaceType: WorkspaceType | null;
}) {
  const { ts } = useI18n();
  const navigation = resolveAssetManagementNavigation(workspaceType);

  function iconForView(view: AssetManagementView | null) {
    if (view === "product-library") return Package;
    if (view === "product-gallery") return FileImage;
    if (view === "product-video") return Play;
    if (view === "order-management") return ShoppingCart;
    if (view === "literature-review") return BookOpen;
    if (view === "submission-management") return ScrollText;
    return FileText;
  }

  return (
    <nav aria-label={ts("资产库目录")} className="mb-3 space-y-1">
      {navigation.sectionLabel ? (
        <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium">
          <Package className="size-4 text-muted-foreground" aria-hidden="true" />
          <span>{ts(navigation.sectionLabel)}</span>
        </div>
      ) : null}
      {navigation.sectionItems.length > 0 ? (
        <div className="ml-2 space-y-0.5 border-l py-0.5 pl-2">
          {navigation.sectionItems.map((item) => {
            const Icon = iconForView(item.view);
            const selected = item.view === activeView;
            return (
              <button
                aria-current={selected ? "page" : undefined}
                className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
                key={item.view}
                onClick={() => onOpen(item.view!)}
                type="button"
              >
                <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                {ts(item.label)}
              </button>
            );
          })}
        </div>
      ) : null}
      {navigation.extraItems.map((item) => {
        const Icon = iconForView(item.view);
        const selected = item.view === activeView;
        if (item.view) {
          const view = item.view;
          return (
            <button
              aria-current={selected ? "page" : undefined}
              className={`flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
              key={item.label}
              onClick={() => onOpen(view)}
              type="button"
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              {ts(item.label)}
            </button>
          );
        }
        return (
          <div className="flex h-9 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground" key={item.label}>
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            {ts(item.label)}
          </div>
        );
      })}
    </nav>
  );
}

const AssetBrowser = memo(function AssetBrowser({
  activeAssetManagementView,
  assetSearch,
  assetLibrarySearch,
  error,
  loading,
  onAssetOpen,
  onAssetSearchChange,
  onAssetLibrarySearchChange,
  onAssetManagementOpen,
  onDeleteWorkflow,
  onPaseoRightSidebarClose,
  onPaseoRightSidebarToggle,
  onRefresh,
  onSidebarContentTabChange,
  onSidebarTabChange,
  onWorkflowChange,
  onWorkflowGraphOpen,
  paseoOpen,
  paseoInRightSidebar,
  paseoPanel,
  sidebarContentTab,
  sidebarTab,
  workspace,
  workspaceType,
  workflowId,
  workflows,
}: {
  activeAssetManagementView: AssetManagementView | null;
  assetSearch: string;
  assetLibrarySearch: string;
  error: string | null;
  loading: boolean;
  onAssetOpen: (asset: Asset) => void;
  onAssetSearchChange: (value: string) => void;
  onAssetLibrarySearchChange: (value: string) => void;
  onAssetManagementOpen: (view: AssetManagementView) => void;
  onDeleteWorkflow: (workflowId: string) => Promise<void>;
  onPaseoRightSidebarClose: () => void;
  onPaseoRightSidebarToggle: () => void;
  onRefresh: () => void;
  onSidebarContentTabChange: (tab: ContentSidebarTab) => void;
  onSidebarTabChange: (tab: SidebarTab) => void;
  onWorkflowChange: (value: string) => void;
  onWorkflowGraphOpen: (workflow: WorkspaceWorkflow) => void;
  paseoOpen: boolean;
  paseoInRightSidebar: boolean;
  paseoPanel: ReactNode;
  sidebarContentTab: ContentSidebarTab;
  sidebarTab: SidebarTab;
  workspace: string;
  workspaceType: WorkspaceType | null;
  workflowId: string;
  workflows: WorkspaceWorkflow[];
}) {
  const { ts } = useI18n();
  const layoutStorage = workspaceShellStorage();
  const assetNavigation = resolveAssetManagementNavigation(workspaceType);
  const workflowSidebarPanelIds = ["workflow-list", "workflow-artifacts"];
  const workflowSidebarLayoutGroupId = workspaceShellLayoutGroupId(workspace, "workflow-sidebar");
  const workflowSidebarLayoutMemory = useDefaultLayout({
    id: workflowSidebarLayoutGroupId,
    onlySaveAfterUserInteractions: true,
    panelIds: workflowSidebarPanelIds,
    storage: layoutStorage,
  });
  const [workflowStatusId, setWorkflowStatusId] = useState<string | null>(null);
  const [workflowDeleteId, setWorkflowDeleteId] = useState<string | null>(null);
  const [workflowDeleteBusy, setWorkflowDeleteBusy] = useState(false);
  const [artifactExpandedFolders, setArtifactExpandedFolders] = useState<Set<string>>(() => new Set());
  const [workflowFileExpandedFolders, setWorkflowFileExpandedFolders] = useState<Set<string>>(() => new Set());
  const [workflowFileExpansionSeed, setWorkflowFileExpansionSeed] = useState<string | null>(null);
  const [workflowFilesTab, setWorkflowFilesTab] = useState<"artifacts" | "files">("artifacts");
  const [assetKindFilter, setAssetKindFilter] = useState<AssetKindFilter>("all");
  const [artifactFilterOpen, setArtifactFilterOpen] = useState(false);
  const [artifactSearchOpen, setArtifactSearchOpen] = useState(false);
  const artifactFilterRef = useRef<HTMLDivElement>(null);
  const artifactSearchInputRef = useRef<HTMLInputElement>(null);
  const activeAssetManagementViewRef = useRef<string | null>(null);

  useEffect(() => {
    const previousView = activeAssetManagementViewRef.current;
    activeAssetManagementViewRef.current = activeAssetManagementView;
    if (shouldSyncAssetSidebarToAssets(previousView, activeAssetManagementView)) {
      onSidebarContentTabChange("assets");
    }
  }, [activeAssetManagementView, onSidebarContentTabChange]);

  useEffect(() => {
    setArtifactExpandedFolders(new Set());
    setWorkflowFileExpandedFolders(new Set());
    setWorkflowFileExpansionSeed(null);
    setWorkflowFilesTab("artifacts");
  }, [workflowId]);

  useEffect(() => {
    if (!artifactFilterOpen) return;

    const closeOnPointerDown = (event: PointerEvent) => {
      if (!artifactFilterRef.current?.contains(event.target as Node)) {
        setArtifactFilterOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setArtifactFilterOpen(false);
    };

    document.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [artifactFilterOpen]);

  useEffect(() => {
    if (!artifactSearchOpen) return;
    artifactSearchInputRef.current?.focus();
  }, [artifactSearchOpen]);

  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.id === workflowId) ?? null,
    [workflowId, workflows],
  );
  const workflowStatusTarget = useMemo(
    () => workflows.find((workflow) => workflow.id === workflowStatusId) ?? null,
    [workflowStatusId, workflows],
  );
  const workflowDeleteTarget = useMemo(
    () => workflows.find((workflow) => workflow.id === workflowDeleteId) ?? null,
    [workflowDeleteId, workflows],
  );
  const selectedWorkflowAssets = useMemo(
    () => workflowAssets(selectedWorkflow),
    [selectedWorkflow],
  );
  const selectedWorkflowFiles = useMemo(
    () => workflowFiles(selectedWorkflow),
    [selectedWorkflow],
  );
  useEffect(() => {
    if (workflowFilesTab !== "files" || !selectedWorkflow) return;

    const nextSeed = selectedWorkflowFiles.map((asset) => asset.path).join("\u0000");
    if (workflowFileExpansionSeed === nextSeed) return;

    setWorkflowFileExpandedFolders(collectAssetFolderPaths(selectedWorkflowFiles));
    setWorkflowFileExpansionSeed(nextSeed);
  }, [
    selectedWorkflow,
    selectedWorkflowFiles,
    workflowFileExpansionSeed,
    workflowFilesTab,
  ]);

  const searchActive = assetSearch.trim().length > 0;
  const artifactFilterActive = searchActive || assetKindFilter !== "all";
  const visibleAssets = useMemo(() => {
    const query = assetSearch.trim().toLowerCase();
    return selectedWorkflowAssets.filter((asset) => {
      const matchesKind = assetKindFilter === "all" || asset.kind === assetKindFilter;
      const matchesQuery = !query || `${asset.name} ${asset.display_path ?? asset.path}`.toLowerCase().includes(query);
      return matchesKind && matchesQuery;
    });
  }, [assetKindFilter, assetSearch, selectedWorkflowAssets]);
  const visibleWorkflowFiles = useMemo(() => {
    const query = assetSearch.trim().toLowerCase();
    return selectedWorkflowFiles.filter((asset) => {
      const matchesKind = assetKindFilter === "all" || asset.kind === assetKindFilter;
      const matchesQuery = !query || `${asset.name} ${asset.display_path ?? asset.path}`.toLowerCase().includes(query);
      return matchesKind && matchesQuery;
    });
  }, [assetKindFilter, assetSearch, selectedWorkflowFiles]);

  function toggleFolder(path: string) {
    if (artifactFilterActive) return;
    const setExpandedFolders = workflowFilesTab === "files"
      ? setWorkflowFileExpandedFolders
      : setArtifactExpandedFolders;

    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleArtifactSearch() {
    if (artifactSearchOpen) onAssetSearchChange("");
    setArtifactSearchOpen((open) => !open);
  }

  function selectAssetKindFilter(value: AssetKindFilter) {
    setAssetKindFilter(value);
    setArtifactFilterOpen(false);
  }

  async function handleDeleteWorkflow() {
    if (!workflowDeleteId) return;

    try {
      setWorkflowDeleteBusy(true);
      await onDeleteWorkflow(workflowDeleteId);
      toast.success(ts("已删除 {id}", { id: workflowDeleteId }));
      setWorkflowDeleteId(null);
      setWorkflowStatusId(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : ts("删除任务失败"));
    } finally {
      setWorkflowDeleteBusy(false);
    }
  }

  return (
    <aside className="relative flex h-full min-h-0 min-w-0 flex-col border-b bg-card/70 lg:border-b-0 lg:border-r">
      <div
        aria-hidden={showLeftPaseoOverlay(sidebarTab, paseoInRightSidebar)}
        className="flex min-h-0 flex-1 flex-col p-3"
        inert={showLeftPaseoOverlay(sidebarTab, paseoInRightSidebar)}
      >
        <div className="mb-3 flex items-center gap-2">
          <div
            className="flex min-w-0 flex-1 items-center gap-4 border-b px-1 pb-2"
            role="tablist"
            aria-label={ts("左侧导航")}
          >
            <button
              aria-selected={sidebarContentTab === "workflows"}
              className={`relative h-8 whitespace-nowrap px-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${sidebarContentTab === "workflows" ? "text-foreground" : "text-muted-foreground hover:text-foreground"} ${sidebarContentTab === "workflows" ? "after:absolute after:inset-x-0 after:-bottom-[9px] after:h-0.5 after:rounded-full after:bg-foreground" : ""}`}
              onClick={() => onSidebarContentTabChange("workflows")}
              role="tab"
              type="button"
            >
              {ts("任务")}
            </button>
            <button
              aria-selected={sidebarContentTab === "assets"}
              className={`relative h-8 whitespace-nowrap px-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${sidebarContentTab === "assets" ? "text-foreground" : "text-muted-foreground hover:text-foreground"} ${sidebarContentTab === "assets" ? "after:absolute after:inset-x-0 after:-bottom-[9px] after:h-0.5 after:rounded-full after:bg-foreground" : ""}`}
              onClick={() => onSidebarContentTabChange("assets")}
              role="tab"
              type="button"
            >
              {ts("工作流")}
            </button>
            {!paseoInRightSidebar ? (
              <button
                aria-selected={paseoOpen}
                className={`relative h-8 whitespace-nowrap px-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${paseoOpen ? "text-foreground" : "text-muted-foreground hover:text-foreground"} ${paseoOpen ? "after:absolute after:inset-x-0 after:-bottom-[9px] after:h-0.5 after:rounded-full after:bg-foreground" : ""}`}
                onClick={() => onSidebarTabChange("paseo")}
                role="tab"
                type="button"
              >
                Paseo
              </button>
            ) : (
              <button
                aria-label={paseoOpen ? ts("收起 Paseo 侧栏") : ts("打开 Paseo 侧栏")}
                aria-pressed={paseoOpen}
                className={`h-8 whitespace-nowrap px-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${paseoOpen ? "text-muted-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => {
                  if (paseoOpen) onPaseoRightSidebarClose();
                  else onPaseoRightSidebarToggle();
                }}
                type="button"
              >
                {paseoOpen ? ts("Paseo（右侧已开）") : ts("Paseo")}
              </button>
            )}
          </div>
        </div>
        {sidebarContentTab === "assets" ? (
          <div className="min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
            {assetNavigation.searchEnabled ? (
              <div className="relative mb-3">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  aria-label={ts("搜索产品库")}
                  className="pl-9"
                  name="asset-library-search"
                  onChange={(event) => onAssetLibrarySearchChange(event.target.value)}
                  placeholder={ts("搜索 SKU、产品或分类…")}
                  type="search"
                  value={assetLibrarySearch}
                />
              </div>
            ) : null}
            <AssetManagementNavigation
              activeView={activeAssetManagementView}
              onOpen={onAssetManagementOpen}
              workspaceType={workspaceType}
            />
          </div>
        ) : null}
        {sidebarContentTab === "workflows" ? (
          <ResizablePanelGroup
            className="min-h-0 flex-1"
            defaultLayout={workflowSidebarLayoutMemory.defaultLayout}
            id={workflowSidebarLayoutGroupId}
            key={workspaceShellLayoutMountKey(workspace, "workflow-sidebar", workflowSidebarPanelIds)}
            onLayoutChanged={workflowSidebarLayoutMemory.onLayoutChanged}
            orientation="vertical"
            resizeTargetMinimumSize={{ coarse: 24, fine: 8 }}
          >
            <ResizablePanel defaultSize={180} id="workflow-list" minSize={112}>
              <section
                aria-label={ts("任务列表")}
                className="flex h-full min-h-0 flex-col"
              >
                <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                  {loading ? <p className="px-1.5 py-2 text-sm text-muted-foreground">{ts("正在加载任务…")}</p> : null}
                  {error ? <p className="px-1.5 py-2 text-sm text-destructive">{error}</p> : null}
                  {!loading && !error && workflows.length === 0 ? (
                    <p className="px-1.5 py-2 text-sm text-muted-foreground">{ts("当前工作区没有任务。")}</p>
                  ) : null}
                  {!loading && !error ? workflows.map((workflow) => {
                    const selected = workflow.id === workflowId;
                    return (
                      <div className="flex items-center gap-1" key={workflow.id}>
                        <Button
                          aria-label={ts("查看状态")}
                          className="size-8 shrink-0 rounded-md p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
                          onClick={() => setWorkflowStatusId(workflow.id)}
                          size="icon"
                          title={ts("查看状态")}
                          type="button"
                          variant="ghost"
                        >
                          <Info className="size-3.5" aria-hidden="true" />
                        </Button>
                        <Button
                          aria-label={ts("查看流程图")}
                          className="size-8 shrink-0 rounded-md p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
                          onClick={() => onWorkflowGraphOpen(workflow)}
                          size="icon"
                          title={ts("查看流程图")}
                          type="button"
                          variant="ghost"
                        >
                          <Eye className="size-3.5" aria-hidden="true" />
                        </Button>
                        <button
                          aria-current={selected ? "page" : undefined}
                          aria-pressed={selected}
                          className={`flex h-9 min-w-0 flex-1 items-center rounded-md px-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
                          onClick={() => onWorkflowChange(workflow.id)}
                          type="button"
                        >
                          <span className="truncate">{workflow.title}</span>
                        </button>
                      </div>
                    );
                  }) : null}
                </div>
              </section>
            </ResizablePanel>

            <ResizableHandle
              className="my-2 h-px w-full [&>div>svg]:rotate-90"
              withHandle
            />

            <ResizablePanel className="min-h-0" id="workflow-artifacts" minSize={144}>
              <section
                aria-labelledby="workflow-artifacts-heading"
                className="flex h-full min-h-0 flex-col pt-1"
              >
                <div className="flex items-center gap-2 border-b px-1.5 pb-2">
                  <div className="min-w-0 flex-1">
                    <h2 className="sr-only" id="workflow-artifacts-heading">{ts("任务文件")}</h2>
                    <div
                      className="flex min-w-0 items-center gap-4 px-1"
                      role="tablist"
                      aria-label={ts("任务文件")}
                    >
                      <button
                        aria-selected={workflowFilesTab === "artifacts"}
                        className={`relative h-8 whitespace-nowrap px-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${workflowFilesTab === "artifacts" ? "text-foreground" : "text-muted-foreground hover:text-foreground"} ${workflowFilesTab === "artifacts" ? "after:absolute after:inset-x-0 after:-bottom-[9px] after:h-0.5 after:rounded-full after:bg-foreground" : ""}`}
                        onClick={() => setWorkflowFilesTab("artifacts")}
                        role="tab"
                        type="button"
                      >
                        {ts("产物")}
                      </button>
                      <button
                        aria-selected={workflowFilesTab === "files"}
                        className={`relative h-8 whitespace-nowrap px-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${workflowFilesTab === "files" ? "text-foreground" : "text-muted-foreground hover:text-foreground"} ${workflowFilesTab === "files" ? "after:absolute after:inset-x-0 after:-bottom-[9px] after:h-0.5 after:rounded-full after:bg-foreground" : ""}`}
                        onClick={() => setWorkflowFilesTab("files")}
                        role="tab"
                        type="button"
                      >
                        {ts("文件")}
                      </button>
                    </div>
                  </div>
                  <div className="ml-auto flex min-w-0 items-center justify-end gap-1">
                    <div
                      aria-hidden={!artifactSearchOpen}
                      className={`relative overflow-hidden transition-[width,opacity] duration-200 ${artifactSearchOpen ? "w-40 opacity-100" : "w-0 opacity-0"}`}
                    >
                      <Input
                        aria-label={ts("搜索当前任务文件")}
                        className="h-8 w-40 rounded-md px-2 text-xs shadow-none"
                        name="asset-search"
                        onChange={(event) => onAssetSearchChange(event.target.value)}
                        placeholder={ts("搜索文件...")}
                        ref={artifactSearchInputRef}
                        tabIndex={artifactSearchOpen ? 0 : -1}
                        type="search"
                        value={assetSearch}
                      />
                    </div>
                    <Button
                      aria-label={ts("搜索文件")}
                      aria-pressed={artifactSearchOpen}
                      className={`size-8 rounded-md p-0 ${artifactSearchOpen ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
                      onClick={toggleArtifactSearch}
                      size="icon"
                      title={ts("搜索文件")}
                      type="button"
                      variant="ghost"
                    >
                      {artifactSearchOpen ? <X className="size-4" aria-hidden="true" /> : <Search className="size-4" aria-hidden="true" />}
                    </Button>
                    <div className="relative" ref={artifactFilterRef}>
                      <Button
                        aria-expanded={artifactFilterOpen}
                        aria-haspopup="menu"
                        aria-label={ts("按文件类型筛选")}
                        className={`size-8 rounded-md p-0 ${assetKindFilter === "all" ? "text-muted-foreground hover:bg-accent hover:text-foreground" : "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"}`}
                        onClick={() => setArtifactFilterOpen((open) => !open)}
                        size="icon"
                        title={ts("按文件类型筛选")}
                        type="button"
                        variant="ghost"
                      >
                        <ListFilter className="size-4" aria-hidden="true" />
                      </Button>
                      {artifactFilterOpen ? (
                        <div
                          aria-label={ts("文件类型")}
                          className="absolute right-0 top-full z-50 mt-1 min-w-28 rounded-md border bg-popover p-1 shadow-md"
                          role="menu"
                        >
                          {ASSET_KIND_FILTER_OPTIONS.map((option) => {
                            const selected = option.value === assetKindFilter;
                            return (
                              <button
                                aria-checked={selected}
                                className={`flex h-8 w-full items-center rounded-sm px-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
                                key={option.value}
                                onClick={() => selectAssetKindFilter(option.value)}
                                role="menuitemradio"
                                type="button"
                              >
                                {option.label}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                    <Button
                      aria-label={ts("刷新任务文件")}
                      className="size-8 rounded-md p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
                      onClick={onRefresh}
                      size="icon"
                      title={ts("刷新文件")}
                      type="button"
                      variant="ghost"
                    >
                      <RefreshCw className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                <div className="mt-2 min-h-0 flex-1">
                  {!loading && !error && !selectedWorkflow ? (
                    <p className="px-1.5 py-2 text-sm text-muted-foreground">{ts("选择一个任务以浏览文件。")}</p>
                  ) : null}
                  {!loading && !error && selectedWorkflow ? (
                    <div className="mt-1 min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                      {workflowFilesTab === "artifacts" ? (
                        visibleAssets.length === 0 ? (
                          <p className="px-1.5 py-2 text-sm text-muted-foreground">
                            {artifactFilterActive ? ts("没有匹配的文件。") : ts("此任务尚未生成文件。")}
                          </p>
                        ) : (
                          <ArtifactFileExplorer
                            ariaLabel={ts("产物文件")}
                            assets={visibleAssets}
                            expandedFolders={artifactExpandedFolders}
                            filterActive={artifactFilterActive}
                            onAssetOpen={onAssetOpen}
                            onFolderToggle={toggleFolder}
                          />
                        )
                      ) : visibleWorkflowFiles.length === 0 ? (
                        <p className="px-1.5 py-2 text-sm text-muted-foreground">
                          {artifactFilterActive ? ts("没有匹配的文件。") : ts("此任务尚未生成文件。")}
                        </p>
                      ) : (
                        <ArtifactFileExplorer
                          ariaLabel={ts("全部文件")}
                          assets={visibleWorkflowFiles}
                          expandedFolders={workflowFileExpandedFolders}
                          filterActive={artifactFilterActive}
                          onAssetOpen={onAssetOpen}
                          onFolderToggle={toggleFolder}
                        />
                      )}
                    </div>
                  ) : null}
                </div>
              </section>
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : null}
      </div>
      {showLeftPaseoOverlay(sidebarTab, paseoInRightSidebar) ? (
        <div className="absolute inset-0 z-30 flex min-h-0 min-w-0 flex-col bg-card/95 backdrop-blur-sm">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
            <p className="text-sm font-medium">Paseo</p>
            <Button
              aria-label={ts("收起 Paseo 侧栏")}
              className="ml-auto size-8 rounded-md p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => onSidebarContentTabChange(sidebarContentTab)}
              size="icon"
              title={ts("收起 Paseo 侧栏")}
              type="button"
              variant="ghost"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {paseoPanel}
          </div>
        </div>
      ) : null}
      <Dialog
        open={Boolean(workflowStatusTarget)}
        onOpenChange={(open) => {
          if (!open) setWorkflowStatusId(null);
        }}
      >
        <DialogContent className="max-w-3xl">
          {workflowStatusTarget ? (
            <>
              <DialogHeader>
                <DialogTitle>{workflowStatusTarget.title}</DialogTitle>
                <DialogDescription>{workflowStatusTarget.id}</DialogDescription>
              </DialogHeader>
              <WorkflowStatusPanel workflow={workflowStatusTarget} />
              <div className="flex justify-end border-t pt-4">
                <Button
                  onClick={() => {
                    setWorkflowDeleteId(workflowStatusTarget.id);
                    setWorkflowStatusId(null);
                  }}
                  type="button"
                  variant="destructive"
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  {ts("删除任务")}
                </Button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={workflowDeleteId !== null}
        onOpenChange={(open) => {
          if (!open && !workflowDeleteBusy) setWorkflowDeleteId(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{ts("删除任务")}</DialogTitle>
            <DialogDescription>
              {ts("删除「{title}」会同时删除其配置和 workflows/{workflowId}/ 运行目录，且不可恢复。", {
                title: workflowDeleteTarget?.title ?? workflowDeleteId ?? "",
                workflowId: workflowDeleteId ?? "",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              disabled={workflowDeleteBusy}
              onClick={() => setWorkflowDeleteId(null)}
              type="button"
              variant="outline"
            >
              {ts("取消")}
            </Button>
            <Button
              disabled={workflowDeleteBusy}
              onClick={() => void handleDeleteWorkflow()}
              type="button"
              variant="destructive"
            >
              {workflowDeleteBusy ? ts("删除中…") : ts("确认删除")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </aside>
  );
});

function PaseoRightSidebar({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col border-l bg-card/70">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <p className="text-sm font-medium">Paseo</p>
        <Button
          aria-label="收起 Paseo 侧栏"
          className="ml-auto size-8 rounded-md p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onClose}
          size="icon"
          title="收起 Paseo 侧栏"
          type="button"
          variant="ghost"
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {children}
      </div>
    </aside>
  );
}

function PaseoPanel({
  context,
  onAgentCreated,
  workflow,
}: {
  context: PaseoEmbedContext | null;
  onAgentCreated: (workflowId: string, agentId: string) => Promise<WorkspaceWorkflow>;
  workflow: WorkspaceWorkflow | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const embedRef = useRef<PaseoEmbedHandle | null>(null);
  const latestContextRef = useRef<PaseoEmbedContext | null>(context);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    latestContextRef.current = context;
    if (!context || !embedRef.current) return;
    try {
      embedRef.current.setContext(context);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [context]);

  const workflowId = workflow?.id ?? null;
  const workspacePath = workflow?.paseo_workspace_path ?? null;
  const agentId = workflow?.paseo?.agent_id ?? null;
  const workflowTitle = workflow?.title ?? "";

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !workflowId || !workspacePath || !PASEO_WEB_URL || !PASEO_DAEMON_ENDPOINT) {
      return;
    }

    let disposed = false;
    let embed: PaseoEmbedHandle | null = null;
    setError(null);

    try {
      embed = createPaseoEmbed({
        agentId: agentId ?? undefined,
        className: "h-full w-full border-0",
        container,
        endpoint: PASEO_DAEMON_ENDPOINT,
        onError: (nextError) => {
          if (!disposed) setError(nextError.message);
        },
        onReady: () => {
          if (disposed || !embed) return;
          if (latestContextRef.current) {
            try {
              embed.setContext(latestContextRef.current);
            } catch (nextError) {
              setError(nextError instanceof Error ? nextError.message : String(nextError));
            }
          }
          if (agentId) return;

          void embed.createWorkspace({
            defaultModel: PASEO_DEFAULT_MODEL,
            path: workspacePath,
            title: workflowTitle,
          }).then(async ({ agentId: createdAgentId }) => {
            if (disposed) return;
            await onAgentCreated(workflowId, createdAgentId);
          }).catch((nextError: unknown) => {
            if (!disposed) {
              setError(nextError instanceof Error ? nextError.message : String(nextError));
            }
          });
        },
        paseoUrl: PASEO_WEB_URL,
        title: `${workflowTitle} Paseo companion`,
      });
      embedRef.current = embed;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }

    return () => {
      disposed = true;
      if (embedRef.current === embed) embedRef.current = null;
      embed?.destroy();
    };
  }, [agentId, onAgentCreated, workflowId, workflowTitle, workspacePath]);

  if (!workflow) {
    return (
      <div className="flex h-full items-center justify-center px-5 text-center text-sm text-muted-foreground">
        从执行链路打开一个工作流的 Paseo 会话。
      </div>
    );
  }

  if (!PASEO_WEB_URL || !PASEO_DAEMON_ENDPOINT) {
    return (
      <div className="flex h-full items-center justify-center px-5 text-center text-sm text-muted-foreground">
        配置 `NEXT_PUBLIC_PASEO_WEB_URL` 和
        {" "}
        `NEXT_PUBLIC_PASEO_DAEMON_ENDPOINT` 后可打开 Paseo。
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0">
      <div
        className="h-full min-h-0 [&>iframe]:h-full [&>iframe]:w-full [&>iframe]:border-0"
        ref={containerRef}
      />
      {error ? (
        <p className="absolute inset-x-3 bottom-3 rounded-md border border-destructive/30 bg-background/95 px-3 py-2 text-xs text-destructive shadow-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function workflowAssets(workflow: WorkspaceWorkflow | null): Asset[] {
  if (!workflow) return [];

  const assetsByPath = new Map<string, Asset>();
  for (const stage of workflow.stages) {
    for (const asset of [...stage.inputs, ...stage.outputs]) {
      assetsByPath.set(asset.path, {
        ...asset,
        display_path: workflowDisplayPath(workflow.id, asset.path),
      });
    }
  }
  return [...assetsByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function workflowFiles(workflow: WorkspaceWorkflow | null): Asset[] {
  if (!workflow) return [];

  const filesByPath = new Map<string, Asset>();
  for (const asset of workflow.files ?? []) {
    filesByPath.set(asset.path, {
      ...asset,
      display_path: workflowDisplayPath(workflow.id, asset.path),
    });
  }
  return [...filesByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function collectAssetFolderPaths(assets: Asset[]): Set<string> {
  const folders = new Set<string>();

  for (const asset of assets) {
    const parts = (asset.display_path ?? asset.path).split("/").filter(Boolean);
    for (let index = 0; index < parts.length - 1; index += 1) {
      folders.add(parts.slice(0, index + 1).join("/"));
    }
  }

  return folders;
}

function buildAssetTree(assets: Asset[]): AssetTreeNode[] {
  const root = new Map<string, AssetTreeNode>();

  for (const asset of assets) {
    let children = root;
    const parts = (asset.display_path ?? asset.path).split("/").filter(Boolean);
    for (const [index, name] of parts.entries()) {
      const path = parts.slice(0, index + 1).join("/");
      let node = children.get(name);
      if (!node) {
        node = { children: new Map(), name, path };
        children.set(name, node);
      }
      if (index === parts.length - 1) node.asset = asset;
      children = node.children;
    }
  }

  return sortAssetTreeNodes(root.values());
}

function sortAssetTreeNodes(nodes: Iterable<AssetTreeNode>): AssetTreeNode[] {
  return [...nodes].sort((left, right) => {
    const leftIsFolder = left.children.size > 0;
    const rightIsFolder = right.children.size > 0;
    if (leftIsFolder !== rightIsFolder) return leftIsFolder ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function ArtifactFileExplorer({
  assets,
  ariaLabel = "任务文件",
  expandedFolders,
  onAssetOpen,
  onFolderToggle,
  filterActive,
}: {
  assets: Asset[];
  ariaLabel?: string;
  expandedFolders: Set<string>;
  onAssetOpen: (asset: Asset) => void;
  onFolderToggle: (path: string) => void;
  filterActive: boolean;
}) {
  const nodes = useMemo(() => buildAssetTree(assets), [assets]);

  return (
    <ul aria-label={ariaLabel} className="space-y-0.5">
      {nodes.map((node) => (
        <ArtifactTreeItem
          expandedFolders={expandedFolders}
          filterActive={filterActive}
          key={node.path}
          node={node}
          onAssetOpen={onAssetOpen}
          onFolderToggle={onFolderToggle}
        />
      ))}
    </ul>
  );
}

function ArtifactTreeItem({
  expandedFolders,
  filterActive,
  node,
  onAssetOpen,
  onFolderToggle,
}: {
  expandedFolders: Set<string>;
  filterActive: boolean;
  node: AssetTreeNode;
  onAssetOpen: (asset: Asset) => void;
  onFolderToggle: (path: string) => void;
}) {
  const isFolder = node.children.size > 0;
  const expanded = isFolder && (filterActive || expandedFolders.has(node.path));

  if (isFolder) {
    return (
      <li>
        <button
          aria-expanded={expanded}
          className="flex w-full items-center gap-1 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onFolderToggle(node.path)}
          type="button"
        >
          {expanded ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
          <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
        </button>
        {expanded ? (
          <ul className="ml-3 space-y-0.5 border-l pl-2">
            {sortAssetTreeNodes(node.children.values()).map((child) => (
              <ArtifactTreeItem
                expandedFolders={expandedFolders}
                filterActive={filterActive}
                key={child.path}
                node={child}
                onAssetOpen={onAssetOpen}
                onFolderToggle={onFolderToggle}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  if (!node.asset) return null;
  const Icon = assetIcon(node.asset.kind);
  return (
    <li>
      <button
        className="group flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onAssetOpen(node.asset!)}
        style={{ containIntrinsicSize: "auto 3.5rem", contentVisibility: "auto" }}
        type="button"
      >
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm">{node.name}</span>
      </button>
    </li>
  );
}

function MainPaneHeader({
  activeAssetManagementView,
  canGoBack,
  createWorkspaceDialogOpen,
  createWorkspaceForm,
  createWorkspaceSubmitting,
  homeWorkflowScenario,
  homeWorkflowSummary,
  homeWorkflowTitle,
  mainPaneMode,
  leftSidebarOpen,
  nextWorkspace,
  onCreateWorkspace,
  onCreateWorkspaceDialogOpenChange,
  onCreateWorkspaceFormChange,
  onGoBack,
  onOpenHome,
  onOpenSettings,
  onToggleLeftSidebar,
  onWorkspaceDialogOpenChange,
  onWorkspaceSelectionChange,
  onWorkspaceSwitch,
  workspace,
  workspaceDialogOpen,
  workspaceType,
  workspaces,
}: {
  activeAssetManagementView: AssetManagementView | null;
  canGoBack: boolean;
  createWorkspaceDialogOpen: boolean;
  createWorkspaceForm: CreateWorkspaceForm;
  createWorkspaceSubmitting: boolean;
  homeWorkflowScenario: string | null;
  homeWorkflowSummary: string | null;
  homeWorkflowTitle: string | null;
  mainPaneMode: MainPaneMode;
  leftSidebarOpen: boolean;
  nextWorkspace: string;
  onCreateWorkspace: () => Promise<void> | void;
  onCreateWorkspaceDialogOpenChange: (open: boolean) => void;
  onCreateWorkspaceFormChange: (value: CreateWorkspaceForm | ((current: CreateWorkspaceForm) => CreateWorkspaceForm)) => void;
  onGoBack: () => void;
  onOpenHome: () => void;
  onOpenSettings: () => void;
  onToggleLeftSidebar: () => void;
  onWorkspaceDialogOpenChange: (open: boolean) => void;
  onWorkspaceSelectionChange: (value: string) => void;
  onWorkspaceSwitch: () => void;
  workspace: string;
  workspaceDialogOpen: boolean;
  workspaceType: WorkspaceType | null;
  workspaces: WorkspaceSummary[];
}) {
  const { locale, setLocale, t, ts } = useI18n();
  const toggleLabel = leftSidebarOpen
    ? t("workspaceShell.header.collapseSidebar", undefined, "收起左侧边栏")
    : t("workspaceShell.header.expandSidebar", undefined, "展开左侧边栏");
  const ToggleIcon = leftSidebarOpen ? PanelLeftClose : PanelLeftOpen;
  const createWorkspaceLabel = ts("新建工作区");
  const assetManagementHeader = activeAssetManagementView
    ? assetManagementHeaderForView(activeAssetManagementView)
    : null;
  const headerTitle = mainPaneMode === "home"
    ? (homeWorkflowTitle ?? t("workspaceShell.header.overview", undefined, "总览"))
    : mainPaneMode === "settings"
      ? t("workspaceShell.header.settings", undefined, "设置")
      : assetManagementHeader?.title
        ? assetManagementHeader.title
      : workspace;
  const headerLabel = mainPaneMode === "home"
    ? (workspace || t("workspaceShell.header.home", undefined, "主页"))
    : mainPaneMode === "settings"
      ? t("workspaceShell.header.settingsPage", undefined, "设置页")
      : assetManagementHeader?.label
        ? assetManagementHeader.label
      : t("workspaceShell.header.assetWorkspace", undefined, "资产工作区");
  const showHeaderLabel = !(mainPaneMode === "home" && homeWorkflowTitle) && headerLabel !== headerTitle;

  return (
    <header className="flex min-h-14 shrink-0 items-center gap-3 border-b bg-card px-3 py-2 md:px-4">
      <Button
        aria-label={toggleLabel}
        onClick={onToggleLeftSidebar}
        size="icon"
        title={toggleLabel}
        type="button"
        variant="ghost"
      >
        <ToggleIcon className="size-4" aria-hidden="true" />
      </Button>
      <div className="min-w-0">
        {showHeaderLabel ? (
          <p className="text-[11px] font-medium leading-4 text-muted-foreground">{headerLabel}</p>
        ) : null}
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-base font-semibold leading-6">{headerTitle}</p>
            {mainPaneMode === "home" && homeWorkflowScenario ? (
              <span className="truncate text-sm leading-5 text-muted-foreground">
                {homeWorkflowScenario}
              </span>
            ) : null}
            {mainPaneMode === "workspace" && workspaceType ? (
              <Badge className="shrink-0" variant="secondary">{workspaceType}</Badge>
            ) : null}
          </div>
          {mainPaneMode === "home" && homeWorkflowSummary ? (
            <p className="truncate text-sm leading-5 text-muted-foreground">
              {homeWorkflowSummary}
            </p>
          ) : null}
        </div>
      </div>
      <div className="ml-auto flex items-center gap-1">
        <Button
          aria-label={t("language.switchTo", undefined, "切换语言")}
          onClick={() => setLocale(locale === "zh-CN" ? "en-US" : "zh-CN")}
          size="sm"
          title={t("language.switchTo", undefined, "切换语言")}
          type="button"
          variant="ghost"
        >
          <Globe2 className="size-4" aria-hidden="true" />
          <span className="ml-1">{locale === "zh-CN" ? "EN" : "ZH"}</span>
        </Button>
        <Button
          aria-label={t("workspaceShell.header.openHome", undefined, "打开主页")}
          onClick={onOpenHome}
          size="icon"
          title={t("workspaceShell.header.home", undefined, "主页")}
          type="button"
          variant="ghost"
        >
          <House className="size-4" aria-hidden="true" />
        </Button>
        <Button
          aria-label={t("workspaceShell.header.openSettings", undefined, "打开设置")}
          onClick={onOpenSettings}
          size="icon"
          title={t("workspaceShell.header.settings", undefined, "设置")}
          type="button"
          variant="ghost"
        >
          <Settings className="size-4" aria-hidden="true" />
        </Button>
        <Dialog open={createWorkspaceDialogOpen} onOpenChange={onCreateWorkspaceDialogOpenChange}>
          <Button
            aria-label={createWorkspaceLabel}
            onClick={() => onCreateWorkspaceDialogOpenChange(true)}
            size="icon"
            title={createWorkspaceLabel}
            type="button"
            variant="ghost"
          >
            <FolderPlus className="size-4" aria-hidden="true" />
          </Button>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{createWorkspaceLabel}</DialogTitle>
              <DialogDescription>{ts("创建一个新的 workspace，并显式选择它的类型。")}</DialogDescription>
            </DialogHeader>
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void onCreateWorkspace();
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="create-workspace-id">{ts("workspace id")}</FieldLabel>
                  <Input
                    autoCapitalize="none"
                    autoCorrect="off"
                    id="create-workspace-id"
                    onChange={(event) => onCreateWorkspaceFormChange((current) => ({
                      ...current,
                      workspaceId: event.target.value,
                    }))}
                    placeholder={ts("例如 rust-for-linux")}
                    spellCheck={false}
                    value={createWorkspaceForm.workspaceId}
                  />
                  <FieldDescription>
                    {ts("只能用小写字母、数字和连字符，且必须以字母开头。")}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>{ts("workspace 类型")}</FieldLabel>
                  <Select
                    value={createWorkspaceForm.workspaceType}
                    onValueChange={(value) => onCreateWorkspaceFormChange((current) => ({
                      ...current,
                      workspaceType: value as WorkspaceCreateType,
                    }))}
                  >
                    <SelectTrigger
                      aria-label={ts("选择 workspace 类型")}
                      className="w-full"
                    >
                      <SelectValue placeholder={ts("请选择 workspace 类型")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="research">{ts("research")}</SelectItem>
                      <SelectItem value="ecommerce">{ts("ecommerce")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    {ts("这里不设默认值，必须手动选择。")}
                  </FieldDescription>
                </Field>
              </FieldGroup>
              <div className="flex justify-end gap-2">
                <Button
                  disabled={createWorkspaceSubmitting}
                  onClick={() => onCreateWorkspaceDialogOpenChange(false)}
                  type="button"
                  variant="outline"
                >
                  {t("common.cancel", undefined, "取消")}
                </Button>
                <Button
                  disabled={
                    createWorkspaceSubmitting
                    || !createWorkspaceForm.workspaceId.trim()
                    || !createWorkspaceForm.workspaceType
                  }
                  type="submit"
                >
                  {createWorkspaceSubmitting ? ts("创建中…") : t("common.create", undefined, "创建")}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
        <Dialog open={workspaceDialogOpen} onOpenChange={onWorkspaceDialogOpenChange}>
          <Button
            aria-label={t("common.switchWorkspace", undefined, "切换工作区")}
            disabled={workspaces.length === 0}
            onClick={() => onWorkspaceDialogOpenChange(true)}
            size="icon"
            title={t("common.switchWorkspace", undefined, "切换工作区")}
            type="button"
            variant="ghost"
          >
            <Folder className="size-4" aria-hidden="true" />
          </Button>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t("workspaceShell.header.switchWorkspaceTitle", undefined, "切换工作区")}</DialogTitle>
              <DialogDescription>{t("workspaceShell.header.switchWorkspaceDescription", undefined, "选择要在资产浏览器中打开的工作区。")}</DialogDescription>
            </DialogHeader>
            <Select value={nextWorkspace} onValueChange={onWorkspaceSelectionChange}>
              <SelectTrigger aria-label={t("workspaceShell.header.selectWorkspaceAria", undefined, "选择工作区")} className="w-full">
                <SelectValue placeholder={t("workspaceShell.header.selectWorkspacePlaceholder", undefined, "选择工作区")} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {workspaces.map((item) => (
                    <SelectItem key={item.name} value={item.name}>
                      <div className="flex w-full items-center justify-between gap-3">
                        <span className="truncate">{item.name}</span>
                        <Badge className="shrink-0" variant="secondary">{item.type}</Badge>
                      </div>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <div className="flex justify-end gap-2">
              <Button onClick={() => onWorkspaceDialogOpenChange(false)} type="button" variant="outline">
                {t("common.cancel", undefined, "取消")}
              </Button>
              <Button disabled={!nextWorkspace || nextWorkspace === workspace} onClick={onWorkspaceSwitch} type="button">
                {t("workspaceShell.header.switchWorkspaceAction", undefined, "切换工作区")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
        <Button
          aria-label={t("common.back", undefined, "返回")}
          disabled={!canGoBack}
          onClick={onGoBack}
          size="icon"
          title={t("common.back", undefined, "返回")}
          type="button"
          variant="ghost"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </header>
  );
}

function TabBar({ activeTabId, hidden = false, onClose, onSelect, tabs }: {
  activeTabId: string;
  hidden?: boolean;
  onClose: (id: string) => void;
  onSelect: (id: string) => void;
  tabs: WorkspaceTab[];
}) {
  if (hidden) return null;

  return (
    <div className="flex min-h-14 items-end gap-1 overflow-x-scroll overflow-y-hidden border-b bg-card px-2 pt-2 [scrollbar-gutter:stable]" role="tablist" aria-label="已打开的工作区面板">
      {tabs.map((tab) => {
        const selected = tab.id === activeTabId;
        const Icon = tab.type === "asset"
          ? assetIcon(tab.asset.kind)
          : tab.type === "workflow-graph"
            ? Eye
            : Sparkles;
        return (
          <div className={`flex h-9 max-w-56 items-center rounded-t-md border border-b-0 ${selected ? "bg-background" : "bg-muted/50"}`} key={tab.id}>
            <button
              aria-selected={selected}
              className="flex min-w-0 items-center gap-2 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onSelect(tab.id)}
              role="tab"
              type="button"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{tab.title}</span>
            </button>
            <button
              aria-label={`关闭 ${tab.title}`}
              className="mr-1 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onClose(tab.id)}
              type="button"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function formatWhen(
  value: string | null | undefined,
  locale: string,
): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function pipelineBadgeVariant(
  status: WorkspaceWorkflow["pipeline_status"],
): "default" | "secondary" | "outline" | "destructive" {
  if (status === "current") return "default";
  if (status === "stale") return "destructive";
  if (status === "incomplete") return "secondary";
  return "outline";
}

function stageBadgeVariant(
  status: WorkspaceWorkflowStageStatus,
): "default" | "secondary" | "outline" | "destructive" {
  if (!status.ready) return "secondary";
  if (status.status === "final" || status.status === "ready") return "default";
  if (status.status === "missing") return "destructive";
  return "outline";
}

const WORKFLOW_STAGE_CHAIN_STEP_MAP: Partial<Record<string, Partial<Record<string, string>>>> = {
  "literature-review": {
    "data-collection": "survey",
    "intelligence-analysis": "synthesis",
    "report-writing": "write",
  },
};

const WORKFLOW_STAGE_LABELS: Record<string, string> = {
  "data-collection": "数据采集",
  "intelligence-analysis": "情报分析",
  "report-writing": "报告写作",
};

const LITERATURE_REVIEW_WORKFLOW_SKILL_PATH =
  "workflows/literature-review/skills/polaris-literature-review/SKILL.md";

function workflowStageChainStep(templateId: string | null | undefined, stageId: string): string | null {
  if (!templateId) return null;
  return WORKFLOW_STAGE_CHAIN_STEP_MAP[templateId]?.[stageId] ?? null;
}

function workflowChainStageId(workflowId: string, step: string): string | null {
  const entries = Object.entries(WORKFLOW_STAGE_CHAIN_STEP_MAP[workflowId] ?? {});
  const match = entries.find(([, value]) => value === step);
  return match?.[0] ?? null;
}

function HomeWorkflowStatusPanel({ workflows }: { workflows: WorkspaceWorkflow[] }) {
  const { t } = useI18n();
  const items = workflowOverviewStatusItems(workflows);

  return (
    <section className="rounded-2xl border bg-card px-4 py-3 shadow-sm">
      <div className="grid grid-cols-3 gap-3">
        {items.map((item, index) => {
          const label = item.label === "需要评审"
            ? t("workspaceShell.overview.needsReview", undefined, item.label)
            : item.label === "暂停/运行中"
              ? t("workspaceShell.overview.pausedRunning", undefined, item.label)
              : item.label === "成功/已完成"
                ? t("workspaceShell.overview.successfulCompleted", undefined, item.label)
                : item.label;
          return (
          <div
            className={index === 0 ? "min-w-0" : "min-w-0 border-l pl-4"}
            key={label}
          >
            <p className="text-[11px] font-medium leading-4 text-muted-foreground">{label}</p>
            <p className="mt-2 truncate text-xl font-semibold leading-6">{item.value}</p>
          </div>
        );
        })}
      </div>
    </section>
  );
}

function BrainOverview({
  brainWorkflows,
  onOpenOrderManagement,
  onOpenProductManagement,
  onOpenWorkflow,
  workspaceWorkflows,
  workspaceType,
}: {
  brainWorkflows: PrebuiltWorkflow[];
  onOpenOrderManagement: () => void;
  onOpenProductManagement: () => void;
  onOpenWorkflow: (workflowId: string) => void;
  workspaceWorkflows: WorkspaceWorkflow[];
  workspaceType: WorkspaceType | null;
}) {
  const { t } = useI18n();
  const runningWorkflowIds = useMemo(
    () => new Set(
      workspaceWorkflows
        .filter((item) => workflowRunning(item))
        .map((item) => item.id),
    ),
    [workspaceWorkflows],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-6">
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
        <div className="space-y-6">
          <section className="space-y-6">
            <HomeWorkflowStatusPanel workflows={workspaceWorkflows} />
            {workspaceType === "ecommerce" ? (
              <EcommerceOperationsOverview
                onOpenOrderManagement={onOpenOrderManagement}
                onOpenProductManagement={onOpenProductManagement}
              />
            ) : null}
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {brainWorkflows.map((workflow) => {
                const Icon = workflow.icon;
                const activeInstance = workspaceWorkflows.find((item) => (
                  (item.template_id === workflow.id || item.category === workflow.id)
                  && runningWorkflowIds.has(item.id)
                ));
                return (
                  <button
                    className="rounded-2xl border bg-card p-5 text-left shadow-sm transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    key={workflow.id}
                    onClick={() => onOpenWorkflow(workflow.id)}
                    type="button"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                        <Icon className="size-5" aria-hidden="true" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-base font-semibold leading-6">{workflow.title}</p>
                          {activeInstance ? (
                            <Badge className="shrink-0 font-normal" variant="default">
                              {t("workspaceShell.overview.running", undefined, "running")}
                            </Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm leading-5 text-muted-foreground">{workflow.scenario}</p>
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {workflow.chain.slice(0, 3).map((step) => (
                        <Badge className="font-normal" key={step} variant="secondary">{step}</Badge>
                      ))}
                      {workflow.chain.length > 3 ? <Badge className="font-normal" variant="outline">+{workflow.chain.length - 3}</Badge> : null}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function EcommerceOperationsOverview({
  onOpenOrderManagement,
  onOpenProductManagement,
}: {
  onOpenOrderManagement: () => void;
  onOpenProductManagement: () => void;
}) {
  return (
    <div className="flex flex-wrap items-start gap-4">
        <button
          className="flex w-16 shrink-0 flex-col items-center gap-1.5 rounded-lg py-1 text-center text-[12px] leading-4 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onOpenProductManagement}
          type="button"
        >
          <span className="flex size-8 items-center justify-center rounded-lg bg-[#2f67d8] text-white shadow-sm">
            <Package className="size-4" aria-hidden="true" />
          </span>
          <span className="leading-none">商品管理</span>
        </button>
        <button
          className="flex w-16 shrink-0 flex-col items-center gap-1.5 rounded-lg py-1 text-center text-[12px] leading-4 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onOpenOrderManagement}
          type="button"
        >
          <span className="flex size-8 items-center justify-center rounded-lg bg-[#3aa7a3] text-white shadow-sm">
            <ShoppingCart className="size-4" aria-hidden="true" />
          </span>
          <span className="leading-none">订单管理</span>
        </button>
    </div>
  );
}

function BrainWorkflowPanel({
  onAddPaseoFieldContext,
  onAddPaseoInputContext,
  onAddPaseoWorkflowSkillPathContext,
  onCreateWorkflowInstance,
  onLoadWorkspaceWorkflow,
  onOpenPaseoSession,
  selectedWorkspaceWorkflowId,
  workflow,
  workspace,
  workspaceWorkflows,
}: {
  onAddPaseoFieldContext: (
    workflow: WorkspaceWorkflow,
    stage: WorkspaceWorkflowStage,
    fieldPath: string,
    fieldValue: string,
  ) => void;
  onAddPaseoInputContext: (
    workflow: WorkspaceWorkflow,
    stage: WorkspaceWorkflowStage,
    inputValue: string,
  ) => void;
  onAddPaseoWorkflowSkillPathContext: (workflow: WorkspaceWorkflow) => void;
  onCreateWorkflowInstance: (templateId: string) => Promise<WorkspaceWorkflow>;
  onLoadWorkspaceWorkflow: (workflowId: string) => void;
  onOpenPaseoSession: (workflow: WorkspaceWorkflow) => void;
  selectedWorkspaceWorkflowId: string;
  workflow: PrebuiltWorkflow;
  workspace: string;
  workspaceWorkflows: WorkspaceWorkflow[];
}) {
  const [selectedTaskValue, setSelectedTaskValue] = useState("");
  const [creatingInstance, setCreatingInstance] = useState(false);
  const [openingPaseo, setOpeningPaseo] = useState(false);
  const [expandedChainStep, setExpandedChainStep] = useState<string | null>(null);
  const matchingWorkspaceWorkflows = useMemo(
    () => workspaceWorkflows.filter((item) => item.template_id === workflow.id || item.category === workflow.id),
    [workflow.id, workspaceWorkflows],
  );
  const taskSelectionGroups = useMemo(
    () => buildWorkflowTaskSelectionGroups(
      [{ id: workflow.id, title: workflow.title }],
      matchingWorkspaceWorkflows.map((item) => ({ id: item.id, title: item.title })),
    ),
    [matchingWorkspaceWorkflows, workflow.id, workflow.title],
  );
  const selectedTemplateId = useMemo(
    () => selectedTemplateIdFromValue(selectedTaskValue),
    [selectedTaskValue],
  );
  const selectedExistingWorkflowId = useMemo(
    () => selectedExistingWorkflowIdFromValue(selectedTaskValue),
    [selectedTaskValue],
  );
  const loadedWorkspaceWorkflow = useMemo(
    () => matchingWorkspaceWorkflows.find((item) => item.id === selectedWorkspaceWorkflowId) ?? null,
    [matchingWorkspaceWorkflows, selectedWorkspaceWorkflowId],
  );
  const canCreatePaseoWorkflow = workflow.id === "literature-review"
    && selectedTemplateId === workflow.id;
  const canOpenPaseo = Boolean(loadedWorkspaceWorkflow) || canCreatePaseoWorkflow;
  const literatureStageStatusByChainStep = useMemo(() => {
    if (workflow.id !== "literature-review" || !loadedWorkspaceWorkflow) {
      return new Map<string, WorkspaceWorkflowStage>();
    }
    return new Map(
      loadedWorkspaceWorkflow.stages.flatMap((stage) => {
        const chainStep = workflowStageChainStep(loadedWorkspaceWorkflow.template_id, stage.id);
        return chainStep ? [[chainStep, stage] as const] : [];
      }),
    );
  }, [loadedWorkspaceWorkflow, workflow.id]);

  useEffect(() => {
    if (!selectedWorkspaceWorkflowId) return;
    if (!matchingWorkspaceWorkflows.some((item) => item.id === selectedWorkspaceWorkflowId)) return;
    const nextValue = existingTaskSelectionValue(selectedWorkspaceWorkflowId);
    setSelectedTaskValue((current) => current === nextValue
      ? current
      : nextValue);
  }, [matchingWorkspaceWorkflows, selectedWorkspaceWorkflowId]);

  useEffect(() => {
    const availableValues = taskSelectionGroups.flatMap((group) => group.items.map((item) => item.value));
    if (availableValues.includes(selectedTaskValue)) return;
    setSelectedTaskValue(availableValues[0] ?? "");
  }, [selectedTaskValue, taskSelectionGroups]);

  useEffect(() => {
    if (!expandedChainStep) return;
    if (workflow.id !== "literature-review" || !loadedWorkspaceWorkflow) {
      setExpandedChainStep(null);
      return;
    }
    if (!workflow.chain.includes(expandedChainStep)) {
      setExpandedChainStep(null);
    }
  }, [expandedChainStep, loadedWorkspaceWorkflow, workflow.chain, workflow.id]);

  async function createSelectedInstance() {
    if (!selectedTemplateId) throw new Error("请先选择一个工作流模板");
    const created = await onCreateWorkflowInstance(selectedTemplateId);
    setSelectedTaskValue(existingTaskSelectionValue(created.id));
    onLoadWorkspaceWorkflow(created.id);
    return created;
  }

  async function handleCreateInstance() {
    try {
      setCreatingInstance(true);
      const created = await createSelectedInstance();
      toast.success(`已创建 ${created.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingInstance(false);
    }
  }

  async function handleOpenPaseoSession() {
    try {
      setOpeningPaseo(true);
      const targetWorkflow = loadedWorkspaceWorkflow ?? await createSelectedInstance();
      onOpenPaseoSession(targetWorkflow);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningPaseo(false);
    }
  }

  async function handleAddWorkflowSkillPathContext() {
    try {
      setOpeningPaseo(true);
      const targetWorkflow = loadedWorkspaceWorkflow ?? await createSelectedInstance();
      onAddPaseoWorkflowSkillPathContext(targetWorkflow);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningPaseo(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-6">
      <div className="min-h-0 flex-1 space-y-6">
        {workflow.id === "literature-review" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <p className="text-base font-semibold leading-6">先选模板 / 已有任务</p>
              <Button
                className="ml-auto h-9 rounded-xl px-3 shadow-none"
                disabled={creatingInstance || !selectedTemplateId}
                onClick={() => void handleCreateInstance()}
                type="button"
              >
                {creatingInstance ? "新建中..." : "新建任务"}
              </Button>
            </div>
            <Select
              onValueChange={(value) => {
                setSelectedTaskValue(value);
                const workflowId = selectedExistingWorkflowIdFromValue(value);
                if (workflowId) onLoadWorkspaceWorkflow(workflowId);
              }}
              value={selectedTaskValue}
            >
              <SelectTrigger
                aria-label="选择文献综述模板或已有任务"
                className="h-10 w-full rounded-xl border-border/60 bg-background shadow-none"
              >
                <SelectValue placeholder="选择模板或已有任务" />
              </SelectTrigger>
              <SelectContent>
                {taskSelectionGroups.map((group) => (
                  <SelectGroup key={group.id}>
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      {group.label}
                    </div>
                    {group.items.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <section className="space-y-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-base font-semibold leading-6">执行链路</h3>
            <div className="flex items-center gap-1">
              <Badge
                className="rounded-full border-border/60 bg-muted/50 px-2.5 py-1 text-[12px] font-normal leading-4 text-muted-foreground shadow-none"
                variant="outline"
              >
                {workflow.chain.length} stages
              </Badge>
              <Button
                aria-label={openingPaseo
                  ? "正在打开 Paseo"
                  : loadedWorkspaceWorkflow?.paseo?.agent_id
                    ? "打开 Paseo"
                    : "创建或打开 Paseo 会话"}
                className="size-8 rounded-md p-0 text-muted-foreground shadow-none hover:bg-accent/20 hover:text-foreground"
                disabled={creatingInstance || openingPaseo || !canOpenPaseo}
                onClick={() => void handleOpenPaseoSession()}
                size="sm"
                title={canOpenPaseo ? "在侧栏打开 Paseo 会话" : "请先创建对应的工作流任务"}
                type="button"
                variant="ghost"
              >
                <Bot className="size-4" aria-hidden="true" />
              </Button>
              {workflow.id === "literature-review" ? (
                <Button
                  aria-label="将 workflow-literature-review skill 路径添加到 Paseo"
                  className="size-8 rounded-md p-0 text-muted-foreground shadow-none hover:bg-accent/20 hover:text-foreground"
                  disabled={creatingInstance || openingPaseo || !canOpenPaseo}
                  onClick={() => void handleAddWorkflowSkillPathContext()}
                  size="sm"
                  title="将 workflow-literature-review skill 路径添加到 Paseo"
                  type="button"
                  variant="ghost"
                >
                  <FileText className="size-4" aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          </div>
          <div className="divide-y divide-border/60 border-y border-border/60">
            {workflow.chain.map((step, index) => {
              const mappedStageId = workflow.id === "literature-review"
                ? workflowChainStageId(workflow.id, step)
                : null;
              const mappedStage = workflow.id === "literature-review"
                ? literatureStageStatusByChainStep.get(step) ?? null
                : null;
              const expandable = workflow.id === "literature-review" && !!loadedWorkspaceWorkflow;
              const expanded = expandedChainStep === step;
              const stageStatus = mappedStage
                ? (mappedStage.status.status ?? (mappedStage.status.ready ? "ready" : "missing"))
                : null;
              const visibleEditableFields = mappedStage
                ? mappedStage.editable_fields.filter((field) => (
                  !isPromptDetailPath(field.path)
                  && (!isStepDetailPath(field.path) || isInputArgumentPath(mappedStage.editable_fields, field.path))
                ))
                : [];

              return (
                <div key={step}>
                  {expandable ? (
                    <button
                      className={`flex w-full items-center gap-2 px-2 py-2.5 text-left text-sm leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        expanded ? "bg-muted/40" : "hover:bg-muted/20"
                      }`}
                      onClick={() => setExpandedChainStep(expanded ? null : step)}
                      type="button"
                    >
                      <Badge
                        className="rounded-full border-border/60 bg-background px-2 py-0.5 text-[12px] font-normal leading-4 text-foreground shadow-none"
                        variant="outline"
                      >
                        {step}
                      </Badge>
                      {mappedStageId ? (
                        <span className="truncate text-sm leading-5 text-muted-foreground">
                          {WORKFLOW_STAGE_LABELS[mappedStageId] ?? mappedStageId}
                        </span>
                      ) : null}
                      {stageStatus ? (
                        <span className="ml-auto text-[12px] leading-4 text-muted-foreground">
                          {stageStatus}
                        </span>
                      ) : null}
                      <ChevronRight
                        aria-hidden="true"
                        className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
                      />
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 px-2 py-2.5 text-sm leading-5">
                      <Badge
                        className="rounded-full border-border/60 bg-background px-2 py-0.5 text-[12px] font-normal leading-4 text-foreground shadow-none"
                        variant="outline"
                      >
                        {step}
                      </Badge>
                      {mappedStageId ? (
                        <span className="truncate text-sm leading-5 text-muted-foreground">
                          {WORKFLOW_STAGE_LABELS[mappedStageId] ?? mappedStageId}
                        </span>
                      ) : null}
                      {stageStatus ? (
                        <span className="ml-auto text-[12px] leading-4 text-muted-foreground">
                          {stageStatus}
                        </span>
                      ) : null}
                      {index < workflow.chain.length - 1 ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
                    </div>
                  )}
                  {expandable && expanded ? (
                    <div className="border-l border-border/50 pl-4 pr-2 pb-3 pt-2">
                      {mappedStage && visibleEditableFields.length > 0 ? (
                        <dl className="space-y-1.5">
                          {sortEditableFieldGroupsForDisplay(groupEditableFields(visibleEditableFields)).map((group) => (
                            <div className="space-y-1.5" key={`${step}-${group.root}`}>
                              {editableFieldRows(group).map((row) => {
                                const inputPathValue = row.value !== null && isInputArgumentPath(
                                  mappedStage.editable_fields,
                                  row.key,
                                )
                                  ? row.value
                                  : null;
                                const promptFieldValue = row.value !== null && hasPromptCompanion(
                                  mappedStage.editable_fields,
                                  row.key,
                                )
                                  ? row.value
                                  : null;
                                const promptTooltip = row.value !== null
                                  ? promptCompanionTooltip(mappedStage.editable_fields, row.key)
                                  : null;
                                const fieldAction = inputPathValue && loadedWorkspaceWorkflow ? {
                                  ariaLabel: "将输入路径添加到 Paseo",
                                  onClick: () => onAddPaseoInputContext(
                                    loadedWorkspaceWorkflow,
                                    mappedStage,
                                    inputPathValue,
                                  ),
                                  title: "添加到 Paseo input composer",
                                } : promptFieldValue && loadedWorkspaceWorkflow ? {
                                  ariaLabel: "将字段上下文添加到 Paseo",
                                  onClick: () => onAddPaseoFieldContext(
                                    loadedWorkspaceWorkflow,
                                    mappedStage,
                                    row.key,
                                    promptFieldValue,
                                  ),
                                  title: promptTooltip ?? "将字段上下文添加到 Paseo",
                                } : null;

                                return (
                                  <div
                                    className="grid min-w-0 grid-cols-[13rem_minmax(0,1fr)] items-start gap-x-4 py-1"
                                    key={row.key}
                                  >
                                    <dt
                                      className={row.nested
                                        ? "min-w-0 break-all pl-3 text-sm leading-5 text-muted-foreground"
                                        : "min-w-0 break-all text-sm leading-5 text-muted-foreground"}
                                    >
                                      {row.label}
                                    </dt>
                                    <dd className="flex min-w-0 items-start justify-end gap-1 break-words text-right text-sm leading-5 font-normal text-foreground">
                                      <span>{row.value ?? ""}</span>
                                      {fieldAction ? (
                                        <Button
                                          aria-label={fieldAction.ariaLabel}
                                          className="size-6 shrink-0 rounded-md p-0 text-muted-foreground shadow-none hover:bg-accent/30 hover:text-foreground"
                                          onClick={fieldAction.onClick}
                                          size="icon"
                                          title={fieldAction.title}
                                          type="button"
                                          variant="ghost"
                                        >
                                          <Bot className="size-3.5" aria-hidden="true" />
                                        </Button>
                                      ) : null}
                                    </dd>
                                  </div>
                                );
                              })}
                            </div>
                          ))}
                        </dl>
                      ) : mappedStageId ? (
                        <p className="text-sm leading-5 text-muted-foreground">当前没有可控字段。</p>
                      ) : (
                        <p className="text-sm leading-5 text-muted-foreground">这个 step 还没有映射到当前 workflow stage。</p>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          {workflow.id === "literature-review" && loadedWorkspaceWorkflow ? (
            <div className="space-y-2 pt-1">
              <p className="text-[12px] leading-4 text-muted-foreground">
                当前显示模板与任务合并后的字段；prompt 规格和 step 内部参数默认隐藏。
              </p>
              <a
                className="inline-flex items-center rounded-md text-sm leading-5 text-primary underline-offset-4 hover:underline"
                href={wanghaiPath(`/api/workspaces/${encodeURIComponent(workspace)}/workflows/${encodeURIComponent(loadedWorkspaceWorkflow.id)}/config`)}
                rel="noreferrer"
                target="_blank"
              >
                {`workflows.yaml · workflows.${loadedWorkspaceWorkflow.id}`}
              </a>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function WorkflowStatusPanel({ workflow }: { workflow: WorkspaceWorkflow }) {
  const { locale, ts } = useI18n();

  return (
    <div className="max-h-[70vh] overflow-auto overscroll-contain">
      <section className="rounded-lg border bg-card">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3 md:px-5">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-medium break-all">{workflow.title}</h2>
              <Badge variant={pipelineBadgeVariant(workflow.pipeline_status)}>
                {workflow.pipeline_status}
              </Badge>
            </div>
            <p className="font-mono text-xs text-muted-foreground break-all">{workflow.id}</p>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            {workflow.status_generated_at ? (
              <p>{ts("状态刷新 {time}", { time: formatWhen(workflow.status_generated_at, locale) })}</p>
            ) : null}
            {workflow.last_run ? (
              <p>
                {ts("最近运行 {status}", { status: workflow.last_run.status })}
                {workflow.last_run.finished_at
                  ? ` · ${formatWhen(workflow.last_run.finished_at, locale)}`
                  : workflow.last_run.started_at
                    ? ` · ${formatWhen(workflow.last_run.started_at, locale)}`
                    : ""}
              </p>
            ) : (
              <p>无运行记录</p>
            )}
          </div>
        </header>

        <div className="divide-y">
          {workflow.stages.map((stage) => (
            <div
              className="grid items-start gap-x-4 gap-y-3 p-4 sm:grid-cols-[9rem_minmax(0,1fr)] md:p-5"
              key={stage.id}
            >
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">
                    {workflowStageChainStep(workflow.template_id, stage.id)
                      ? `${workflowStageChainStep(workflow.template_id, stage.id)} · ${stage.label}`
                      : stage.label}
                  </p>
                  <Badge variant={stageBadgeVariant(stage.status)}>
                    {stage.status.status ?? (stage.status.ready ? "ready" : "missing")}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">{formatWhen(stage.status.modified_at, locale)}</p>
              </div>
              <dl className="grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                {stage.status.facts.length === 0 ? (
                  <p className="col-span-2 text-muted-foreground">无阶段产物</p>
                ) : (
                  stage.status.facts.map((fact) => (
                    <div className="contents" key={`${stage.id}-${fact.label}`}>
                      <dt className="text-muted-foreground">{fact.label}</dt>
                      <dd className="min-w-0 break-all font-medium tabular-nums">{fact.value}</dd>
                    </div>
                  ))
                )}
                {stage.status.artifact ? (
                  <div className="contents">
                    <dt className="text-muted-foreground">路径</dt>
                    <dd className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                      {stage.status.artifact}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function settingsStatusVariant(
  status: SettingsCredential["status"],
): "default" | "secondary" | "outline" | "destructive" {
  if (status === "configured") return "default";
  if (status === "partial") return "secondary";
  return "outline";
}

function settingsStatusLabel(status: SettingsCredential["status"]): string {
  if (status === "configured") return "已配置";
  if (status === "partial") return "部分配置";
  return "未配置";
}

function SettingsPanel({
  catalog,
  error,
  loading,
  onRefresh,
}: {
  catalog: SettingsCatalogResponse | null;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const [activeSection, setActiveSection] = useState<"credentials" | "skills" | "tools">("tools");
  const sectionItems = [
    { key: "tools", label: "工具", count: catalog?.tools.length ?? 0 },
    { key: "skills", label: "技能", count: catalog?.skills.length ?? 0 },
    { key: "credentials", label: "凭证", count: catalog?.credentials.length ?? 0 },
  ] as const;

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div
          className="inline-flex items-center gap-1"
          role="tablist"
          aria-label="设置分类"
        >
          {sectionItems.map((item) => {
            const selected = activeSection === item.key;
            return (
              <button
                aria-selected={selected}
                className={`flex h-8 items-center gap-2 rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                key={item.key}
                onClick={() => setActiveSection(item.key)}
                role="tab"
                type="button"
              >
                <span>{item.label}</span>
                <Badge
                  className={selected ? "border-transparent bg-background text-foreground" : "border-transparent bg-muted text-muted-foreground"}
                  variant="outline"
                >
                  {item.count}
                </Badge>
              </button>
            );
          })}
        </div>
        <Button
          aria-label="刷新设置列表"
          onClick={onRefresh}
          size="icon"
          title="刷新列表"
          type="button"
          variant="outline"
        >
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">加载失败：{error}</p> : null}
      {loading && !catalog ? <p className="text-sm text-muted-foreground">正在扫描仓库设置…</p> : null}

      {catalog ? (
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
          {activeSection === "tools" ? (
            <section role="tabpanel">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {catalog.tools.map((tool) => (
                  <article className="rounded-2xl border bg-card p-4 shadow-sm" key={tool.id}>
                    <div className="flex items-start gap-3">
                      <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                        <Wrench className="size-5" aria-hidden="true" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate font-medium">{tool.title}</p>
                          <Badge variant="secondary">{tool.id}</Badge>
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {tool.cli ? `CLI ${tool.cli}` : tool.package_name ?? tool.path}
                        </p>
                      </div>
                    </div>
                    <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">
                      {tool.description}
                    </p>
                    <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {tool.package_name ? <Badge variant="outline">{tool.package_name}</Badge> : null}
                      <span className="truncate font-mono">{tool.path}</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {activeSection === "skills" ? (
            <section role="tabpanel">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {catalog.skills.map((skill) => (
                  <article className="rounded-2xl border bg-card p-4 shadow-sm" key={`${skill.source}:${skill.id}`}>
                    <div className="flex items-start gap-3">
                      <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                        <Sparkles className="size-5" aria-hidden="true" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate font-medium">{skill.title}</p>
                          <Badge variant={skill.source === "repo" ? "default" : "secondary"}>
                            {skill.source === "repo" ? "仓库内置" : "集成"}
                          </Badge>
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground">@{skill.id}</p>
                      </div>
                    </div>
                    <p className="mt-3 line-clamp-3 text-sm text-muted-foreground">
                      {skill.description}
                    </p>
                    <p className="mt-4 truncate font-mono text-xs text-muted-foreground">
                      {skill.path}
                    </p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {activeSection === "credentials" ? (
            <section role="tabpanel">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {catalog.credentials.map((credential) => (
                  <article className="rounded-2xl border bg-card p-4 shadow-sm" key={credential.id}>
                    <div className="flex items-start gap-3">
                      <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                        <Key className="size-5" aria-hidden="true" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate font-medium">{credential.title}</p>
                          <Badge variant={settingsStatusVariant(credential.status)}>
                            {settingsStatusLabel(credential.status)}
                          </Badge>
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {credential.keys[0] ?? credential.id}
                        </p>
                      </div>
                    </div>
                    <p className="mt-3 line-clamp-3 text-sm text-muted-foreground">
                      {credential.description}
                    </p>
                    <div className="mt-4 space-y-2 text-xs text-muted-foreground">
                      <p className="line-clamp-2 font-mono">{credential.keys.join(", ")}</p>
                      <p className="line-clamp-2">{credential.used_by.join(" · ")}</p>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AssetPreview({ asset, workspace }: { asset: Asset; workspace: string }) {
  const source = assetUrl(workspace, asset.path, asset);
  return (
    <div className="h-full min-h-0">
      {isManualReviewList(asset.path) ? <ManualReviewAssetPanel assetPath={asset.path} workspace={workspace} /> : isJsonAsset(asset.path) ? <JsonAssetViewer size={asset.size} source={source} /> : isTextAsset(asset.path) ? <TextAssetViewer size={asset.size} source={source} /> : asset.kind === "image" ? (
        <div className="flex h-full min-h-0 items-center justify-center overflow-auto overscroll-contain bg-muted/30 p-4">
          <img alt={asset.name} className="max-h-full max-w-full object-contain" height={720} loading="eager" src={source} width={1280} />
        </div>
      ) : asset.kind === "pdf" ? (
        <iframe
          className="h-full w-full border-0 bg-card"
          key={`${asset.path}:${asset.modified_at}:${asset.size}`}
          src={source}
          title={asset.name}
        />
      ) : (
        <div className="h-full overflow-auto overscroll-contain p-6">
          <div className="rounded-lg border border-dashed p-6">
          <File className="size-6 text-muted-foreground" aria-hidden="true" />
          <h2 className="mt-4 font-medium">打开源资产</h2>
          <p className="mt-2 text-sm text-muted-foreground">此文件类型会在原生查看器中打开，工作区不会代替专业工具。</p>
          <a className="mt-4 inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={source} rel="noreferrer" target="_blank">在新窗口打开</a>
          </div>
        </div>
      )}
    </div>
  );
}

function AssetManagementPlaceholder() {
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-6">
      <div className="max-w-md rounded-lg border bg-card p-6">
        <Package className="size-6 text-muted-foreground" aria-hidden="true" />
        <h2 className="mt-4 font-medium">产品视频</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          产品库已就绪；此视图将在下一步接入 product-video 工作流。
        </p>
      </div>
    </div>
  );
}

function SubmissionManagementPlaceholder() {
  const { ts } = useI18n();

  return (
    <div className="flex h-full min-h-0 items-center justify-center p-6">
      <div className="max-w-md rounded-lg border bg-card p-6">
        <ScrollText className="size-6 text-muted-foreground" aria-hidden="true" />
        <h2 className="mt-4 font-medium">{ts("投稿管理")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {ts("研究投稿资产已就绪；此视图将在下一步接入投稿工作流。")}
        </p>
      </div>
    </div>
  );
}
